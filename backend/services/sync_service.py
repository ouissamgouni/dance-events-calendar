import hashlib
import logging
import time
from datetime import datetime

from sqlmodel import Session, select

from backend.db.models import (
    CachedEvent,
    CalendarDefaultTag,
    CalendarSetting,
    EventCalendarSource,
    EventTag,
    SyncLog,
)


def compute_content_hash(title: str, start: datetime, location: str | None) -> str:
    """SHA-256 of normalized title|start_iso|location — used for cross-calendar dedup."""
    normalized = (
        f"{(title or '').strip().lower()}"
        f"|{start.isoformat()}"
        f"|{(location or '').strip().lower()}"
    )
    return hashlib.sha256(normalized.encode()).hexdigest()


from backend.services.calendar.base import BaseCalendarService
from backend.services.pipeline.base import EnrichmentPipeline
from backend.services.pipeline.stages.geocoding import GeocodingStage
from backend.services.pipeline.stages.link_extraction import LinkExtractionStage
from backend.services.pipeline.stages.price_extraction import PriceExtractionStage

logger = logging.getLogger(__name__)


class SyncService:
    def __init__(self, calendar_service: BaseCalendarService):
        self.calendar_service = calendar_service
        self.pipeline = EnrichmentPipeline(
            [
                LinkExtractionStage(),
                PriceExtractionStage(),
                GeocodingStage(),
            ]
        )

    def discover_calendars(self, session: Session, color_fn=None) -> int:
        """Discover calendars from source and upsert into DB. New ones default to disabled."""
        discovered = 0
        remote_calendars = self.calendar_service.list_calendars()
        for cal_info in remote_calendars:
            existing = session.get(CalendarSetting, cal_info.calendar_id)
            if not existing:
                kwargs = dict(
                    calendar_id=cal_info.calendar_id,
                    name=cal_info.name,
                    enabled=False,
                )
                if color_fn:
                    kwargs["color"] = color_fn(session)
                session.add(CalendarSetting(**kwargs))
                discovered += 1
            else:
                existing.name = cal_info.name
                session.add(existing)
        session.commit()
        return discovered

    def sync_all(self, session: Session, trigger: str = "auto") -> dict:
        """Sync events and run enrichment inline. Used by the background scheduler."""
        started = time.perf_counter()
        logger.info("Starting full sync run (trigger=%s)", trigger)
        stats, needs_enrichment, log = self._sync_phase(session, trigger)
        self._enrich_phase(session, needs_enrichment, log)
        elapsed = time.perf_counter() - started
        logger.info(
            "Full sync run finished in %.2fs (trigger=%s, calendars=%d, upserted=%d, deleted=%d)",
            elapsed,
            trigger,
            stats["calendars_synced"],
            stats["events_upserted"],
            stats["events_deleted"],
        )
        return stats

    def sync_all_fast(
        self, session: Session, trigger: str = "manual"
    ) -> tuple[dict, list[str], int]:
        """Sync events only (no enrichment). Returns (stats, event_ids_needing_enrichment, log_id).

        Designed for the manual-trigger endpoint: the caller is responsible for
        running enrichment asynchronously so the HTTP response is not blocked.
        """
        stats, needs_enrichment, log = self._sync_phase(session, trigger)
        return stats, needs_enrichment, log.id

    def run_enrichment(self, log_id: int, event_ids: list[str]) -> None:
        """Run the enrichment pipeline for a previously completed sync log.

        Intended to be called in a background task after sync_all_fast().
        Opens its own DB session so it can run independently of the request session.
        """
        from backend.db.database import get_engine
        from sqlmodel import Session as DBSession

        started = time.perf_counter()
        engine = get_engine()
        with DBSession(engine) as session:
            log = session.get(SyncLog, log_id)
            if log:
                log.enrichment_status = "running"
                session.add(log)
                session.commit()

            logger.info(
                "Starting background enrichment (log_id=%s, events=%d)",
                log_id,
                len(event_ids),
            )

            try:
                progress = self.pipeline.run(session, event_ids)
            except Exception as exc:
                logger.exception(
                    "Background enrichment failed (log_id=%s, events=%d)",
                    log_id,
                    len(event_ids),
                )
                if log:
                    log.enrichment_status = "error"
                    log.error_message = str(exc)
                    session.add(log)
                    session.commit()
                return

            if log:
                log.enrichment_status = "completed"
                log.enrichment_progress = progress.to_dict()
                session.add(log)
                session.commit()

            elapsed = time.perf_counter() - started
            logger.info(
                "Background enrichment completed in %.2fs (log_id=%s, events=%d)",
                elapsed,
                log_id,
                len(event_ids),
            )

    def _sync_phase(
        self, session: Session, trigger: str
    ) -> tuple[dict, list[str], SyncLog]:
        """Phase 1: sync calendars, upsert events, return enrichment candidates."""
        started = time.perf_counter()
        log = SyncLog(trigger=trigger)
        session.add(log)
        session.commit()
        session.refresh(log)

        stats = {"calendars_synced": 0, "events_upserted": 0, "events_deleted": 0}
        all_needs_enrichment: list[str] = []
        all_dedup_entries: list[dict] = []

        enabled = session.exec(
            select(CalendarSetting).where(CalendarSetting.enabled == True)
        ).all()
        logger.info(
            "Starting sync phase (log_id=%s, trigger=%s, enabled_calendars=%d)",
            log.id,
            trigger,
            len(enabled),
        )

        try:
            for cal in enabled:
                cal_started = time.perf_counter()
                try:
                    cal_stats = self.sync_calendar(session, cal)
                    stats["calendars_synced"] += 1
                    stats["events_upserted"] += cal_stats["upserted"]
                    stats["events_deleted"] += cal_stats["deleted"]
                    all_needs_enrichment.extend(cal_stats.get("needs_enrichment", []))
                    all_dedup_entries.extend(cal_stats.get("dedup_entries", []))
                    cal_elapsed = time.perf_counter() - cal_started
                    logger.info(
                        "Calendar sync done (log_id=%s, calendar_id=%s, upserted=%d, deleted=%d, enrich_candidates=%d, elapsed=%.2fs)",
                        log.id,
                        cal.calendar_id,
                        cal_stats["upserted"],
                        cal_stats["deleted"],
                        len(cal_stats.get("needs_enrichment", [])),
                        cal_elapsed,
                    )
                except Exception:
                    logger.exception("Failed to sync calendar %s", cal.calendar_id)

            log.status = "success"
        except Exception as exc:
            log.status = "error"
            log.error_message = str(exc)
            raise
        finally:
            log.finished_at = datetime.utcnow()
            log.calendars_synced = stats["calendars_synced"]
            log.events_upserted = stats["events_upserted"]
            log.events_deleted = stats["events_deleted"]
            if all_dedup_entries:
                log.dedup_log = all_dedup_entries
                logger.info(
                    "Sync complete: %d duplicates merged across all calendars",
                    len(all_dedup_entries),
                )
            session.add(log)
            session.commit()

        elapsed = time.perf_counter() - started
        logger.info(
            "Sync phase finished in %.2fs (log_id=%s, trigger=%s, calendars=%d, upserted=%d, deleted=%d, enrich_candidates=%d)",
            elapsed,
            log.id,
            trigger,
            stats["calendars_synced"],
            stats["events_upserted"],
            stats["events_deleted"],
            len(all_needs_enrichment),
        )

        return stats, all_needs_enrichment, log

    def _enrich_phase(
        self, session: Session, event_ids: list[str], log: SyncLog
    ) -> None:
        """Phase 2: run enrichment pipeline inline (used by scheduler)."""
        if not event_ids:
            logger.info("Skipping enrichment phase: no candidate events")
            return
        started = time.perf_counter()
        logger.info(
            "Starting enrichment phase (log_id=%s, events=%d)",
            log.id,
            len(event_ids),
        )
        log.enrichment_status = "running"
        session.add(log)
        session.commit()

        try:
            progress = self.pipeline.run(session, event_ids)
        except Exception as exc:
            log.enrichment_status = "error"
            log.error_message = str(exc)
            session.add(log)
            session.commit()
            logger.exception(
                "Enrichment phase failed (log_id=%s, events=%d)",
                log.id,
                len(event_ids),
            )
            return

        log.enrichment_status = "completed"
        log.enrichment_progress = progress.to_dict()
        session.add(log)
        session.commit()
        elapsed = time.perf_counter() - started
        logger.info(
            "Enrichment phase finished in %.2fs (log_id=%s, events=%d)",
            elapsed,
            log.id,
            len(event_ids),
        )

    def sync_calendar(self, session: Session, cal: CalendarSetting) -> dict:
        """Sync a single calendar. Uses sync token for incremental sync."""
        result = self.calendar_service.get_events(
            calendar_id=cal.calendar_id,
            sync_token=cal.sync_token,
        )

        # If sync token was expired (returned None), do full sync
        if cal.sync_token and result.next_sync_token is None:
            logger.info("Full re-sync for calendar %s", cal.calendar_id)
            cal.sync_token = None
            session.add(cal)
            session.commit()
            result = self.calendar_service.get_events(
                calendar_id=cal.calendar_id,
                sync_token=None,
            )

        # Load default tag IDs for this calendar once
        default_tag_ids = [
            row.tag_id
            for row in session.exec(
                select(CalendarDefaultTag).where(
                    CalendarDefaultTag.calendar_id == cal.calendar_id
                )
            ).all()
        ]

        # Phase 1: Upsert events immediately (no enrichment) so they are
        # visible to GET /events right away.
        upserted = 0
        duplicates_merged = 0
        needs_enrichment: list[str] = []
        dedup_entries: list[dict] = []

        for event in result.events:
            content_hash = compute_content_hash(
                event.title, event.start, event.location
            )

            existing = session.get(CachedEvent, event.event_id)
            if existing:
                # --- Known Google event ID: normal upsert ---
                fields_changed = (
                    existing.title != event.title
                    or existing.description != event.description
                    or existing.location != event.location
                    or existing.start != event.start
                    or existing.end != event.end
                    or existing.all_day != event.all_day
                )
                existing.title = event.title
                existing.description = event.description
                existing.location = event.location
                existing.start = event.start
                existing.end = event.end
                existing.all_day = event.all_day
                existing.content_hash = content_hash
                existing.updated_at = datetime.utcnow()
                existing.deleted_at = None  # un-delete if re-appeared
                if fields_changed:
                    existing.review_status = "pending"
                if (
                    (event.location and existing.latitude is None)
                    or (event.description and existing.price_min is None)
                    or (event.description and existing.links is None)
                ):
                    needs_enrichment.append(event.event_id)
                session.add(existing)
                # Track this calendar as a source (ignore if already recorded)
                _upsert_calendar_source(session, event.event_id, cal.calendar_id)
                upserted += 1
            else:
                # --- Unknown Google event ID: check for content-hash duplicate ---
                canonical = session.exec(
                    select(CachedEvent).where(
                        CachedEvent.content_hash == content_hash,
                        CachedEvent.deleted_at == None,  # noqa: E711
                    )
                ).first()

                if canonical:
                    # Duplicate found — merge tags and record source, skip new row
                    logger.info(
                        "Duplicate detected: '%s' (incoming_id=%s) matches canonical %s"
                        " — merging tags from calendar %s",
                        event.title,
                        event.event_id,
                        canonical.event_id,
                        cal.calendar_id,
                    )
                    for tag_id in default_tag_ids:
                        _upsert_event_tag(session, canonical.event_id, tag_id)
                    _upsert_calendar_source(
                        session, canonical.event_id, cal.calendar_id
                    )
                    dedup_entries.append(
                        {
                            "title": event.title,
                            "incoming_id": event.event_id,
                            "canonical_id": canonical.event_id,
                            "calendar_id": cal.calendar_id,
                        }
                    )
                    duplicates_merged += 1
                else:
                    # Genuinely new event
                    new_event = CachedEvent(
                        event_id=event.event_id,
                        calendar_id=event.calendar_id,
                        title=event.title,
                        description=event.description,
                        location=event.location,
                        start=event.start,
                        end=event.end,
                        all_day=event.all_day,
                        content_hash=content_hash,
                    )
                    session.add(new_event)
                    for tag_id in default_tag_ids:
                        session.add(EventTag(event_id=event.event_id, tag_id=tag_id))
                    _upsert_calendar_source(session, event.event_id, cal.calendar_id)
                    if event.location or event.description:
                        needs_enrichment.append(event.event_id)
                    upserted += 1

        deleted = 0
        for event_id in result.deleted_event_ids:
            existing = session.get(CachedEvent, event_id)
            if existing and existing.deleted_at is None:
                existing.deleted_at = datetime.utcnow()
                session.add(existing)
                deleted += 1

        if result.next_sync_token:
            cal.sync_token = result.next_sync_token
            cal.updated_at = datetime.utcnow()
            session.add(cal)

        # Commit events immediately — visible to API consumers now
        session.commit()
        logger.info(
            "Synced calendar %s: %d upserted, %d deleted, %d duplicates merged",
            cal.calendar_id,
            upserted,
            deleted,
            duplicates_merged,
        )

        return {
            "upserted": upserted,
            "deleted": deleted,
            "needs_enrichment": needs_enrichment,
            "dedup_entries": dedup_entries,
        }


# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------


def _upsert_calendar_source(session: Session, event_id: str, calendar_id: str) -> None:
    """Insert an EventCalendarSource row if it doesn't already exist."""
    existing = session.exec(
        select(EventCalendarSource).where(
            EventCalendarSource.event_id == event_id,
            EventCalendarSource.calendar_id == calendar_id,
        )
    ).first()
    if not existing:
        session.add(EventCalendarSource(event_id=event_id, calendar_id=calendar_id))


def _upsert_event_tag(session: Session, event_id: str, tag_id: int) -> None:
    """Insert an EventTag row if it doesn't already exist."""
    existing = session.exec(
        select(EventTag).where(
            EventTag.event_id == event_id,
            EventTag.tag_id == tag_id,
        )
    ).first()
    if not existing:
        session.add(EventTag(event_id=event_id, tag_id=tag_id))
