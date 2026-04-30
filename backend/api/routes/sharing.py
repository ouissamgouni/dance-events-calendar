import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy import func
from sqlmodel import Session, select

from backend.api.routes.tags import get_event_tags
from backend.api.schemas import (
    CreateShareTokenRequest,
    EventResponse,
    SharedCalendarResponse,
    ShareTokenResponse,
)
from backend.db.database import get_session
from backend.db.models import (
    CalendarSetting,
    CachedEvent,
    EventView,
    ShareToken,
    UserSavedEvent,
)

router = APIRouter(prefix="/api/share", tags=["sharing"])

limiter = Limiter(key_func=get_remote_address)


@router.post("/calendar", response_model=ShareTokenResponse, status_code=201)
@limiter.limit("10/hour")
def create_share_token(
    request: Request,
    payload: CreateShareTokenRequest,
    session: Session = Depends(get_session),
):
    """Return (or create) a stable share token for the given device_id."""
    existing = session.exec(
        select(ShareToken).where(ShareToken.device_id == payload.device_id)
    ).first()
    if existing:
        return ShareTokenResponse(token=existing.token)

    token = str(uuid.uuid4())
    session.add(ShareToken(token=token, device_id=payload.device_id))
    session.commit()
    return ShareTokenResponse(token=token)


@router.get("/calendar/{token}", response_model=SharedCalendarResponse)
@limiter.limit("60/minute")
def get_shared_calendar(
    request: Request,
    token: str,
    session: Session = Depends(get_session),
):
    """Return the live saved-events list for the share token owner."""
    share = session.exec(select(ShareToken).where(ShareToken.token == token)).first()
    if not share:
        raise HTTPException(status_code=404, detail="Share link not found")

    saved_rows = session.exec(
        select(UserSavedEvent).where(UserSavedEvent.device_id == share.device_id)
    ).all()
    event_ids = [row.event_id for row in saved_rows]

    if not event_ids:
        return SharedCalendarResponse(events=[])

    enabled_calendars = session.exec(
        select(CalendarSetting).where(CalendarSetting.enabled == True)
    ).all()
    calendar_ids = [c.calendar_id for c in enabled_calendars]
    color_map = {c.calendar_id: c.color for c in enabled_calendars}

    if not calendar_ids:
        return SharedCalendarResponse(events=[])

    events = session.exec(
        select(CachedEvent).where(
            CachedEvent.event_id.in_(event_ids),
            CachedEvent.calendar_id.in_(calendar_ids),
            CachedEvent.deleted_at == None,
        )
    ).all()

    fetched_ids = [e.event_id for e in events]
    view_counts: dict[str, int] = {}
    if fetched_ids:
        rows = session.exec(
            select(EventView.event_id, func.count(EventView.id))
            .where(EventView.event_id.in_(fetched_ids))
            .group_by(EventView.event_id)
        ).all()
        view_counts = {row[0]: row[1] for row in rows}

    tags_map = get_event_tags(session, fetched_ids)

    return SharedCalendarResponse(
        events=[
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
    )
