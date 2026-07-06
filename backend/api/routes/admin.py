import logging
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import or_
from sqlmodel import Session, col, func, select

logger = logging.getLogger(__name__)

from backend.api.deps import require_admin
from backend.api.schemas import (
    AdminBulkEngagementItem,
    AdminBulkEngagementRequest,
    AdminBulkEngagementResponse,
    BulkEventIdsRequest,
    BulkTagAssignRequest,
    BulkTagSuggestionRunRequest,
    BulkTagSuggestionRunResponse,
    CalendarAddRequest,
    CalendarCurationRuleCreateRequest,
    CalendarCurationRuleResponse,
    CalendarCurationRuleUpdateRequest,
    CalendarDefaultTagsResponse,
    CalendarDefaultTagsUpdate,
    CalendarSettingResponse,
    CalendarToggleRequest,
    DigestSendNowRequest,
    DigestSendNowResponse,
    EventFilterOptionsResponse,
    EventIdsResponse,
    EventResponse,
    EventUpdateRequest,
    FilterOption,
    ForceInterestMatchSendRequest,
    ForceInterestMatchSendResponse,
    ForceInterestMatchPreviewResponse,
    ForceInterestMatchPreviewUser,
    ForceSendUserResult,
    GeocodeSuggestion,
    NotificationLogEntry,
    NotificationLogResponse,
    NotificationToggleCountEntry,
    NotificationToggleCountsResponse,
    PaginatedEventsResponse,
    SyncJobListResponse,
    SyncJobStartRequest,
    SyncLogResponse,
    TagSuggestionRunRequest,
    TagSuggestionRunResponse,
)
from backend.api.routes.tags import _suggestion_to_response, get_event_tags
from backend.db.database import get_engine, get_session
from backend.db.models import (
    BlockedEvent,
    CalendarDefaultTag,
    CachedEvent,
    CalendarCurationRule,
    CalendarSetting,
    EventAttendance,
    EventLinkClick,
    EventExport,
    EventSave,
    EventTag,
    EventView,
    Notification,
    NotificationDelivery,
    PushSubscription,
    SyncLog,
    Tag,
    TagSuggestion,
    User,
    UserEventAttendance,
)
from backend.services.geocoding import geocode_location, search_locations
from backend.services.sync_job_service import SyncJobStatus, get_sync_job_service
from backend.services.sync_service import SyncService

router = APIRouter(prefix="/api/admin", tags=["admin"])


def _is_event_blocked(session: Session, event_id: str) -> bool:
    """Return True if event_id has an entry in blocked_events."""
    return session.get(BlockedEvent, event_id) is not None


def _apply_upcoming_filter(
    stmt, *, include_past: bool, future_only: Optional[bool] = None
):
    """Apply the upcoming-only filter to a select() over CachedEvent.

    The admin app is forward-looking: by default we hide events that have
    already finished. Pass ``include_past=True`` to opt into the legacy
    "show everything" behaviour (still useful for analytics / audit).

    ``future_only`` is the legacy query param; when explicitly set it wins
    so existing clients/tests that pass it don't change behaviour.
    Uses ``CachedEvent.end > now`` so events in progress remain visible.
    """
    from datetime import datetime as _dt

    # Legacy explicit param wins.
    if future_only is True:
        return stmt.where(CachedEvent.start > _dt.utcnow())
    if future_only is False:
        return stmt
    # New default: upcoming-only unless caller opted in to past.
    if include_past:
        return stmt
    return stmt.where(CachedEvent.end > _dt.utcnow())


# Visually distinct palette — cycled when more calendars are added
CALENDAR_COLORS = [
    "#e11d48",  # rose-600
    "#2563eb",  # blue-600
    "#16a34a",  # green-600
    "#d97706",  # amber-600
    "#9333ea",  # purple-600
    "#0891b2",  # cyan-600
    "#dc2626",  # red-600
    "#4f46e5",  # indigo-600
    "#ca8a04",  # yellow-600
    "#0d9488",  # teal-600
]


def _run_sync_job_worker(
    job_id: str,
    job_service,
    calendar_service,
    mode: str,
    since_date: str | None,
    calendar_ids: list[str] | None = None,
):
    """Streaming fetch+enrich sync job worker.

    Each enabled calendar runs in its own fetch thread.  Events are submitted
    one-by-one into a bounded queue as they arrive.  A pool of enrichment
    workers pulls from the queue, upserts each event and runs the pipeline
    concurrently — so the first event can be geocoded before the last calendar
    page has even been fetched.
    """
    import threading
    from concurrent.futures import ThreadPoolExecutor, as_completed
    from datetime import datetime as _dt

    from backend.services.calendar_sync_worker import CalendarSyncWorker
    from backend.services.event_pipeline_processor import (
        CalendarProgress,
        EventPipelineProcessor,
    )
    from backend.services.pipeline.base import EnrichmentPipeline
    from backend.services.pipeline.stages.geocoding import GeocodingStage
    from backend.services.pipeline.stages.link_extraction import LinkExtractionStage
    from backend.services.pipeline.stages.price_extraction import PriceExtractionStage

    engine = get_engine()
    job_service.heartbeat(job_id)

    # --- Parse since_date ---
    time_min: _dt | None = None
    if since_date:
        try:
            time_min = _dt.fromisoformat(since_date)
        except ValueError:
            logger.warning(
                "Invalid since_date '%s' in sync job %s — ignoring",
                since_date,
                job_id,
            )

    # --- Reseed: clear all sync tokens ---
    if mode == "reseed":
        with Session(engine) as session:
            q = select(CalendarSetting).where(CalendarSetting.enabled == True)
            if calendar_ids:
                q = q.where(CalendarSetting.calendar_id.in_(calendar_ids))
            calendars = session.exec(q).all()
            for cal in calendars:
                cal.sync_token = None
                session.add(cal)
            session.commit()
        job_service.set_metadata(job_id, reseed_applied=True, since_date=since_date)

    # --- Load enabled calendars ---
    with Session(engine) as session:
        q = select(CalendarSetting).where(CalendarSetting.enabled == True)
        if calendar_ids:
            q = q.where(CalendarSetting.calendar_id.in_(calendar_ids))
        enabled = session.exec(q).all()
        # Snapshot the fields we need (avoid detached-instance issues across threads)
        calendar_snapshots = [
            {
                "calendar_id": cal.calendar_id,
                "name": cal.name,
                "sync_token": cal.sync_token,
            }
            for cal in enabled
        ]

    if not calendar_snapshots:
        return {"status": SyncJobStatus.COMPLETED}

    # --- Build per-calendar progress map ---
    abort_event = threading.Event()
    progress_map: dict[str, CalendarProgress] = {
        snap["calendar_id"]: CalendarProgress(
            calendar_id=snap["calendar_id"],
            calendar_name=snap["name"] or snap["calendar_id"],
        )
        for snap in calendar_snapshots
    }

    def _publish_progress() -> None:
        job_service.update_calendar_statuses(
            job_id, {cid: p.to_dict() for cid, p in progress_map.items()}
        )
        # Roll up live totals so the cross-calendar metrics also update
        # while the pipeline is still draining.
        job_service.update_totals(
            job_id,
            calendars_synced=sum(
                1
                for p in progress_map.values()
                if p.status in ("completed", "warning", "failed", "processing")
            ),
            events_fetched=sum(p.fetched for p in progress_map.values()),
            events_upserted=sum(p.upserted for p in progress_map.values()),
            events_deduped=sum(p.deduped for p in progress_map.values()),
            events_enriched=sum(p.enriched_ok for p in progress_map.values()),
            events_failed=sum(p.enriched_failed for p in progress_map.values()),
        )
        job_service.heartbeat(job_id)

    # Periodic publisher: pushes live progress + totals to the job service
    # every second so the UI sees per-stage counters and logs accumulate
    # while enrichment is still running (rather than only after each fetch
    # future completes).
    publisher_stop = threading.Event()

    def _publisher_loop() -> None:
        while not publisher_stop.wait(1.0):
            try:
                _publish_progress()
            except Exception:
                logger.exception("Progress publisher tick failed")

    publisher_thread = threading.Thread(
        target=_publisher_loop,
        name=f"sync-publisher-{job_id[:8]}",
        daemon=True,
    )
    publisher_thread.start()

    # --- Create pipeline (one instance, shared across workers — stages are stateless) ---
    pipeline = EnrichmentPipeline(
        [
            LinkExtractionStage(),
            PriceExtractionStage(),
            GeocodingStage(),
        ]
    )

    # --- Start enrichment worker pool ---
    processor = EventPipelineProcessor(
        pipeline=pipeline,
        progress_map=progress_map,
        abort_event=abort_event,
        num_workers=4,
        max_queue_size=500,
    )
    processor.start()

    # --- Launch calendar fetch threads ---
    with ThreadPoolExecutor(
        max_workers=len(calendar_snapshots),
        thread_name_prefix="calendar-fetch",
    ) as fetch_pool:

        def _make_worker(snap: dict) -> CalendarSyncWorker:
            # We need a CalendarSetting-like object for the worker
            class _CalSnap:
                calendar_id = snap["calendar_id"]
                sync_token = snap["sync_token"]

            return CalendarSyncWorker(
                cal=_CalSnap(),
                calendar_name=snap["name"] or snap["calendar_id"],
                calendar_service=calendar_service,
                processor=processor,
                progress=progress_map[snap["calendar_id"]],
                time_min=time_min,
                abort_event=abort_event,
                engine=engine,
            )

        fetch_futures = {
            fetch_pool.submit(_make_worker(snap).run): snap["calendar_id"]
            for snap in calendar_snapshots
        }

        # Stream progress updates while calendars are fetching
        for future in as_completed(fetch_futures):
            cal_id = fetch_futures[future]
            try:
                future.result()
            except Exception as exc:
                logger.exception("Calendar fetch thread failed for %s", cal_id)
                p = progress_map.get(cal_id)
                if p:
                    p.status = "failed"
                    p.error = str(exc)
            _publish_progress()

        # Check abort after all fetches
        if job_service.should_abort(job_id):
            abort_event.set()

    # --- Drain enrichment queue ---
    processor.stop()

    # Stop the periodic publisher before the final aggregation so it can't
    # race with update_totals() below.
    publisher_stop.set()
    publisher_thread.join(timeout=2.0)

    # Transition any calendars that finished fetching successfully from
    # the intermediate "processing" state to "completed" now that the
    # pipeline has drained.
    for p in progress_map.values():
        if p.status == "processing":
            p.status = "completed"
    _publish_progress()

    # --- Aggregate totals ---
    total_fetched = sum(p.fetched for p in progress_map.values())
    total_upserted = sum(p.upserted for p in progress_map.values())
    total_deduped = sum(p.deduped for p in progress_map.values())
    total_enriched_ok = sum(p.enriched_ok for p in progress_map.values())
    total_enriched_failed = sum(p.enriched_failed for p in progress_map.values())
    # Real errors: enrichment exceptions + persistence failures (counted in
    # error_count via inc_enriched_failed).
    total_errors = sum(p.error_count for p in progress_map.values())
    # Warnings: e.g. geocoding misses — non-fatal, event still saved.
    total_warnings = sum(
        sum(1 for f in p.failures if f.type == "ungeolocated")
        for p in progress_map.values()
    )
    calendars_failed = sum(1 for p in progress_map.values() if p.status == "failed")

    job_service.update_totals(
        job_id,
        calendars_synced=len(calendar_snapshots) - calendars_failed,
        events_fetched=total_fetched,
        events_upserted=total_upserted,
        events_deduped=total_deduped,
        events_enriched=total_enriched_ok,
        events_failed=total_enriched_failed,
    )

    if abort_event.is_set():
        return {"status": SyncJobStatus.ABORTED}

    if calendars_failed > 0 or total_errors > 0 or total_warnings > 0:
        parts: list[str] = []
        if calendars_failed > 0:
            parts.append(f"{calendars_failed} calendar(s) failed")
        if total_errors > 0:
            parts.append(f"{total_errors} error(s)")
        if total_warnings > 0:
            parts.append(f"{total_warnings} warning(s)")
        return {
            "status": SyncJobStatus.WARNING,
            "warning_message": ", ".join(parts),
            "calendar_statuses": {cid: p.to_dict() for cid, p in progress_map.items()},
        }

    return {
        "status": SyncJobStatus.COMPLETED,
        "calendar_statuses": {cid: p.to_dict() for cid, p in progress_map.items()},
    }


