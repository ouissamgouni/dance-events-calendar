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
    CalendarSettingResponse,
    CalendarToggleRequest,
    EventFilterOptionsResponse,
    EventResponse,
    EventUpdateRequest,
    FilterOption,
    GeocodeSuggestion,
    PaginatedEventsResponse,
    SyncLogResponse,
)
from backend.api.routes.tags import get_event_tags
from backend.db.database import get_session
from backend.db.models import (
    CachedEvent,
    CalendarSetting,
    EventSave,
    EventTag,
    EventView,
    SyncLog,
    Tag,
)
from backend.services.geocoding import geocode_location
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
    """Add a calendar by ID. Verifies the service account can access it."""
    # Check if already exists
    existing = session.get(CalendarSetting, body.calendar_id)
    if existing:
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
        enabled=False,
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


@router.post("/sync")
def trigger_sync(
    request: Request,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """Manually trigger a sync for all enabled calendars."""
    calendar_service = request.app.state.calendar_service
    sync_service = SyncService(calendar_service)
    try:
        stats = sync_service.sync_all(session, trigger="manual")
    except FileNotFoundError as exc:
        logger.exception("Service account file not found")
        raise HTTPException(
            status_code=502, detail=f"Service account file not found: {exc}"
        ) from exc
    except Exception as exc:
        logger.exception("Failed to sync calendars")
        raise HTTPException(
            status_code=502, detail=f"Calendar service error: {exc}"
        ) from exc
    return stats


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
        select(EventView.event_id, func.count(EventView.id).label("view_count"))
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
    """Search for address suggestions using Nominatim. Returns up to 5 results."""
    from geopy.geocoders import Nominatim
    from geopy.exc import GeocoderTimedOut, GeocoderServiceError

    geocoder = Nominatim(user_agent="movida", timeout=5)
    try:
        results = geocoder.geocode(q, exactly_one=False, limit=5)
    except (GeocoderTimedOut, GeocoderServiceError) as e:
        logger.warning("Geocode search failed: %s", e)
        return []
    except Exception:
        logger.exception("Unexpected geocode search error")
        return []

    if not results:
        return []

    return [
        GeocodeSuggestion(
            display_name=r.address,
            latitude=r.latitude,
            longitude=r.longitude,
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
