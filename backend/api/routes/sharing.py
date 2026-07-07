import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from slowapi import Limiter
from backend.api.rate_limit import client_ip
from sqlalchemy import func, or_
from sqlmodel import Session, select

from backend.api.deps import get_current_user_optional
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
    User,
    UserEventAttendance,
    UserSavedEvent,
)
from backend.services.ics import build_ics

router = APIRouter(prefix="/api/share", tags=["sharing"])

limiter = Limiter(key_func=client_ip)


@router.post("/calendar", response_model=ShareTokenResponse, status_code=201)
@limiter.limit("10/hour")
def create_share_token(
    request: Request,
    payload: CreateShareTokenRequest,
    session: Session = Depends(get_session),
    current_user: User | None = Depends(get_current_user_optional),
):
    """Return (or create) a stable share token. When authed it is keyed by user."""
    if current_user is not None:
        # User-scoped: one token per user, follows them across devices.
        existing = session.exec(
            select(ShareToken).where(ShareToken.user_id == current_user.id)
        ).first()
        if existing:
            return ShareTokenResponse(token=existing.token)
        # Reuse the device's token if there is one (claim it for the user).
        device_share = session.exec(
            select(ShareToken).where(ShareToken.device_id == payload.device_id)
        ).first()
        if device_share is not None and device_share.user_id is None:
            device_share.user_id = current_user.id
            session.add(device_share)
            session.commit()
            return ShareTokenResponse(token=device_share.token)
        token = str(uuid.uuid4())
        session.add(
            ShareToken(
                token=token,
                device_id=payload.device_id,
                user_id=current_user.id,
            )
        )
        session.commit()
        return ShareTokenResponse(token=token)

    existing = session.exec(
        select(ShareToken).where(ShareToken.device_id == payload.device_id)
    ).first()
    if existing:
        return ShareTokenResponse(token=existing.token)

    token = str(uuid.uuid4())
    session.add(ShareToken(token=token, device_id=payload.device_id))
    session.commit()
    return ShareTokenResponse(token=token)


def _scoped_event_ids(session: Session, share: ShareToken, scope: str) -> list[str]:
    """Collect the share owner's event ids for the requested scope.

    ``scope`` is one of ``saved``, ``going`` or ``all``. User-scoped tokens
    aggregate across all of the user's devices; legacy device-only tokens use
    the device id alone.
    """
    if share.user_id is not None:
        saved_pred = or_(
            UserSavedEvent.user_id == share.user_id,
            UserSavedEvent.device_id == share.device_id,
        )
        going_pred = or_(
            UserEventAttendance.user_id == share.user_id,
            UserEventAttendance.device_id == share.device_id,
        )
    else:
        saved_pred = UserSavedEvent.device_id == share.device_id
        going_pred = UserEventAttendance.device_id == share.device_id

    ids: set[str] = set()
    if scope in ("saved", "all"):
        ids.update(
            row.event_id
            for row in session.exec(select(UserSavedEvent).where(saved_pred)).all()
        )
    if scope in ("going", "all"):
        ids.update(
            row.event_id
            for row in session.exec(select(UserEventAttendance).where(going_pred)).all()
        )
    return list(ids)


@router.get("/calendar/{token}.ics")
@limiter.limit("120/minute")
def get_calendar_feed(
    request: Request,
    token: str,
    scope: str = "all",
    session: Session = Depends(get_session),
):
    """Public live iCalendar feed for a share token (subscribable in Apple/Google).

    Unlike the one-shot export, this is polled periodically by calendar clients,
    so saved/going events stay in sync. ``scope`` selects saved, going or all.
    """
    if scope not in ("saved", "going", "all"):
        scope = "all"

    share = session.exec(select(ShareToken).where(ShareToken.token == token)).first()
    if not share:
        raise HTTPException(status_code=404, detail="Share link not found")

    event_ids = _scoped_event_ids(session, share, scope)

    events: list[CachedEvent] = []
    if event_ids:
        visible_calendars = session.exec(
            select(CalendarSetting.calendar_id).where(
                CalendarSetting.show_events == True
            )
        ).all()
        if visible_calendars:
            events = list(
                session.exec(
                    select(CachedEvent).where(
                        CachedEvent.event_id.in_(event_ids),
                        CachedEvent.calendar_id.in_(visible_calendars),
                        CachedEvent.deleted_at == None,
                    )
                ).all()
            )
    events.sort(key=lambda e: e.start)

    scope_label = {"saved": "Saved", "going": "Going", "all": "Saved & Going"}[scope]
    ics_content = build_ics(
        events,
        calendar_name=f"My Movida — {scope_label}",
        refresh_hours=12,
    )
    return Response(
        content=ics_content,
        media_type="text/calendar; charset=utf-8",
        headers={
            "Content-Disposition": "inline; filename=movida.ics",
            "Cache-Control": "max-age=3600",
        },
    )


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

    # User-scoped tokens aggregate across all of the user's devices; otherwise
    # fall back to the legacy device-only behavior. The shared calendar
    # mirrors My Calendar: union of saved events and "I'm going" events.
    if share.user_id is not None:
        saved_query = select(UserSavedEvent).where(
            or_(
                UserSavedEvent.user_id == share.user_id,
                UserSavedEvent.device_id == share.device_id,
            )
        )
        attending_query = select(UserEventAttendance).where(
            or_(
                UserEventAttendance.user_id == share.user_id,
                UserEventAttendance.device_id == share.device_id,
            )
        )
    else:
        saved_query = select(UserSavedEvent).where(
            UserSavedEvent.device_id == share.device_id
        )
        attending_query = select(UserEventAttendance).where(
            UserEventAttendance.device_id == share.device_id
        )
    saved_rows = session.exec(saved_query).all()
    attending_rows = session.exec(attending_query).all()
    event_ids = list(
        {row.event_id for row in saved_rows} | {row.event_id for row in attending_rows}
    )

    # First name only — we never expose the owner's email or full display name
    # on the public share page.
    owner_display_name: str | None = None
    if share.user_id is not None:
        owner = session.get(User, share.user_id)
        if owner is not None:
            raw = (owner.display_name or "").strip()
            if raw:
                owner_display_name = raw.split()[0]
            elif owner.email:
                owner_display_name = owner.email.split("@", 1)[0]

    if not event_ids:
        return SharedCalendarResponse(events=[], owner_display_name=owner_display_name)

    enabled_calendars = session.exec(
        select(CalendarSetting).where(CalendarSetting.show_events == True)
    ).all()
    calendar_ids = [c.calendar_id for c in enabled_calendars]
    color_map = {c.calendar_id: c.color for c in enabled_calendars}

    if not calendar_ids:
        return SharedCalendarResponse(events=[], owner_display_name=owner_display_name)

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
        owner_display_name=owner_display_name,
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
        ],
    )
