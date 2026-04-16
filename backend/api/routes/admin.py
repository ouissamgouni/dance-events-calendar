import logging

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlmodel import Session, col, func, select

logger = logging.getLogger(__name__)

from backend.api.deps import require_admin
from backend.api.schemas import (
    CalendarAddRequest,
    CalendarSettingResponse,
    CalendarToggleRequest,
    EventResponse,
    EventUpdateRequest,
    GeocodeSuggestion,
    SyncLogResponse,
)
from backend.db.database import get_session
from backend.db.models import CachedEvent, CalendarSetting, EventSave, EventView, SyncLog
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
    return [{"event_id": r[0], "view_count": r[1]} for r in results]


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


@router.get("/events", response_model=list[EventResponse])
def list_admin_events(
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """List all non-deleted events for admin management."""
    calendars = session.exec(select(CalendarSetting)).all()
    color_map = {c.calendar_id: c.color for c in calendars}

    events = session.exec(
        select(CachedEvent)
        .where(CachedEvent.deleted_at == None)
        .order_by(CachedEvent.start)
    ).all()

    return [
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
        )
        for e in events
    ]


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
    session.commit()
    session.refresh(event)

    cal = session.get(CalendarSetting, event.calendar_id)
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
    )


@router.get("/geocode", response_model=list[GeocodeSuggestion])
def geocode_search(
    q: str = Query(..., min_length=3, max_length=200),
    _admin: dict = Depends(require_admin),
):
    """Search for address suggestions using Nominatim. Returns up to 5 results."""
    from geopy.geocoders import Nominatim
    from geopy.exc import GeocoderTimedOut, GeocoderServiceError

    geocoder = Nominatim(user_agent="salsa-events-calendar", timeout=5)
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


@router.get("/events/pending", response_model=list[EventResponse])
def list_pending_events(
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """List future pending-review events."""
    from datetime import datetime as dt

    calendars = session.exec(select(CalendarSetting)).all()
    color_map = {c.calendar_id: c.color for c in calendars}

    events = session.exec(
        select(CachedEvent)
        .where(
            CachedEvent.review_status == "pending",
            CachedEvent.deleted_at == None,
            CachedEvent.start > dt.utcnow(),
        )
        .order_by(CachedEvent.start)
    ).all()

    return [
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
        )
        for e in events
    ]


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
    )


@router.post("/events/mark-all-reviewed")
def mark_all_reviewed(
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """Mark all pending events as reviewed."""
    from datetime import datetime as dt

    events = session.exec(
        select(CachedEvent).where(
            CachedEvent.review_status == "pending",
            CachedEvent.deleted_at == None,
        )
    ).all()

    count = 0
    for event in events:
        event.review_status = "reviewed"
        session.add(event)
        count += 1

    session.commit()
    return {"marked_reviewed": count}
