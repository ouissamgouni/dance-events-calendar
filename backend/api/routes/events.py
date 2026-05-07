from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response
from slowapi import Limiter
from sqlalchemy import func
from sqlmodel import Session, select

from backend.api.rate_limit import client_ip
from backend.api.routes.settings import _get_since_date
from backend.api.schemas import (
    CalendarSettingResponse,
    EventBatchRequest,
    EventResponse,
)
from backend.api.routes.tags import get_event_tags
from backend.db.database import get_session
from backend.db.models import CachedEvent, CalendarSetting, EventTag, EventView

router = APIRouter(prefix="/api/events", tags=["events"])

limiter = Limiter(key_func=client_ip)


@router.get("/calendars", response_model=list[CalendarSettingResponse])
@limiter.limit("300/minute")
def get_calendars(
    request: Request,
    session: Session = Depends(get_session),
):
    """Public list of enabled calendars with name and color."""
    calendars = session.exec(
        select(CalendarSetting).where(CalendarSetting.enabled == True)
    ).all()
    return calendars


@router.get("", response_model=list[EventResponse])
@limiter.limit("300/minute")
def get_events(
    request: Request,
    session: Session = Depends(get_session),
    start_date: Optional[str] = Query(
        None, description="Filter events starting from this date (YYYY-MM-DD)"
    ),
    end_date: Optional[str] = Query(
        None, description="Filter events up to this date (YYYY-MM-DD)"
    ),
    tag_ids: Optional[str] = Query(
        None, description="Comma-separated tag IDs to filter by (AND logic)"
    ),
):
    since_date = _get_since_date(session)
    since_dt = datetime.fromisoformat(since_date)

    # Determine effective date range
    effective_start = since_dt
    if start_date:
        start_dt = datetime.fromisoformat(start_date)
        effective_start = max(since_dt, start_dt)

    enabled_calendars = session.exec(
        select(CalendarSetting).where(CalendarSetting.enabled == True)
    ).all()
    calendar_ids = [c.calendar_id for c in enabled_calendars]
    color_map = {c.calendar_id: c.color for c in enabled_calendars}

    if not calendar_ids:
        return []

    query = select(CachedEvent).where(
        CachedEvent.calendar_id.in_(calendar_ids),
        CachedEvent.deleted_at == None,
        CachedEvent.start >= effective_start,
    )
    if end_date:
        end_dt = datetime.fromisoformat(end_date)
        # Include full end day
        end_dt = end_dt.replace(hour=23, minute=59, second=59)
        query = query.where(CachedEvent.start <= end_dt)

    # AND-filter by tags: event must have ALL specified tag_ids
    if tag_ids:
        try:
            tid_list = [int(t.strip()) for t in tag_ids.split(",") if t.strip()]
        except ValueError:
            tid_list = []
        for tid in tid_list:
            query = query.where(
                CachedEvent.event_id.in_(
                    select(EventTag.event_id).where(EventTag.tag_id == tid)
                )
            )

    events = session.exec(query).all()

    # Batch-fetch view counts to avoid N+1
    event_ids = [e.event_id for e in events]
    view_counts: dict[str, int] = {}
    if event_ids:
        rows = session.exec(
            select(EventView.event_id, func.count(EventView.id))
            .where(EventView.event_id.in_(event_ids))
            .group_by(EventView.event_id)
        ).all()
        view_counts = {row[0]: row[1] for row in rows}

    # Batch-fetch tags
    tags_map = get_event_tags(session, event_ids)

    data = [
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
            view_count=view_counts.get(e.event_id, 0),
            price_min=e.price_min,
            price_max=e.price_max,
            price_currency=e.price_currency,
            price_is_free=e.price_is_free,
            links=e.links,
            tags=tags_map.get(e.event_id, []),
        )
        for e in events
    ]

    response = JSONResponse(content=[d.model_dump(mode="json") for d in data])
    response.headers["Cache-Control"] = "public, max-age=60"
    return response


