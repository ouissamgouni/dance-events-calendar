"""Per-calendar streaming fetch worker.

Each enabled calendar gets one CalendarSyncWorker running in its own thread.
It fetches events from the calendar service (handling 410 sync-token expiry),
submits each event to the EventPipelineProcessor queue, then soft-deletes
removed events and checkpoints the sync token — all without blocking other
calendar workers.
"""

import logging
import threading
from datetime import UTC, datetime

from sqlmodel import Session, select

from backend.db.models import CachedEvent, CalendarDefaultTag, CalendarSetting
from backend.services.calendar.base import BaseCalendarService
from backend.services.event_pipeline_processor import (
    CalendarProgress,
    EventPipelineProcessor,
    EventTask,
    set_current_calendar_id,
)

logger = logging.getLogger(__name__)


def _utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


class CalendarSyncWorker:
    """Fetches one calendar's events and streams them into the pipeline processor.

    Designed to run in its own thread via a ThreadPoolExecutor.
    Shares only the EventPipelineProcessor (thread-safe) and the CalendarProgress
    object (also thread-safe via its internal lock).

    Args:
        cal: CalendarSetting ORM object (read at construction time, not mutated).
        calendar_name: Human-readable display name for the calendar.
        calendar_service: Calendar API client (thread-safe).
        processor: Shared pipeline processor to submit tasks to.
        progress: CalendarProgress instance for this calendar.
        time_min: Lower bound for full syncs (reseed mode).
        abort_event: Shared abort signal; worker stops submitting if set.
        engine: SQLAlchemy engine for fresh DB sessions.
    """

    def __init__(
        self,
        cal: CalendarSetting,
        calendar_name: str,
        calendar_service: BaseCalendarService,
        processor: EventPipelineProcessor,
        progress: CalendarProgress,
        time_min: datetime | None,
        abort_event: threading.Event,
        engine,
    ):
        self._cal_id = cal.calendar_id
        self._calendar_name = calendar_name
        self._sync_token = cal.sync_token
        self._calendar_service = calendar_service
        self._processor = processor
        self._progress = progress
        self._time_min = time_min
        self._abort_event = abort_event
        self._engine = engine

    def run(self) -> None:
        """Fetch events and submit to pipeline. Runs in a worker thread."""
        progress = self._progress

        # Tag this thread so stdlib log records emitted by helpers
        # (calendar_service, geocoding, etc.) get routed to this calendar.
        set_current_calendar_id(self._cal_id)

        progress.status = "running"
        progress.started_at = _utcnow().isoformat()
        progress.add_log("INFO", f"Starting sync for calendar {self._calendar_name}")

        try:
            default_tag_ids = self._load_default_tag_ids()
            result = self._fetch_with_410_fallback()

            if self._abort_event.is_set():
                progress.status = "warning"
                progress.error = "Aborted before events were submitted"
                progress.finished_at = _utcnow().isoformat()
                return

            # Submit each event to the pipeline (blocks if queue is full)
            submitted = 0
            aborted_mid = False
            for cal_event in result.events:
                if self._abort_event.is_set():
                    aborted_mid = True
                    break
                progress.inc_fetched()
                self._processor.submit(
                    EventTask(
                        calendar_event=cal_event,
                        calendar_id=self._cal_id,
                        default_tag_ids=default_tag_ids,
                        abort_event=self._abort_event,
                    )
                )
                submitted += 1

            progress.add_log(
                "INFO",
                f"Submitted {submitted} events to pipeline for {self._calendar_name}",
            )

            if aborted_mid:
                progress.status = "warning"
                progress.add_log(
                    "WARNING",
                    f"Aborted mid-way through {self._calendar_name} — partial sync",
                )
                progress.finished_at = _utcnow().isoformat()
                return

            # Soft-delete events removed from the calendar
            deleted = self._reconcile_deletes(result.deleted_event_ids)
            if deleted:
                progress.add_log("INFO", f"Soft-deleted {deleted} removed events")

            # Checkpoint sync token
            if result.next_sync_token:
                self._save_sync_token(result.next_sync_token)

            progress.status = "processing"
            progress.add_log("INFO", f"Fetch complete for {self._calendar_name}")

        except Exception as exc:
            logger.exception("CalendarSyncWorker failed for %s", self._cal_id)
            progress.status = "failed"
            progress.error = f"{type(exc).__name__}: {exc}"
            progress.add_log("ERROR", f"Calendar sync failed: {exc}")

        finally:
            progress.finished_at = _utcnow().isoformat()
            set_current_calendar_id(None)

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _load_default_tag_ids(self) -> list[int]:
        DBSession = Session

        with DBSession(self._engine) as session:
            return [
                row.tag_id
                for row in session.exec(
                    select(CalendarDefaultTag).where(
                        CalendarDefaultTag.calendar_id == self._cal_id
                    )
                ).all()
            ]

    def _fetch_with_410_fallback(self):
        """Fetch events, retrying with a full sync if the sync token has expired."""
        DBSession = Session

        if self._sync_token:
            self._progress.add_log(
                "INFO",
                f"Incremental fetch (sync_token={self._sync_token[:8]}…)",
            )
        else:
            self._progress.add_log(
                "INFO",
                "Full fetch (no sync_token)",
            )

        result = self._calendar_service.get_events(
            calendar_id=self._cal_id,
            sync_token=self._sync_token,
            time_min=self._time_min if not self._sync_token else None,
        )

        # Detect 410: service returns empty result with no sync token
        if self._sync_token and result.next_sync_token is None:
            logger.info(
                "Sync token expired for calendar %s — performing full re-sync",
                self._cal_id,
            )
            self._progress.add_log(
                "WARNING",
                "Sync token expired — performing full re-sync",
            )
            # Clear the stale token in DB
            with DBSession(self._engine) as session:
                cal = session.get(CalendarSetting, self._cal_id)
                if cal:
                    cal.sync_token = None
                    session.add(cal)
                    session.commit()
            self._sync_token = None

            # Retry without token
            result = self._calendar_service.get_events(
                calendar_id=self._cal_id,
                sync_token=None,
                time_min=self._time_min,
            )

        return result

    def _reconcile_deletes(self, deleted_event_ids: list[str]) -> int:
        DBSession = Session

        if not deleted_event_ids:
            return 0

        deleted = 0
        with DBSession(self._engine) as session:
            for event_id in deleted_event_ids:
                event = session.get(CachedEvent, event_id)
                if event and event.deleted_at is None:
                    event.deleted_at = _utcnow()
                    session.add(event)
                    deleted += 1
            session.commit()
        return deleted

    def _save_sync_token(self, token: str) -> None:
        DBSession = Session

        with DBSession(self._engine) as session:
            cal = session.get(CalendarSetting, self._cal_id)
            if cal:
                cal.sync_token = token
                cal.updated_at = _utcnow()
                session.add(cal)
                session.commit()
