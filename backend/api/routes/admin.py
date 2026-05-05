import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlmodel import Session, col, func, select

logger = logging.getLogger(__name__)

from backend.api.deps import require_admin
from backend.api.schemas import (
    BulkEventIdsRequest,
    BulkTagAssignRequest,
    CalendarAddRequest,
    CalendarDefaultTagsResponse,
    CalendarDefaultTagsUpdate,
    CalendarSettingResponse,
    CalendarToggleRequest,
    EventFilterOptionsResponse,
    EventIdsResponse,
    EventResponse,
    EventUpdateRequest,
    FilterOption,
    GeocodeSuggestion,
    PaginatedEventsResponse,
    SyncJobListResponse,
    SyncJobStartRequest,
    SyncLogResponse,
)
from backend.api.routes.tags import get_event_tags
from backend.db.database import get_engine, get_session
from backend.db.models import (
    CalendarDefaultTag,
    CachedEvent,
    CalendarSetting,
    EventAttendance,
    EventLinkClick,
    EventExport,
    EventSave,
    EventTag,
    EventView,
    SyncLog,
    Tag,
    UserEventAttendance,
)
from backend.services.geocoding import geocode_location, search_locations
from backend.services.sync_job_service import SyncJobStatus, get_sync_job_service
from backend.services.sync_service import SyncService

router = APIRouter(prefix="/api/admin", tags=["admin"])

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
            calendars = session.exec(
                select(CalendarSetting).where(CalendarSetting.enabled == True)
            ).all()
            for cal in calendars:
                cal.sync_token = None
                session.add(cal)
            session.commit()
        job_service.set_metadata(job_id, reseed_applied=True, since_date=since_date)

    # --- Load enabled calendars ---
    with Session(engine) as session:
        enabled = session.exec(
            select(CalendarSetting).where(CalendarSetting.enabled == True)
        ).all()
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
        job_service.heartbeat(job_id)

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
    total_errors = sum(p.error_count for p in progress_map.values())
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

    if calendars_failed > 0 or total_errors > 0:
        return {
            "status": SyncJobStatus.WARNING,
            "warning_message": (
                f"{calendars_failed} calendar(s) failed, {total_errors} event error(s)"
            ),
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
    if body.calendar_ids:
        raise HTTPException(
            status_code=400,
            detail="calendar_ids filtering is not implemented yet",
        )

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
            ),
            mode=body.mode,
            since_date=body.since_date,
            calendar_ids=body.calendar_ids,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    return job


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
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """List non-deleted events with pagination and filters."""
    from datetime import datetime as dt
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
    if future_only:
        base = base.where(CachedEvent.start > dt.utcnow())
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
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """Return available filter values with counts, scoped to current filters."""
    from datetime import datetime as dt
    from sqlalchemy import cast, String, case, and_, literal_column

    # Build filtered base (same logic as list_admin_events)
    base = select(CachedEvent).where(CachedEvent.deleted_at == None)
    if review_status:
        base = base.where(CachedEvent.review_status == review_status)
    if calendar_id:
        base = base.where(CachedEvent.calendar_id == calendar_id)
    if ungeolocated:
        base = base.where(CachedEvent.location != None, CachedEvent.latitude == None)
    if future_only:
        base = base.where(CachedEvent.start > dt.utcnow())
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


@router.get("/events/ids", response_model=EventIdsResponse)
def list_admin_event_ids(
    search: Optional[str] = Query(default=None, max_length=200),
    review_status: Optional[str] = Query(default=None, pattern="^(pending|reviewed)$"),
    calendar_id: Optional[str] = Query(default=None),
    tag_ids: Optional[str] = Query(default=None),
    ungeolocated: Optional[bool] = Query(default=None),
    future_only: Optional[bool] = Query(default=None),
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """Return all matching event IDs (no pagination). Used for cross-page select-all."""
    from datetime import datetime as dt
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
    if future_only:
        base = base.where(CachedEvent.start > dt.utcnow())
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