@router.post("/by-ids", response_model=list[EventResponse])
@limiter.limit("120/minute")
def get_events_by_ids(
    request: Request,
    payload: EventBatchRequest,
    session: Session = Depends(get_session),
):
    """Fetch events by a list of IDs (for saved events / My Calendar page)."""
    enabled_calendars = session.exec(
        select(CalendarSetting).where(CalendarSetting.enabled == True)
    ).all()
    calendar_ids = [c.calendar_id for c in enabled_calendars]
    color_map = {c.calendar_id: c.color for c in enabled_calendars}

    if not calendar_ids:
        return []

    events = session.exec(
        select(CachedEvent).where(
            CachedEvent.event_id.in_(payload.event_ids),
            CachedEvent.calendar_id.in_(calendar_ids),
            CachedEvent.deleted_at == None,
        )
    ).all()

    event_ids = [e.event_id for e in events]
    view_counts: dict[str, int] = {}
    if event_ids:
        rows = session.exec(
            select(EventView.event_id, func.count(EventView.id))
            .where(EventView.event_id.in_(event_ids))
            .group_by(EventView.event_id)
        ).all()
        view_counts = {row[0]: row[1] for row in rows}

    tags_map = get_event_tags(session, event_ids)

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
            view_count=view_counts.get(e.event_id, 0),
            price_min=e.price_min,
            price_max=e.price_max,
            price_currency=e.price_currency,
            price_is_free=e.price_is_free,
            links=e.links,
            tags=tags_map.get(e.event_id, []),
        )
        for e in events
    ]


@router.get("/{event_id}", response_model=EventResponse)
@limiter.limit("300/minute")
def get_event(
    event_id: str,
    request: Request,
    session: Session = Depends(get_session),
):
    """Public single-event endpoint for shareable event pages."""
    event = session.exec(
        select(CachedEvent).where(
            CachedEvent.event_id == event_id,
            CachedEvent.deleted_at == None,
        )
    ).first()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    # Check calendar is enabled
    calendar = session.exec(
        select(CalendarSetting).where(
            CalendarSetting.calendar_id == event.calendar_id,
            CalendarSetting.enabled == True,
        )
    ).first()
    if not calendar:
        raise HTTPException(status_code=404, detail="Event not found")

    view_count = session.exec(
        select(func.count(EventView.id)).where(EventView.event_id == event_id)
    ).one()

    tags_map = get_event_tags(session, [event_id])

    data = EventResponse(
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
        color=calendar.color,
        view_count=view_count,
        price_min=event.price_min,
        price_max=event.price_max,
        price_currency=event.price_currency,
        price_is_free=event.price_is_free,
        review_status=event.review_status,
        links=event.links,
        tags=tags_map.get(event_id, []),
    )
    response = JSONResponse(content=data.model_dump(mode="json"))
    response.headers["Cache-Control"] = "public, max-age=60"
    return response


@router.get("/seo/sitemap.xml")
@limiter.limit("10/minute")
def get_sitemap(
    request: Request,
    session: Session = Depends(get_session),
):
    """Dynamic sitemap listing all reviewed events from enabled calendars."""
    import os

    base_url = os.getenv("PUBLIC_URL", "https://example.com")

    enabled_calendars = session.exec(
        select(CalendarSetting).where(CalendarSetting.enabled == True)
    ).all()
    calendar_ids = [c.calendar_id for c in enabled_calendars]

    if not calendar_ids:
        events = []
    else:
        events = session.exec(
            select(CachedEvent).where(
                CachedEvent.calendar_id.in_(calendar_ids),
                CachedEvent.deleted_at == None,
            )
        ).all()

    urls = [
        f"  <url>\n    <loc>{base_url}/</loc>\n    <changefreq>daily</changefreq>\n    <priority>1.0</priority>\n  </url>"
    ]
    for e in events:
        lastmod = (
            e.updated_at.strftime("%Y-%m-%d")
            if e.updated_at
            else e.start.strftime("%Y-%m-%d")
        )
        urls.append(
            f"  <url>\n"
            f"    <loc>{base_url}/event/{e.event_id}</loc>\n"
            f"    <lastmod>{lastmod}</lastmod>\n"
            f"    <changefreq>weekly</changefreq>\n"
            f"  </url>"
        )

    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + "\n".join(urls)
        + "\n</urlset>"
    )
    return Response(content=xml, media_type="application/xml")
