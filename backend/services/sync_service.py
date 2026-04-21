import logging
from datetime import datetime

from sqlmodel import Session, select

from backend.db.models import CachedEvent, CalendarSetting, SyncLog
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
        """Sync events for all enabled calendars. Returns summary stats."""
        log = SyncLog(trigger=trigger)
        session.add(log)
        session.commit()
        session.refresh(log)

        stats = {"calendars_synced": 0, "events_upserted": 0, "events_deleted": 0}
        all_needs_enrichment: list[str] = []

        enabled = session.exec(
            select(CalendarSetting).where(CalendarSetting.enabled == True)
        ).all()

        try:
            for cal in enabled:
                try:
                    cal_stats = self.sync_calendar(session, cal)
                    stats["calendars_synced"] += 1
                    stats["events_upserted"] += cal_stats["upserted"]
                    stats["events_deleted"] += cal_stats["deleted"]
                    all_needs_enrichment.extend(cal_stats.get("needs_enrichment", []))
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
            session.add(log)
            session.commit()

        # Phase 2: Run enrichment pipeline on all events that need it
        if all_needs_enrichment:
            log.enrichment_status = "running"
            session.add(log)
            session.commit()

            progress = self.pipeline.run(session, all_needs_enrichment)

            log.enrichment_status = "completed"
            log.enrichment_progress = progress.to_dict()
            session.add(log)
            session.commit()

        return stats

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

        # Phase 1: Upsert events immediately (no enrichment) so they are
        # visible to GET /events right away.
        upserted = 0
        needs_enrichment: list[str] = []

        for event in result.events:
            existing = session.get(CachedEvent, event.event_id)
            if existing:
                # Check if user-visible fields changed BEFORE overwriting
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
                existing.updated_at = datetime.utcnow()
                existing.deleted_at = None  # un-delete if re-appeared
                if fields_changed:
                    existing.review_status = "pending"
                # Mark for enrichment if any field is missing
                if (
                    (event.location and existing.latitude is None)
                    or (event.description and existing.price_min is None)
                    or (event.description and existing.links is None)
                ):
                    needs_enrichment.append(event.event_id)
                session.add(existing)
            else:
                new_event = CachedEvent(
                    event_id=event.event_id,
                    calendar_id=event.calendar_id,
                    title=event.title,
                    description=event.description,
                    location=event.location,
                    start=event.start,
                    end=event.end,
                    all_day=event.all_day,
                )
                session.add(new_event)
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
            "Synced calendar %s: %d upserted, %d deleted",
            cal.calendar_id,
            upserted,
            deleted,
        )

        return {
            "upserted": upserted,
            "deleted": deleted,
            "needs_enrichment": needs_enrichment,
        }
