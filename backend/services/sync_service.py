import hashlib
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

from sqlmodel import Session, select

from backend.db.models import (
    BlockedEvent,
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
from backend.services.pipeline.stages.tag_suggestion import TagSuggestionStage

logger = logging.getLogger(__name__)


class SyncService:
    def __init__(self, calendar_service: BaseCalendarService):
        self.calendar_service = calendar_service
        self.pipeline = EnrichmentPipeline(
            [
                LinkExtractionStage(),
                PriceExtractionStage(),
                GeocodingStage(),
                # auto tag suggestions run last: cheap, depends only on text
                # already present on the event. Skipped silently in the
                # parallel processor path (no session); admins can run it
                # on demand via the bulk "Suggest tags" admin action.
                TagSuggestionStage(),
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
        self,
        session: Session,
        trigger: str = "manual",
        time_min: datetime | None = None,
    ) -> tuple[dict, list[str], int]:
        """Sync events only (no enrichment). Returns (stats, event_ids_needing_enrichment, log_id).

        Designed for the manual-trigger endpoint: the caller is responsible for
        running enrichment asynchronously so the HTTP response is not blocked.

        ``time_min`` is forwarded to Google Calendar when doing a full fetch
        (i.e. when no sync token is present). Useful for reseed jobs that want
        to limit how far back to pull events.
        """
        stats, needs_enrichment, log = self._sync_phase(
            session, trigger, time_min=time_min
        )
        return stats, needs_enrichment, log.id

    def run_enrichment(
        self,
        log_id: int,
        event_ids: list[str],
        max_workers: int = 1,
    ) -> None:
        """Run the enrichment pipeline for a previously completed sync log.

        Intended to be called in a background task after sync_all_fast().
        Opens its own DB session so it can run independently of the request
        session.

        When ``max_workers > 1``, events are enriched in parallel using a
        bounded thread pool — each worker owns its own DB session.
        """
        from backend.db.database import get_engine
        from sqlmodel import Session as DBSession

        started = time.perf_counter()
        engine = get_engine()

        # Mark as running
        with DBSession(engine) as session:
            log = session.get(SyncLog, log_id)
            if log:
                log.enrichment_status = "running"
                session.add(log)
                session.commit()

        logger.info(
            "Starting enrichment (log_id=%s, events=%d, workers=%d)",
            log_id,
            len(event_ids),
            max_workers,
        )

        try:
            if max_workers > 1 and len(event_ids) > 1:
                progress = self._run_parallel_enrichment(event_ids, engine, max_workers)
            else:
                with DBSession(engine) as session:
                    progress = self.pipeline.run(session, event_ids)
        except Exception as exc:
            logger.exception("Enrichment failed (log_id=%s)", log_id)
            with DBSession(engine) as session:
                log = session.get(SyncLog, log_id)
                if log:
                    log.enrichment_status = "error"
                    log.error_message = str(exc)
                    session.add(log)
                    session.commit()
            return

        with DBSession(engine) as session:
            log = session.get(SyncLog, log_id)
            if log:
                log.enrichment_status = "completed"
                log.enrichment_progress = progress.to_dict()
                session.add(log)
                session.commit()

        # Phase 3: post-sync curation hook. Apply per-calendar rules to
        # auto-add freshly-synced events to admin-managed targets'
        # Saved/Going lists. Failures here are logged but never fail
        # the sync — curation is best-effort enhancement, not the
        # source of truth for ingest.
        try:
            from backend.api.deps import get_admin_user_id
            from backend.services.curation_hook import apply_curation_rules

            with DBSession(engine) as session:
                admin_id = get_admin_user_id(session)
                hook_result = apply_curation_rules(
                    session, event_ids, admin_user_id=admin_id
                )
                session.commit()
                if hook_result.rows_changed or hook_result.rules_evaluated:
                    logger.info(
                        "Curation hook (log_id=%s): %d rules, %d rows changed, %d targets invalid",
                        log_id,
                        hook_result.rules_evaluated,
                        hook_result.rows_changed,
                        hook_result.rules_skipped_target_invalid,
                    )
        except Exception:
            logger.exception("Curation hook failed (log_id=%s)", log_id)

        elapsed = time.perf_counter() - started
        logger.info(
            "Enrichment completed in %.2fs (log_id=%s, events=%d)",
            elapsed,
            log_id,
            len(event_ids),
        )

    def _run_parallel_enrichment(self, event_ids: list[str], engine, max_workers: int):
        """Parallel enrichment: each event processed in its own thread + DB session."""
        from sqlmodel import Session as DBSession
        from backend.services.pipeline.base import PipelineProgress, StageResult

        progress = PipelineProgress()
        for stage in self.pipeline.stages:
            progress.stages[stage.name] = StageResult()
        merge_lock = threading.Lock()

        def process_one(event_id: str) -> dict:
            with DBSession(engine) as sess:
                event = sess.exec(
                    select(CachedEvent).where(CachedEvent.event_id == event_id)
                ).first()
                if event is None or event.deleted_at is not None:
                    return {}
                return self.pipeline.process_event(sess, event)

        workers = min(max_workers, len(event_ids))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {pool.submit(process_one, eid): eid for eid in event_ids}
            for future in as_completed(futures):
                try:
                    results = future.result()
                    with merge_lock:
                        for stage_name, result in results.items():
                            if stage_name in progress.stages:
                                s = progress.stages[stage_name]
                                s.processed += result.processed
                                s.skipped += result.skipped
                                s.failed += result.failed
                except Exception:
                    logger.exception(
                        "Parallel enrichment worker failed for event %s",
                        futures[future],
                    )

        return progress

    def _sync_phase(
        self,
        session: Session,
        trigger: str,
        time_min: datetime | None = None,
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
                    cal_stats = self.sync_calendar(session, cal, time_min=time_min)
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

    def sync_calendar(
        self,
        session: Session,
        cal: CalendarSetting,
        time_min: datetime | None = None,
    ) -> dict:
        """Sync a single calendar. Uses sync token for incremental sync.

        ``time_min`` is forwarded when performing a full fetch (no sync token).
        """
        result = self.calendar_service.get_events(
            calendar_id=cal.calendar_id,
            sync_token=cal.sync_token,
            # Only apply time_min on full syncs — ignored when sync_token is set
            time_min=time_min if not cal.sync_token else None,
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
                time_min=time_min,
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
                    # Genuinely new event — skip if admin has blocked this ID
                    if session.get(BlockedEvent, event.event_id) is not None:
                        logger.debug(
                            "Skipping blocked event_id=%s during sync",
                            event.event_id,
                        )
                        continue
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