def _next_color(session: Session) -> str:
    """Pick the next color from the palette based on how many calendars exist."""
    count = session.exec(select(func.count(CalendarSetting.calendar_id))).one()
    return CALENDAR_COLORS[count % len(CALENDAR_COLORS)]


@router.get("/calendars", response_model=list[CalendarSettingResponse])
def list_calendars(session: Session = Depends(get_session)):
    calendars = session.exec(select(CalendarSetting)).all()
    # Backfill colors for calendars that were added before color assignment
    changed = False
    for cal in calendars:
        if cal.color is None:
            cal.color = CALENDAR_COLORS[calendars.index(cal) % len(CALENDAR_COLORS)]
            session.add(cal)
            changed = True
    if changed:
        session.commit()
        for cal in calendars:
            session.refresh(cal)
    return calendars


@router.post("/calendars", response_model=CalendarSettingResponse)
def add_calendar(
    body: CalendarAddRequest,
    request: Request,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """Add a calendar by ID. Verifies the service account can access it.

    Manually added calendars are enabled by default so they are immediately
    eligible for sync.
    """
    # Check if already exists
    existing = session.get(CalendarSetting, body.calendar_id)
    if existing:
        if not existing.enabled:
            existing.enabled = True
            session.add(existing)
            session.commit()
            session.refresh(existing)
        return existing

    calendar_service = request.app.state.calendar_service
    try:
        info = calendar_service.get_calendar_info(body.calendar_id)
    except Exception as exc:
        logger.exception("Failed to verify calendar access")
        raise HTTPException(
            status_code=502, detail=f"Calendar service error: {exc}"
        ) from exc

    if info is None:
        raise HTTPException(
            status_code=404,
            detail=f"Calendar '{body.calendar_id}' not accessible. Make sure it is shared with the service account.",
        )

    cal = CalendarSetting(
        calendar_id=info.calendar_id,
        name=info.name,
        enabled=True,
        color=_next_color(session),
    )
    session.add(cal)
    session.commit()
    session.refresh(cal)
    return cal


@router.post("/discover")
def discover_calendars(
    request: Request,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """Discover calendars from Google (or mock). New calendars are added as disabled."""
    calendar_service = request.app.state.calendar_service
    sync_service = SyncService(calendar_service)
    try:
        discovered = sync_service.discover_calendars(session, color_fn=_next_color)
    except FileNotFoundError as exc:
        logger.exception("Service account file not found")
        raise HTTPException(
            status_code=502, detail=f"Service account file not found: {exc}"
        ) from exc
    except Exception as exc:
        logger.exception("Failed to discover calendars")
        raise HTTPException(
            status_code=502, detail=f"Calendar service error: {exc}"
        ) from exc
    all_calendars = session.exec(select(CalendarSetting)).all()
    return {"discovered": discovered, "total": len(all_calendars)}


@router.post("/sync-jobs")
def start_sync_job(
    body: SyncJobStartRequest,
    request: Request,
    _admin: dict = Depends(require_admin),
):
    job_service = get_sync_job_service()
    calendar_service = request.app.state.calendar_service

    try:
        job = job_service.start_job(
            worker=lambda job_id, service: _run_sync_job_worker(
                job_id,
                service,
                calendar_service,
                body.mode,
                body.since_date,
                body.calendar_ids or None,
            ),
            mode=body.mode,
            since_date=body.since_date,
            calendar_ids=body.calendar_ids,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    return job


@router.post("/trigger-sync")
def trigger_sync(
    mode: str = "incremental",
    request: Request = None,
    _admin: dict = Depends(require_admin),
):
    """Trigger a sync job (called by external scheduler or admin UI).

    Checks auto_sync_enabled setting before starting.
    Returns 200 with skipped reason if auto-sync is disabled.
    Returns 409 if a job is already running.
    """
    from backend.db.database import get_engine

    # Check if auto-sync is enabled
    with Session(get_engine()) as session:
        auto_sync_enabled = _get_auto_sync_enabled_setting(session)
        if not auto_sync_enabled:
            logger.info("Auto-sync disabled; skipping trigger-sync call")
            return {
                "status": "skipped",
                "reason": "auto_sync_disabled",
            }

    # Try to start job
    job_service = get_sync_job_service()
    calendar_service = request.app.state.calendar_service
    try:
        job = job_service.start_job(
            worker=lambda job_id, service: _run_sync_job_worker(
                job_id,
                service,
                calendar_service,
                mode,
                since_date=None,
            ),
            mode=mode,
            since_date=None,
        )
        logger.info("Auto-sync triggered: job %s (mode=%s)", job["job_id"], mode)
        return {"status": "started", "job_id": job["job_id"]}
    except RuntimeError as exc:
        # Job already running
        logger.info("Auto-sync trigger skipped: %s", exc)
        return {"status": "skipped", "reason": str(exc)}


@router.post("/trigger-notifications")
def trigger_notifications(_admin: dict = Depends(require_admin)):
    """Run one notification dispatch pass (reminders + activity digests).

    Called by the external scheduler (Fly Machines cron) in environments
    where the in-app dispatch loop is disabled. Idempotent: reminders are
    deduped by unique constraint and digest rows are stamped once emailed.
    """
    from backend.services.scheduler import run_notification_dispatch_once

    stats = run_notification_dispatch_once()
    return {"status": "ok", "stats": stats}


@router.get("/notifications/effective-config")
def notifications_effective_config(
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """Resolved (site_settings-override-or-env) notification config.

    For each admin-configurable gate, reports the *effective* value the
    running instance actually uses right now plus where it came from —
    ``site_setting`` (an explicit DB override exists) or ``env_or_default``
    (falling through to the env var / hardcoded default in
    ``backend.config.loader``). Answers "what is the backend actually
    using?" without needing direct DB access.
    """
    from backend.config import loader
    from backend.services import app_settings

    def _entry(effective, row_present: bool, env_value):
        return {
            "effective": effective,
            "source": "site_setting" if row_present else "env_or_default",
            "env_or_default_value": env_value,
        }

    return {
        "event_reminders_enabled": _entry(
            app_settings.get_event_reminders_enabled(session),
            app_settings._get_bool_row(session, "event_reminders_enabled") is not None,
            loader.get_event_reminders_enabled(),
        ),
        "activity_digest_email_enabled": _entry(
            app_settings.get_activity_digest_email_enabled(session),
            app_settings._get_bool_row(session, "activity_digest_email_enabled")
            is not None,
            loader.get_activity_digest_email_enabled(),
        ),
        "interest_match_notifications_enabled": _entry(
            app_settings.get_interest_match_notifications_enabled(session),
            app_settings._get_bool_row(session, "interest_match_notifications_enabled")
            is not None,
            loader.get_interest_match_notifications_enabled(),
        ),
        "web_push_enabled": _entry(
            app_settings.get_web_push_enabled(session),
            app_settings._get_bool_row(session, "web_push_enabled") is not None,
            loader.get_web_push_enabled(),
        ),
        "reminder_lead_hours": _entry(
            app_settings.get_reminder_lead_hours(session),
            app_settings._get_int_row(session, "reminder_lead_hours") is not None,
            loader.get_reminder_lead_hours(),
        ),
        "activity_digest_schedule": _entry(
            app_settings.get_activity_digest_schedule(session),
            app_settings._get_str_row(session, "activity_digest_schedule") is not None,
            app_settings.DEFAULT_DIGEST_SCHEDULE,
        ),
        # Env-only (no DB override support): the in-app scheduler loop and
        # its tick cadence, which only take effect on process restart.
        "notification_scheduler_enabled": {
            "effective": loader.get_notification_scheduler_enabled(),
            "source": "env_only",
        },
        "notification_interval_minutes": {
            "effective": loader.get_notification_interval_minutes(),
            "source": "env_only",
        },
        "vapid_configured": bool(
            loader.get_vapid_config().get("public_key")
            and loader.get_vapid_config().get("private_key")
        ),
    }


@router.get("/notifications/webpush/subscriber-count")
def webpush_subscriber_count(
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """Count of distinct signed-in users with at least one registered Web
    Push browser endpoint. Anonymous (``user_id IS NULL``) subscriptions are
    excluded since they aren't tied to an account.
    """
    count = int(
        session.exec(
            select(func.count(func.distinct(PushSubscription.user_id))).where(
                col(PushSubscription.user_id).is_not(None)
            )
        ).one()
    )
    return {"subscriber_count": count}


@router.get(
    "/notifications/toggle-counts", response_model=NotificationToggleCountsResponse
)
def notification_toggle_counts(
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """Count of non-deleted users with each per-feature notification
    channel toggle turned on, shown next to the corresponding global gate
    in admin Configuration so an admin can see how many users a change
    would actually affect.
    """
    from sqlalchemy import case

    def _count(condition) -> int:
        return int(
            session.exec(
                select(func.sum(case((condition, 1), else_=0))).where(
                    col(User.deleted_at).is_(None)
                )
            ).one()
            or 0
        )

    total_users = int(
        session.exec(
            select(func.count()).select_from(User).where(col(User.deleted_at).is_(None))
        ).one()
    )

    return NotificationToggleCountsResponse(
        total_users=total_users,
        interest_match=NotificationToggleCountEntry(
            email=_count(User.email_interest_matches_enabled == True),  # noqa: E712
            push=_count(User.push_interest_matches_enabled == True),  # noqa: E712
        ),
        event_reminders=NotificationToggleCountEntry(
            email=_count(User.email_event_reminders_enabled == True),  # noqa: E712
            push=_count(User.push_event_reminders_enabled == True),  # noqa: E712
        ),
        activity_digest=NotificationToggleCountEntry(
            email=_count(User.email_social_activity_enabled == True),  # noqa: E712
            push=_count(User.push_social_activity_enabled == True),  # noqa: E712
        ),
    )


# Notification type (as shown in the admin Notifications tab) -> the
# Notification.kind values that roll up into it. Built from the same
# single-source-of-truth maps the delivery workers use, so the log can
# never drift from what "interest_match" / "activity_digest" actually mean.
def _notification_kinds_by_type() -> dict[str, list[str]]:
    from backend.services import activity_email
    from backend.services.reminder_service import EVENT_REMINDER

    kinds_by_type: dict[str, list[str]] = {
        "interest_match": [],
        "activity_digest": [],
        "event_reminder": [EVENT_REMINDER],
    }
    for kind, feature in activity_email.FEATURE_BY_KIND.items():
        if feature == "interest_matches":
            kinds_by_type["interest_match"].append(kind)
        elif feature == "social_activity":
            kinds_by_type["activity_digest"].append(kind)
    return kinds_by_type


@router.get("/notifications/log", response_model=NotificationLogResponse)
def admin_notifications_log(
    type: Optional[str] = Query(default=None),
    channel: Optional[str] = Query(default=None),
    q: Optional[str] = Query(default=None, max_length=120),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """List every notification delivery event ever recorded, newest first,
    for the admin Notifications tab.

    Reads from ``NotificationDelivery`` — one row per actual app/email/push
    distribution event — so only channels that were actually (or, for
    "app", eligibly) delivered show up here; a notification suppressed by
    a recipient's disabled channel produces no row for that channel.

    ``type`` filters to one of "interest_match" / "activity_digest" /
    "event_reminder" (matching the 3 feature gates in Configuration).
    ``channel`` filters to "app", "email", or "push". ``q`` matches the
    recipient's handle, display name, or email (case-insensitive
    substring).
    """
    kinds_by_type = _notification_kinds_by_type()
    if type is not None and type not in kinds_by_type:
        raise HTTPException(status_code=400, detail=f"Unknown type: {type}")
    if channel is not None and channel not in ("app", "email", "push"):
        raise HTTPException(status_code=400, detail=f"Unknown channel: {channel}")

    stmt = (
        select(NotificationDelivery, Notification, User)
        .join(Notification, Notification.id == NotificationDelivery.notification_id)
        .join(User, User.id == Notification.recipient_user_id)
    )
    if type is not None:
        stmt = stmt.where(col(Notification.kind).in_(kinds_by_type[type]))
    if channel is not None:
        stmt = stmt.where(NotificationDelivery.channel == channel)
    if q:
        needle = f"%{q.strip().lower()}%"
        stmt = stmt.where(
            or_(
                func.lower(User.handle).like(needle),
                func.lower(User.display_name).like(needle),
                func.lower(User.email).like(needle),
            )
        )

    total = int(session.exec(select(func.count()).select_from(stmt.subquery())).one())
    rows = session.exec(
        stmt.order_by(col(NotificationDelivery.delivered_at).desc())
        .limit(limit)
        .offset(offset)
    ).all()

    kind_to_type = {k: t for t, kinds in kinds_by_type.items() for k in kinds}
    items = [
        NotificationLogEntry(
            id=d.id,
            notification_id=n.id,
            delivered_at=d.delivered_at,
            kind=n.kind,
            type=kind_to_type.get(n.kind, n.kind),
            channel=d.channel,
            recipient_user_id=u.id,
            recipient_email=u.email,
            recipient_handle=u.handle,
            recipient_display_name=u.display_name,
        )
        for d, n, u in rows
    ]
    return NotificationLogResponse(items=items, total=total)


@router.post(
    "/notifications/interest-match/force-send",
    response_model=ForceInterestMatchSendResponse,
)
def force_send_interest_matches(
    body: ForceInterestMatchSendRequest,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """Admin override: scan for interest-profile matches over a custom
    ``lookback_hours`` window for hand-picked users and deliver them right
    away (email/push), bypassing the normal digest schedule window and the
    global scan cursor. For support/debugging — e.g. verifying a user's
    saved-search alert works, or backfilling a match they say they missed.
    """
    from backend.services import activity_email, interest_notification_service
    from backend.services.interest_notification_service import INTEREST_EVENT

    users = {
        u.id: u
        for u in session.exec(
            select(User).where(User.id.in_(body.user_ids))  # type: ignore[union-attr]
        ).all()
    }

    results: list[ForceSendUserResult] = []
    eligible_ids: set = set()
    for uid in body.user_ids:
        user = users.get(uid)
        if user is None or user.deleted_at is not None:
            results.append(
                ForceSendUserResult(user_id=uid, email="", status="skipped_not_found")
            )
            continue
        if not (
            user.email_interest_matches_enabled or user.push_interest_matches_enabled
        ):
            results.append(
                ForceSendUserResult(
                    user_id=uid, email=user.email, status="skipped_disabled"
                )
            )
            continue
        eligible_ids.add(uid)

    if not eligible_ids:
        return ForceInterestMatchSendResponse(
            candidates_scanned=0,
            notifications_created=0,
            digests_sent=0,
            pushes_sent=0,
            results=results,
        )

    match_stats = interest_notification_service.run_once_for_users(
        eligible_ids, body.lookback_hours
    )
    digest_stats = activity_email.run_once(
        force=True, user_ids=eligible_ids, kinds=(INTEREST_EVENT,)
    )
    delivered = set(digest_stats.get("delivered_recipients") or [])
    for uid in eligible_ids:
        status = "sent" if str(uid) in delivered else "no_pending_notifications"
        results.append(
            ForceSendUserResult(user_id=uid, email=users[uid].email, status=status)
        )

    return ForceInterestMatchSendResponse(
        candidates_scanned=match_stats.get("candidates", 0),
        notifications_created=match_stats.get("created", 0),
        digests_sent=digest_stats.get("digests", 0),
        pushes_sent=digest_stats.get("pushed", 0),
        results=results,
    )


@router.post(
    "/notifications/interest-match/preview",
    response_model=ForceInterestMatchPreviewResponse,
)
def preview_interest_matches(
    body: ForceInterestMatchSendRequest,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """Dry-run companion to ``force-send``: reports, per selected user, how
    many events in the ``lookback_hours`` window match their interest
    profile(s) and how many of those are new (i.e. would actually create a
    notification). Lets an admin sanity-check a force-send before committing
    to it — e.g. explaining a "26 candidates, 0 created" result, which means
    none of the candidate events matched this user's saved profile(s).
    """
    from backend.services.interest_notification_service import preview_matches_for_users

    users = {
        u.id: u
        for u in session.exec(
            select(User).where(User.id.in_(body.user_ids))  # type: ignore[union-attr]
        ).all()
    }

    preview = preview_matches_for_users(set(body.user_ids), body.lookback_hours)
    per_user = preview.get("per_user", {})

    results: list[ForceInterestMatchPreviewUser] = []
    for uid in body.user_ids:
        user = users.get(uid)
        if user is None:
            continue
        stats = per_user.get(str(uid), {})
        results.append(
            ForceInterestMatchPreviewUser(
                user_id=uid,
                email=user.email,
                matched_events=stats.get("matched_events", 0),
                new_events=stats.get("new_events", 0),
            )
        )

    return ForceInterestMatchPreviewResponse(
        candidates_scanned=preview.get("candidates_scanned", 0),
        results=results,
    )


@router.post("/notifications/digest/send-now", response_model=DigestSendNowResponse)
def digest_send_now(
    body: DigestSendNowRequest,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """Admin override: ship each selected user's pending activity digest
    (social activity + interest matches) right now, bypassing the digest
    schedule window and the once-per-day dedup gate for just that user.
    """
    from backend.services import activity_email

    users = {
        u.id: u
        for u in session.exec(
            select(User).where(User.id.in_(body.user_ids))  # type: ignore[union-attr]
        ).all()
    }

    results: list[ForceSendUserResult] = []
    eligible_ids: set = set()
    for uid in body.user_ids:
        user = users.get(uid)
        if user is None or user.deleted_at is not None:
            results.append(
                ForceSendUserResult(user_id=uid, email="", status="skipped_not_found")
            )
            continue
        has_any_channel = (
            user.email_social_activity_enabled
            or user.email_interest_matches_enabled
            or user.push_social_activity_enabled
            or user.push_interest_matches_enabled
        )
        if not has_any_channel:
            results.append(
                ForceSendUserResult(
                    user_id=uid, email=user.email, status="skipped_disabled"
                )
            )
            continue
        eligible_ids.add(uid)

    if not eligible_ids:
        return DigestSendNowResponse(
            digests_sent=0, pushes_sent=0, stamped=0, results=results
        )

    stats = activity_email.run_once(
        force=True,
        user_ids=eligible_ids,
        max_notifications_per_user=body.max_notifications_per_user,
        resend=body.resend,
    )
    delivered = set(stats.get("delivered_recipients") or [])
    for uid in eligible_ids:
        status = "sent" if str(uid) in delivered else "no_pending_notifications"
        results.append(
            ForceSendUserResult(user_id=uid, email=users[uid].email, status=status)
        )

    return DigestSendNowResponse(
        digests_sent=stats.get("digests", 0),
        pushes_sent=stats.get("pushed", 0),
        stamped=stats.get("stamped", 0),
        results=results,
    )


@router.get("/sync-jobs/current")
def get_current_sync_job(_admin: dict = Depends(require_admin)):
    job = get_sync_job_service().get_current_job()
    if job is None:
        return {"status": SyncJobStatus.IDLE}
    return job


@router.get("/sync-jobs/{job_id}")
def get_sync_job(job_id: str, _admin: dict = Depends(require_admin)):
    try:
        return get_sync_job_service().get_job(job_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Sync job not found") from exc


@router.get("/sync-jobs", response_model=SyncJobListResponse)
def list_sync_jobs(
    limit: int = Query(default=20, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    _admin: dict = Depends(require_admin),
):
    return get_sync_job_service().list_jobs(limit=limit, offset=offset)


@router.post("/sync-jobs/{job_id}/abort")
def abort_sync_job(job_id: str, _admin: dict = Depends(require_admin)):
    try:
        return get_sync_job_service().abort_job(job_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Sync job not found") from exc


@router.post("/sync-jobs/{job_id}/retry-calendar")
def retry_calendar_in_job(
    job_id: str,
    calendar_id: str = Query(..., min_length=1),
    request: Request = None,
    _admin: dict = Depends(require_admin),
):
    """Re-run an incremental sync for a single calendar that failed in a prior job.

    Validates that the calendar exists and is enabled. Starts a new sync job
    scoped to this single calendar. Returns 409 if another sync job is already
    running, 404 if the calendar is unknown, 400 if it is disabled.
    """
    job_service = get_sync_job_service()
    calendar_service = request.app.state.calendar_service

    # Validate calendar exists & is enabled — fail fast with a clear error.
    from backend.db.database import get_engine

    engine = get_engine()
    with Session(engine) as session:
        cal = session.get(CalendarSetting, calendar_id)
        if cal is None:
            raise HTTPException(status_code=404, detail="Calendar not found")
        if not cal.enabled:
            raise HTTPException(
                status_code=400,
                detail=f"Calendar '{cal.name or calendar_id}' is disabled — enable it before retrying.",
            )

    try:
        job = job_service.start_job(
            worker=lambda jid, service: _run_sync_job_worker(
                jid,
                service,
                calendar_service,
                "incremental",
                None,
                [calendar_id],
            ),
            mode="incremental",
            since_date=None,
            calendar_ids=[calendar_id],
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    return job


@router.post("/calendars/{calendar_id}/toggle", response_model=CalendarSettingResponse)
def toggle_calendar(
    calendar_id: str,
    body: CalendarToggleRequest,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    cal = session.get(CalendarSetting, calendar_id)
    if not cal:
        raise HTTPException(status_code=404, detail="Calendar not found")
    if body.enabled is not None:
        cal.enabled = body.enabled
    if body.color is not None:
        cal.color = body.color
    if body.name is not None:
        cal.name = body.name
    session.add(cal)
    session.commit()
    session.refresh(cal)
    return cal


@router.get("/most-viewed-events")
def most_viewed_events(
    limit: int = 20,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    results = session.exec(
        select(
            EventView.event_id,
            func.count(EventView.id).label("view_count"),
            func.count(func.distinct(EventView.device_id)).label("unique_viewers"),
        )
        .group_by(EventView.event_id)
        .order_by(func.count(EventView.id).desc())
        .limit(limit)
    ).all()

    # Enrich with event titles
    event_ids = [r[0] for r in results]
    events_map: dict[str, CachedEvent] = {}
    if event_ids:
        evts = session.exec(
            select(CachedEvent).where(CachedEvent.event_id.in_(event_ids))
        ).all()
        events_map = {e.event_id: e for e in evts}

    return [
        {
            "event_id": r[0],
            "title": events_map[r[0]].title if r[0] in events_map else "Unknown",
            "view_count": r[1],
            "unique_viewers": r[2],
        }
        for r in results
    ]


@router.get("/analytics/source-breakdown")
def analytics_source_breakdown(
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """Aggregate EventView by source channel."""
    results = session.exec(
        select(
            func.coalesce(EventView.source, "direct").label("source"),
            func.count(EventView.id).label("view_count"),
        )
        .group_by(func.coalesce(EventView.source, "direct"))
        .order_by(func.count(EventView.id).desc())
    ).all()
    return [{"source": r[0], "view_count": r[1]} for r in results]


@router.get("/analytics/top-countries")
def analytics_top_countries(
    limit: int = 10,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """Aggregate EventView by visitor country."""
    results = session.exec(
        select(
            EventView.country,
            func.count(EventView.id).label("view_count"),
        )
        .where(EventView.country.is_not(None))
        .group_by(EventView.country)
        .order_by(func.count(EventView.id).desc())
        .limit(limit)
    ).all()
    return [{"country": r[0], "view_count": r[1]} for r in results]


@router.get("/analytics/top-links")
def analytics_top_links(
    limit: int = 20,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """Aggregate EventLinkClick by URL with event title."""
    results = session.exec(
        select(
            EventLinkClick.event_id,
            EventLinkClick.url,
            func.count(EventLinkClick.id).label("click_count"),
        )
        .group_by(EventLinkClick.event_id, EventLinkClick.url)
        .order_by(func.count(EventLinkClick.id).desc())
        .limit(limit)
    ).all()

    event_ids = list({r[0] for r in results})
    events_map: dict[str, CachedEvent] = {}
    if event_ids:
        evts = session.exec(
            select(CachedEvent).where(CachedEvent.event_id.in_(event_ids))
        ).all()
        events_map = {e.event_id: e for e in evts}

    return [
        {
            "event_id": r[0],
            "event_title": events_map[r[0]].title if r[0] in events_map else "Unknown",
            "url": r[1],
            "click_count": r[2],
        }
        for r in results
    ]


@router.get("/analytics/exports")
def analytics_exports(
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """Aggregate EventExport by format."""
    results = session.exec(
        select(
            EventExport.format,
            func.count(EventExport.id).label("export_count"),
            func.sum(EventExport.event_count).label("total_events_exported"),
        )
        .group_by(EventExport.format)
        .order_by(func.count(EventExport.id).desc())
    ).all()
    return [
        {
            "format": r[0],
            "export_count": r[1],
            "total_events_exported": r[2] or 0,
        }
        for r in results
    ]


@router.get("/most-saved-events")
def most_saved_events(
    limit: int = 20,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """Top events by net save count (saves minus unsaves per device)."""
    from sqlalchemy import case, literal_column

    # Count net saves: for each (event_id, device_id), check if latest action is "save"
    # Simpler approach: count saves minus unsaves per event
    save_counts = session.exec(
        select(
            EventSave.event_id,
            func.sum(
                case(
                    (EventSave.action == "save", 1),
                    (EventSave.action == "unsave", -1),
                    else_=0,
                )
            ).label("save_count"),
        )
        .group_by(EventSave.event_id)
        .having(
            func.sum(
                case(
                    (EventSave.action == "save", 1),
                    (EventSave.action == "unsave", -1),
                    else_=0,
                )
            )
            > 0
        )
        .order_by(
            func.sum(
                case(
                    (EventSave.action == "save", 1),
                    (EventSave.action == "unsave", -1),
                    else_=0,
                )
            ).desc()
        )
        .limit(limit)
    ).all()

    # Enrich with event titles
    event_ids = [r[0] for r in save_counts]
    events_map: dict[str, CachedEvent] = {}
    if event_ids:
        evts = session.exec(
            select(CachedEvent).where(CachedEvent.event_id.in_(event_ids))
        ).all()
        events_map = {e.event_id: e for e in evts}

    return [
        {
            "event_id": r[0],
            "title": events_map[r[0]].title if r[0] in events_map else "Unknown",
            "start": events_map[r[0]].start.isoformat() if r[0] in events_map else None,
            "save_count": r[1],
        }
        for r in save_counts
    ]


@router.get("/most-attended-events")
def most_attended_events(
    limit: int = 20,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """Top events by net going count (going minus not_going per device)."""
    from sqlalchemy import case

    going_counts = session.exec(
        select(
            EventAttendance.event_id,
            func.sum(
                case(
                    (EventAttendance.action == "going", 1),
                    (EventAttendance.action == "not_going", -1),
                    else_=0,
                )
            ).label("going_count"),
        )
        .group_by(EventAttendance.event_id)
        .having(
            func.sum(
                case(
                    (EventAttendance.action == "going", 1),
                    (EventAttendance.action == "not_going", -1),
                    else_=0,
                )
            )
            > 0
        )
        .order_by(
            func.sum(
                case(
                    (EventAttendance.action == "going", 1),
                    (EventAttendance.action == "not_going", -1),
                    else_=0,
                )
            ).desc()
        )
        .limit(limit)
    ).all()

    event_ids = [r[0] for r in going_counts]
    events_map: dict[str, CachedEvent] = {}
    if event_ids:
        evts = session.exec(
            select(CachedEvent).where(CachedEvent.event_id.in_(event_ids))
        ).all()
        events_map = {e.event_id: e for e in evts}

    return [
        {
            "event_id": r[0],
            "title": events_map[r[0]].title if r[0] in events_map else "Unknown",
            "start": events_map[r[0]].start.isoformat() if r[0] in events_map else None,
            "going_count": r[1],
        }
        for r in going_counts
    ]


@router.get("/sync-logs", response_model=list[SyncLogResponse])
def list_sync_logs(
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """List recent sync logs, newest first."""
    logs = session.exec(
        select(SyncLog)
        .order_by(col(SyncLog.started_at).desc())
        .offset(offset)
        .limit(limit)
    ).all()
    return logs


@router.get("/events", response_model=PaginatedEventsResponse)
def list_admin_events(
    limit: int = Query(default=25, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    search: Optional[str] = Query(default=None, max_length=200),
    review_status: Optional[str] = Query(default=None, pattern="^(pending|reviewed)$"),
    calendar_id: Optional[str] = Query(default=None),
    tag_ids: Optional[str] = Query(default=None),
    ungeolocated: Optional[bool] = Query(default=None),
    future_only: Optional[bool] = Query(default=None),
    include_past: bool = Query(default=False),
    visibility: Optional[str] = Query(default=None, pattern="^(hidden|blocked)$"),
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """List non-deleted events with pagination and filters.

    By default returns only events whose ``end > now`` (upcoming + in progress).
    Pass ``include_past=true`` to include finished events.
    """
    from sqlalchemy import cast, String

    calendars = session.exec(select(CalendarSetting)).all()
    color_map = {c.calendar_id: c.color for c in calendars}

    # Build base query
    base = select(CachedEvent).where(CachedEvent.deleted_at == None)

    if review_status:
        base = base.where(CachedEvent.review_status == review_status)
    if calendar_id:
        base = base.where(CachedEvent.calendar_id == calendar_id)
    if ungeolocated:
        base = base.where(
            CachedEvent.location != None,
            CachedEvent.latitude == None,
        )
    base = _apply_upcoming_filter(
        base, include_past=include_past, future_only=future_only
    )
    if search:
        pattern = f"%{search}%"
        base = base.where(
            (CachedEvent.title.ilike(pattern))
            | (CachedEvent.description.ilike(pattern))
            | (CachedEvent.location.ilike(pattern))
            | (cast(CachedEvent.links, String).ilike(pattern))
        )
    if tag_ids:
        tid_list = [int(t) for t in tag_ids.split(",") if t.strip().isdigit()]
        if tid_list:
            matching_event_ids = session.exec(
                select(EventTag.event_id)
                .where(EventTag.tag_id.in_(tid_list))
                .distinct()
            ).all()
            base = base.where(CachedEvent.event_id.in_(matching_event_ids))

    if visibility == "blocked":
        blocked_subq = select(BlockedEvent.event_id)
        base = base.where(CachedEvent.event_id.in_(blocked_subq))
    elif visibility == "hidden":
        blocked_subq = select(BlockedEvent.event_id)
        base = base.where(CachedEvent.is_hidden == True).where(
            ~CachedEvent.event_id.in_(blocked_subq)
        )

    # Count total matching
    count_stmt = select(func.count()).select_from(base.subquery())
    total = session.exec(count_stmt).one()

    # Fetch page
    events = session.exec(
        base.order_by(CachedEvent.start).offset(offset).limit(limit)
    ).all()

    event_ids = [e.event_id for e in events]
    tags_map = get_event_tags(session, event_ids)

    items = [
        EventResponse(
            event_id=e.event_id,
            calendar_id=e.calendar_id,
            title=e.title,
            description=e.description,
            location=e.location,
            start=e.start,
            end=e.end,
            all_day=e.all_day,
            latitude=e.latitude,
            longitude=e.longitude,
            color=color_map.get(e.calendar_id),
            price_min=e.price_min,
            price_max=e.price_max,
            price_currency=e.price_currency,
            price_is_free=e.price_is_free,
            review_status=e.review_status,
            links=e.links,
            tags=tags_map.get(e.event_id, []),
            is_hidden=e.is_hidden,
            is_blocked=_is_event_blocked(session, e.event_id),
        )
        for e in events
    ]

    return PaginatedEventsResponse(items=items, total=total)


@router.patch("/events/{event_id}", response_model=EventResponse)
def update_event(
    event_id: str,
    body: EventUpdateRequest,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """Update fields of an event. Geocodes location if changed without explicit lat/lng."""
    event = session.get(CachedEvent, event_id)
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    update_data = body.model_dump(exclude_unset=True)

    # Handle tag_ids separately
    tag_ids = update_data.pop("tag_ids", None)

    # Validate calendar_id (if changing) refers to an existing calendar
    if "calendar_id" in update_data and update_data["calendar_id"] != event.calendar_id:
        target_cal = session.get(CalendarSetting, update_data["calendar_id"])
        if not target_cal:
            raise HTTPException(status_code=400, detail="Unknown calendar_id")

    location_changed = (
        "location" in update_data and update_data["location"] != event.location
    )
    coords_provided = "latitude" in update_data or "longitude" in update_data

    for field, value in update_data.items():
        setattr(event, field, value)

    # Auto-geocode if location changed but no coordinates were explicitly given
    if location_changed and not coords_provided and event.location:
        coords = geocode_location(event.location)
        if coords:
            event.latitude, event.longitude = coords

    from datetime import datetime as dt

    event.updated_at = dt.utcnow()
    session.add(event)

    # Update tags if provided
    if tag_ids is not None:
        existing_ets = session.exec(
            select(EventTag).where(EventTag.event_id == event_id)
        ).all()
        for et in existing_ets:
            session.delete(et)
        for tid in tag_ids:
            tag = session.get(Tag, tid)
            if tag:
                session.add(EventTag(event_id=event_id, tag_id=tid))

    session.commit()
    session.refresh(event)

    cal = session.get(CalendarSetting, event.calendar_id)
    event_tags = get_event_tags(session, [event_id])
    return EventResponse(
        event_id=event.event_id,
        calendar_id=event.calendar_id,
        title=event.title,
        description=event.description,
        location=event.location,
        start=event.start,
        end=event.end,
        all_day=event.all_day,
        latitude=event.latitude,
        longitude=event.longitude,
        color=cal.color if cal else None,
        price_min=event.price_min,
        price_max=event.price_max,
        price_currency=event.price_currency,
        price_is_free=event.price_is_free,
        review_status=event.review_status,
        links=event.links,
        tags=event_tags.get(event_id, []),
        is_hidden=event.is_hidden,
        is_blocked=_is_event_blocked(session, event_id),
    )


@router.get("/geocode", response_model=list[GeocodeSuggestion])
def geocode_search(
    q: str = Query(..., min_length=3, max_length=200),
    _admin: dict = Depends(require_admin),
):
    """Search for address suggestions. Uses Google Geocoding API if configured, else Nominatim."""
    results = search_locations(q, limit=5)
    return [
        GeocodeSuggestion(
            display_name=r["display_name"],
            latitude=r["latitude"],
            longitude=r["longitude"],
        )
        for r in results
    ]


@router.get("/events/filter-options", response_model=EventFilterOptionsResponse)
def event_filter_options(
    search: Optional[str] = Query(default=None, max_length=200),
    review_status: Optional[str] = Query(default=None, pattern="^(pending|reviewed)$"),
    calendar_id: Optional[str] = Query(default=None),
    tag_ids: Optional[str] = Query(default=None),
    ungeolocated: Optional[bool] = Query(default=None),
    future_only: Optional[bool] = Query(default=None),
    include_past: bool = Query(default=False),
    visibility: Optional[str] = Query(default=None, pattern="^(hidden|blocked)$"),
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """Return available filter values with counts, scoped to current filters.

    Defaults to upcoming-only (``end > now``); pass ``include_past=true`` to
    aggregate over the full archive.
    """
    from sqlalchemy import cast, String, case, and_, literal_column

    # Build filtered base (same logic as list_admin_events)
    base = select(CachedEvent).where(CachedEvent.deleted_at == None)
    if review_status:
        base = base.where(CachedEvent.review_status == review_status)
    if calendar_id:
        base = base.where(CachedEvent.calendar_id == calendar_id)
    if ungeolocated:
        base = base.where(CachedEvent.location != None, CachedEvent.latitude == None)
    base = _apply_upcoming_filter(
        base, include_past=include_past, future_only=future_only
    )
    if search:
        pattern = f"%{search}%"
        base = base.where(
            (CachedEvent.title.ilike(pattern))
            | (CachedEvent.description.ilike(pattern))
            | (CachedEvent.location.ilike(pattern))
            | (cast(CachedEvent.links, String).ilike(pattern))
        )
    if tag_ids:
        tid_list = [int(t) for t in tag_ids.split(",") if t.strip().isdigit()]
        if tid_list:
            matching = session.exec(
                select(EventTag.event_id)
                .where(EventTag.tag_id.in_(tid_list))
                .distinct()
            ).all()
            base = base.where(CachedEvent.event_id.in_(matching))

    if visibility == "blocked":
        blocked_subq = select(BlockedEvent.event_id)
        base = base.where(CachedEvent.event_id.in_(blocked_subq))
    elif visibility == "hidden":
        blocked_subq = select(BlockedEvent.event_id)
        base = base.where(CachedEvent.is_hidden == True).where(
            ~CachedEvent.event_id.in_(blocked_subq)
        )

    filtered_cte = base.subquery()
    fe = filtered_cte.c

    # Total count
    total_count = session.exec(select(func.count()).select_from(filtered_cte)).one()

    # Calendar counts
    cal_rows = session.exec(
        select(fe.calendar_id, func.count())
        .select_from(filtered_cte)
        .group_by(fe.calendar_id)
    ).all()
    calendars_map = {
        c.calendar_id: c.name for c in session.exec(select(CalendarSetting)).all()
    }
    cal_options = [
        FilterOption(value=cid, label=calendars_map.get(cid, cid), count=cnt)
        for cid, cnt in cal_rows
    ]

    # Review status counts
    rs_rows = session.exec(
        select(fe.review_status, func.count())
        .select_from(filtered_cte)
        .group_by(fe.review_status)
    ).all()
    rs_options = [
        FilterOption(value=s, label=s.capitalize(), count=c) for s, c in rs_rows
    ]

    # Geo status counts
    geo_rows = session.exec(
        select(
            case(
                (and_(fe.latitude != None, fe.longitude != None), "geolocated"),
                (and_(fe.location != None, fe.latitude == None), "ungeolocated"),
                else_="no-location",
            ).label("geo_status"),
            func.count(),
        )
        .select_from(filtered_cte)
        .group_by(literal_column("geo_status"))
    ).all()
    geo_labels = {
        "geolocated": "Geolocated",
        "ungeolocated": "Ungeolocated",
        "no-location": "No Location",
    }
    geo_options = [
        FilterOption(value=s, label=geo_labels.get(s, s), count=c) for s, c in geo_rows
    ]

    # Tag counts
    tag_rows = session.exec(
        select(Tag.id, Tag.label, func.count(EventTag.event_id))
        .join(EventTag, EventTag.tag_id == Tag.id)
        .where(EventTag.event_id.in_(select(fe.event_id).select_from(filtered_cte)))
        .group_by(Tag.id, Tag.label)
    ).all()
    tag_options = [
        FilterOption(value=str(tid), label=lbl, count=c) for tid, lbl, c in tag_rows
    ]

    return EventFilterOptionsResponse(
        calendars=cal_options,
        review_statuses=rs_options,
        geo_statuses=geo_options,
        tags=tag_options,
        total_count=total_count,
    )


@router.post("/events/{event_id}/review", response_model=EventResponse)
def review_event(
    event_id: str,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """Mark a single event as reviewed."""
    event = session.get(CachedEvent, event_id)
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    event.review_status = "reviewed"
    session.add(event)
    session.commit()
    session.refresh(event)

    cal = session.get(CalendarSetting, event.calendar_id)
    event_tags = get_event_tags(session, [event_id])
    return EventResponse(
        event_id=event.event_id,
        calendar_id=event.calendar_id,
        title=event.title,
        description=event.description,
        location=event.location,
        start=event.start,
        end=event.end,
        all_day=event.all_day,
        latitude=event.latitude,
        longitude=event.longitude,
        color=cal.color if cal else None,
        price_min=event.price_min,
        price_max=event.price_max,
        price_currency=event.price_currency,
        price_is_free=event.price_is_free,
        review_status=event.review_status,
        links=event.links,
        tags=event_tags.get(event_id, []),
        is_hidden=event.is_hidden,
        is_blocked=_is_event_blocked(session, event_id),
    )


@router.post("/events/bulk-review")
def bulk_review_events(
    body: BulkEventIdsRequest,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """Mark multiple events as reviewed."""
    events = session.exec(
        select(CachedEvent).where(
            CachedEvent.event_id.in_(body.event_ids),
            CachedEvent.review_status == "pending",
            CachedEvent.deleted_at == None,
        )
    ).all()
    for event in events:
        event.review_status = "reviewed"
        session.add(event)
    session.commit()
    return {"marked_reviewed": len(events)}


@router.post("/events/bulk-retry-geocoding")
def bulk_retry_geocoding(
    body: BulkEventIdsRequest,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """Retry geocoding for selected events."""
    from backend.services.pipeline.base import EnrichmentPipeline
    from backend.services.pipeline.stages.geocoding import GeocodingStage

    events = session.exec(
        select(CachedEvent).where(
            CachedEvent.event_id.in_(body.event_ids),
            CachedEvent.location != None,
            CachedEvent.latitude == None,
            CachedEvent.deleted_at == None,
        )
    ).all()
    event_ids = [e.event_id for e in events]
    if not event_ids:
        return {"geocoded": 0, "failed": 0, "total": 0}

    pipeline = EnrichmentPipeline([GeocodingStage()])
    progress = pipeline.run(session, event_ids)
    geo = progress.stages.get("geocoding", None)
    return {
        "geocoded": geo.processed if geo else 0,
        "failed": geo.failed if geo else 0,
        "total": len(event_ids),
    }


@router.post("/events/bulk-tags")
def bulk_assign_tags(
    body: BulkTagAssignRequest,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """Assign tags to multiple events (additive — does not remove existing tags)."""
    valid_tags = session.exec(select(Tag).where(Tag.id.in_(body.tag_ids))).all()
    valid_tag_ids = {t.id for t in valid_tags}

    assigned = 0
    for event_id in body.event_ids:
        event = session.get(CachedEvent, event_id)
        if not event or event.deleted_at:
            continue
        existing = {
            et.tag_id
            for et in session.exec(
                select(EventTag).where(EventTag.event_id == event_id)
            ).all()
        }
        for tid in valid_tag_ids:
            if tid not in existing:
                session.add(EventTag(event_id=event_id, tag_id=tid))
                assigned += 1
    session.commit()
    return {
        "assigned": assigned,
        "events": len(body.event_ids),
        "tags": len(valid_tag_ids),
    }


@router.post("/events/{event_id}/retry-geocoding")
def retry_geocoding_single(
    event_id: str,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """Retry geocoding for a single event."""
    from backend.services.pipeline.base import EnrichmentPipeline
    from backend.services.pipeline.stages.geocoding import GeocodingStage

    event = session.get(CachedEvent, event_id)
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    pipeline = EnrichmentPipeline([GeocodingStage()])
    progress = pipeline.run(session, [event_id])
    geo = progress.stages.get("geocoding", None)
    return {
        "geocoded": geo.processed if geo else 0,
        "failed": geo.failed if geo else 0,
    }


# ── Auto Tag Suggestions: on-demand re-run endpoints ───────────────────


def _run_tag_suggestion_for_event(
    session: Session,
    event: CachedEvent,
    *,
    snapshot,
    replace_existing_pending: bool,
) -> tuple[int, int, list[TagSuggestion]]:
    """Generate auto tag suggestions for one event. Returns
    ``(generated, replaced, inserted_rows)``."""
    from backend.services.pipeline.stages.tag_suggestion import (
        delete_pending_ai_suggestions,
        excluded_tag_ids_for_event,
        persist_suggestions,
    )
    from backend.services.tag_suggester import suggest_tags

    replaced = 0
    if replace_existing_pending:
        replaced = delete_pending_ai_suggestions(session, event.event_id)

    excluded = excluded_tag_ids_for_event(session, event.event_id)
    candidates = suggest_tags(
        snapshot,
        title=event.title,
        description=event.description,
        location=event.location,
        excluded_tag_ids=excluded,
    )
    inserted = persist_suggestions(session, event.event_id, candidates)
    return len(inserted), replaced, inserted


@router.post(
    "/events/{event_id}/suggest-tags",
    response_model=TagSuggestionRunResponse,
)
def suggest_tags_single(
    event_id: str,
    body: TagSuggestionRunRequest | None = None,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """Generate auto tag suggestions for a single event on demand.

    Used by:
    * The admin event-detail panel auto-run when first opened.
    * The "Re-run suggestions" button (pass ``replace_existing_pending=true``).
    """
    from backend.services.tag_suggester import load_taxonomy

    body = body or TagSuggestionRunRequest()

    event = session.get(CachedEvent, event_id)
    if not event or event.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Event not found")

    snapshot = load_taxonomy(session)
    generated, replaced, inserted = _run_tag_suggestion_for_event(
        session,
        event,
        snapshot=snapshot,
        replace_existing_pending=body.replace_existing_pending,
    )
    session.commit()

    # Build response payload (refresh inserted rows so id/created_at populate).
    suggestions_payload = []
    for row in inserted:
        session.refresh(row)
        tag = session.get(Tag, row.tag_id) if row.tag_id else None
        suggestions_payload.append(
            _suggestion_to_response(row, tag=tag, event=event, event_title=event.title)
        )

    return TagSuggestionRunResponse(
        generated=generated,
        skipped=1 if (generated == 0 and replaced == 0) else 0,
        replaced=replaced,
        suggestions=suggestions_payload,
    )


@router.post(
    "/events/bulk-suggest-tags",
    response_model=BulkTagSuggestionRunResponse,
)
def suggest_tags_bulk(
    body: BulkTagSuggestionRunRequest,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """Generate auto tag suggestions for many events at once.

    Bounded at 200 events per call to keep request latency predictable;
    callers paginate larger sets.
    """
    from backend.services.tag_suggester import load_taxonomy

    if not body.event_ids:
        return BulkTagSuggestionRunResponse(
            generated=0, skipped=0, replaced=0, events_processed=0
        )
    if len(body.event_ids) > 200:
        raise HTTPException(
            status_code=400,
            detail="bulk-suggest-tags accepts at most 200 event_ids per call",
        )

    events = session.exec(
        select(CachedEvent).where(
            CachedEvent.event_id.in_(body.event_ids),
            CachedEvent.deleted_at == None,
        )
    ).all()

    snapshot = load_taxonomy(session)
    total_generated = 0
    total_replaced = 0
    total_skipped = 0
    for event in events:
        try:
            generated, replaced, _ = _run_tag_suggestion_for_event(
                session,
                event,
                snapshot=snapshot,
                replace_existing_pending=body.replace_existing_pending,
            )
            total_generated += generated
            total_replaced += replaced
            if generated == 0 and replaced == 0:
                total_skipped += 1
        except Exception:
            logger.exception("bulk-suggest-tags failed for event %s", event.event_id)
            total_skipped += 1
    session.commit()

    return BulkTagSuggestionRunResponse(
        generated=total_generated,
        skipped=total_skipped,
        replaced=total_replaced,
        events_processed=len(events),
    )


@router.get("/events/ids", response_model=EventIdsResponse)
def list_admin_event_ids(
    search: Optional[str] = Query(default=None, max_length=200),
    review_status: Optional[str] = Query(default=None, pattern="^(pending|reviewed)$"),
    calendar_id: Optional[str] = Query(default=None),
    tag_ids: Optional[str] = Query(default=None),
    ungeolocated: Optional[bool] = Query(default=None),
    future_only: Optional[bool] = Query(default=None),
    include_past: bool = Query(default=False),
    visibility: Optional[str] = Query(default=None, pattern="^(hidden|blocked)$"),
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """Return all matching event IDs (no pagination). Used for cross-page select-all.

    Defaults to upcoming-only; pass ``include_past=true`` to widen the scope.
    """
    from sqlalchemy import cast, String

    base = select(CachedEvent.event_id).where(CachedEvent.deleted_at == None)

    if review_status:
        base = base.where(CachedEvent.review_status == review_status)
    if calendar_id:
        base = base.where(CachedEvent.calendar_id == calendar_id)
    if ungeolocated:
        base = base.where(
            CachedEvent.location != None,
            CachedEvent.latitude == None,
        )
    base = _apply_upcoming_filter(
        base, include_past=include_past, future_only=future_only
    )
    if search:
        pattern = f"%{search}%"
        base = base.where(
            (CachedEvent.title.ilike(pattern))
            | (CachedEvent.description.ilike(pattern))
            | (CachedEvent.location.ilike(pattern))
            | (cast(CachedEvent.links, String).ilike(pattern))
        )
    if tag_ids:
        tid_list = [int(t) for t in tag_ids.split(",") if t.strip().isdigit()]
        if tid_list:
            matching_event_ids = session.exec(
                select(EventTag.event_id)
                .where(EventTag.tag_id.in_(tid_list))
                .distinct()
            ).all()
            base = base.where(CachedEvent.event_id.in_(matching_event_ids))

    if visibility == "blocked":
        blocked_subq = select(BlockedEvent.event_id)
        base = base.where(CachedEvent.event_id.in_(blocked_subq))
    elif visibility == "hidden":
        blocked_subq = select(BlockedEvent.event_id)
        base = base.where(CachedEvent.is_hidden == True).where(
            ~CachedEvent.event_id.in_(blocked_subq)
        )

    ids = session.exec(base).all()
    return EventIdsResponse(ids=list(ids))


@router.get(
    "/calendars/{calendar_id}/default-tags", response_model=CalendarDefaultTagsResponse
)
def get_calendar_default_tags(
    calendar_id: str,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """Get the default tag IDs configured for a calendar."""
    cal = session.get(CalendarSetting, calendar_id)
    if not cal:
        raise HTTPException(status_code=404, detail="Calendar not found")
    rows = session.exec(
        select(CalendarDefaultTag).where(CalendarDefaultTag.calendar_id == calendar_id)
    ).all()
    return CalendarDefaultTagsResponse(
        calendar_id=calendar_id, tag_ids=[r.tag_id for r in rows]
    )


@router.put(
    "/calendars/{calendar_id}/default-tags", response_model=CalendarDefaultTagsResponse
)
def set_calendar_default_tags(
    calendar_id: str,
    body: CalendarDefaultTagsUpdate,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """Replace the set of default tags for a calendar."""
    cal = session.get(CalendarSetting, calendar_id)
    if not cal:
        raise HTTPException(status_code=404, detail="Calendar not found")

    # Validate tag IDs exist
    valid_tags = session.exec(select(Tag).where(Tag.id.in_(body.tag_ids))).all()
    valid_tag_ids = {t.id for t in valid_tags}

    # Delete existing
    existing = session.exec(
        select(CalendarDefaultTag).where(CalendarDefaultTag.calendar_id == calendar_id)
    ).all()
    for row in existing:
        session.delete(row)
    session.flush()  # push DELETEs to DB before INSERTs to avoid unique constraint violation

    # Insert new
    for tid in valid_tag_ids:
        session.add(CalendarDefaultTag(calendar_id=calendar_id, tag_id=tid))

    session.commit()
    return CalendarDefaultTagsResponse(
        calendar_id=calendar_id, tag_ids=list(valid_tag_ids)
    )


@router.get("/sync-logs/{log_id}/progress")
def get_sync_log_progress(
    log_id: int,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """Get enrichment progress for a specific sync log."""
    log = session.get(SyncLog, log_id)
    if not log:
        raise HTTPException(status_code=404, detail="Sync log not found")
    return {
        "enrichment_status": log.enrichment_status,
        "enrichment_progress": log.enrichment_progress,
    }


@router.get("/events/{event_id}", response_model=EventResponse)
def get_admin_event(
    event_id: str,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """Fetch a single event for the admin panel, including hidden/blocked events."""
    event = session.get(CachedEvent, event_id)
    if not event or event.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Event not found")

    cal = session.get(CalendarSetting, event.calendar_id)
    event_tags = get_event_tags(session, [event_id])
    return EventResponse(
        event_id=event.event_id,
        calendar_id=event.calendar_id,
        title=event.title,
        description=event.description,
        location=event.location,
        start=event.start,
        end=event.end,
        all_day=event.all_day,
        latitude=event.latitude,
        longitude=event.longitude,
        color=cal.color if cal else None,
        price_min=event.price_min,
        price_max=event.price_max,
        price_currency=event.price_currency,
        price_is_free=event.price_is_free,
        review_status=event.review_status,
        links=event.links,
        tags=event_tags.get(event_id, []),
        is_hidden=event.is_hidden,
        is_blocked=_is_event_blocked(session, event_id),
    )


@router.post("/events/{event_id}/block", response_model=EventResponse)
def block_event(
    event_id: str,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """Permanently suppress an event.

    Sets ``is_hidden=True`` on the event and inserts a row into
    ``blocked_events`` so subsequent sync runs skip this event_id.
    """
    event = session.get(CachedEvent, event_id)
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    event.is_hidden = True
    from datetime import datetime as _dt

    event.updated_at = _dt.utcnow()
    session.add(event)

    if not session.get(BlockedEvent, event_id):
        session.add(BlockedEvent(event_id=event_id))

    session.commit()
    session.refresh(event)

    cal = session.get(CalendarSetting, event.calendar_id)
    event_tags = get_event_tags(session, [event_id])
    return EventResponse(
        event_id=event.event_id,
        calendar_id=event.calendar_id,
        title=event.title,
        description=event.description,
        location=event.location,
        start=event.start,
        end=event.end,
        all_day=event.all_day,
        latitude=event.latitude,
        longitude=event.longitude,
        color=cal.color if cal else None,
        price_min=event.price_min,
        price_max=event.price_max,
        price_currency=event.price_currency,
        price_is_free=event.price_is_free,
        review_status=event.review_status,
        links=event.links,
        tags=event_tags.get(event_id, []),
        is_hidden=event.is_hidden,
        is_blocked=True,
    )


@router.delete("/events/{event_id}/block", response_model=EventResponse)
def unblock_event(
    event_id: str,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """Restore a permanently suppressed event.

    Removes the ``blocked_events`` row and sets ``is_hidden=False``.
    The event will reappear on the next Google Calendar sync if it still
    exists in the source calendar.
    """
    event = session.get(CachedEvent, event_id)
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    blocked = session.get(BlockedEvent, event_id)
    if blocked:
        session.delete(blocked)

    event.is_hidden = False
    from datetime import datetime as _dt

    event.updated_at = _dt.utcnow()
    session.add(event)
    session.commit()
    session.refresh(event)

    cal = session.get(CalendarSetting, event.calendar_id)
    event_tags = get_event_tags(session, [event_id])
    return EventResponse(
        event_id=event.event_id,
        calendar_id=event.calendar_id,
        title=event.title,
        description=event.description,
        location=event.location,
        start=event.start,
        end=event.end,
        all_day=event.all_day,
        latitude=event.latitude,
        longitude=event.longitude,
        color=cal.color if cal else None,
        price_min=event.price_min,
        price_max=event.price_max,
        price_currency=event.price_currency,
        price_is_free=event.price_is_free,
        review_status=event.review_status,
        links=event.links,
        tags=event_tags.get(event_id, []),
        is_hidden=event.is_hidden,
        is_blocked=False,
    )


# --- Admin: bulk engagement curation ----------------------------------------


@router.post("/engagement/bulk", response_model=AdminBulkEngagementResponse)
def admin_bulk_engagement(
    payload: AdminBulkEngagementRequest,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
) -> AdminBulkEngagementResponse:
    """Bulk add/remove Saved or Going entries for admin-managed accounts.

    Applies ``(kind, action)`` to the cross-product of ``handles`` x
    ``event_ids``. Targets that are not flagged ``is_admin_managed`` are
    skipped per-row (never raised) so the admin can correct data and
    re-run. ``audience`` is per-row and defaults to each target's own
    ``share_attendance_default_audience`` when omitted. ``fan_out`` is
    opt-in — curated Going entries are silent by default.
    """
    from backend.api.deps import get_admin_user_id
    from backend.services.admin_curation import bulk_set_engagement

    admin_user_id = get_admin_user_id(session)
    result = bulk_set_engagement(
        session,
        handles=payload.handles,
        event_ids=payload.event_ids,
        kind=payload.kind,
        action=payload.action,
        audience=payload.audience,
        fan_out=payload.fan_out,
        admin_user_id=admin_user_id,
    )
    session.commit()
    return AdminBulkEngagementResponse(
        items=[
            AdminBulkEngagementItem(
                handle=i.handle,
                event_id=i.event_id,
                status=i.status,
                detail=i.detail,
            )
            for i in result.items
        ],
        changed_count=result.changed_count,
        skipped_count=result.skipped_count,
    )


# --- Admin: per-calendar curation rules -------------------------------------


def _serialize_rule(
    rule: CalendarCurationRule, handle: Optional[str]
) -> CalendarCurationRuleResponse:
    return CalendarCurationRuleResponse(
        id=rule.id,  # type: ignore[arg-type]
        calendar_id=rule.calendar_id,
        target_user_id=str(rule.target_user_id),
        target_handle=handle,
        kind=rule.kind,  # type: ignore[arg-type]
        audience=rule.audience,  # type: ignore[arg-type]
        enabled=rule.enabled,
    )


def _require_calendar(session: Session, calendar_id: str) -> CalendarSetting:
    cal = session.get(CalendarSetting, calendar_id)
    if cal is None:
        raise HTTPException(status_code=404, detail="calendar_not_found")
    return cal


def _resolve_target_or_404(session: Session, handle: str) -> User:
    handle_norm = handle.lstrip("@").strip()
    if not handle_norm:
        raise HTTPException(status_code=400, detail="invalid_handle")
    target = session.exec(
        select(User).where(func.lower(User.handle) == handle_norm.lower())
    ).first()
    if target is None or target.deleted_at is not None:
        raise HTTPException(status_code=404, detail="target_user_not_found")
    if not bool(getattr(target, "is_admin_managed", False)):
        raise HTTPException(status_code=409, detail="target_not_admin_managed")
    return target


@router.get(
    "/calendars/{calendar_id}/curation-rules",
    response_model=list[CalendarCurationRuleResponse],
)
def list_calendar_curation_rules(
    calendar_id: str,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
) -> list[CalendarCurationRuleResponse]:
    _require_calendar(session, calendar_id)
    rules = session.exec(
        select(CalendarCurationRule)
        .where(CalendarCurationRule.calendar_id == calendar_id)
        .order_by(CalendarCurationRule.id)
    ).all()
    if not rules:
        return []
    target_ids = {r.target_user_id for r in rules}
    users = session.exec(select(User).where(User.id.in_(target_ids))).all()
    handles = {u.id: u.handle for u in users}
    return [_serialize_rule(r, handles.get(r.target_user_id)) for r in rules]


@router.post(
    "/calendars/{calendar_id}/curation-rules",
    response_model=CalendarCurationRuleResponse,
)
def create_calendar_curation_rule(
    calendar_id: str,
    payload: CalendarCurationRuleCreateRequest,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
) -> CalendarCurationRuleResponse:
    _require_calendar(session, calendar_id)
    target = _resolve_target_or_404(session, payload.target_handle)
    # Unique on (calendar_id, target, kind) — upsert-friendly: if a rule
    # exists, mutate it (lets admin re-create after disabling).
    existing = session.exec(
        select(CalendarCurationRule).where(
            CalendarCurationRule.calendar_id == calendar_id,
            CalendarCurationRule.target_user_id == target.id,
            CalendarCurationRule.kind == payload.kind,
        )
    ).first()
    if existing is not None:
        existing.audience = payload.audience
        existing.enabled = payload.enabled
        session.add(existing)
        session.commit()
        session.refresh(existing)
        return _serialize_rule(existing, target.handle)
    rule = CalendarCurationRule(
        calendar_id=calendar_id,
        target_user_id=target.id,
        kind=payload.kind,
        audience=payload.audience,
        enabled=payload.enabled,
    )
    session.add(rule)
    session.commit()
    session.refresh(rule)
    return _serialize_rule(rule, target.handle)


@router.patch(
    "/calendars/{calendar_id}/curation-rules/{rule_id}",
    response_model=CalendarCurationRuleResponse,
)
def update_calendar_curation_rule(
    calendar_id: str,
    rule_id: int,
    payload: CalendarCurationRuleUpdateRequest,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
) -> CalendarCurationRuleResponse:
    rule = session.get(CalendarCurationRule, rule_id)
    if rule is None or rule.calendar_id != calendar_id:
        raise HTTPException(status_code=404, detail="rule_not_found")
    if "audience" in payload.model_fields_set:
        rule.audience = payload.audience
    if payload.enabled is not None:
        rule.enabled = payload.enabled
    session.add(rule)
    session.commit()
    session.refresh(rule)
    target = session.get(User, rule.target_user_id)
    return _serialize_rule(rule, target.handle if target else None)


@router.delete(
    "/calendars/{calendar_id}/curation-rules/{rule_id}",
    status_code=204,
)
def delete_calendar_curation_rule(
    calendar_id: str,
    rule_id: int,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
) -> None:
    rule = session.get(CalendarCurationRule, rule_id)
    if rule is None or rule.calendar_id != calendar_id:
        raise HTTPException(status_code=404, detail="rule_not_found")
    session.delete(rule)
    session.commit()
