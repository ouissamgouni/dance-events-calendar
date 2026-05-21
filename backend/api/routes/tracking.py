from fastapi import APIRouter, BackgroundTasks, Depends, Request, Response
from slowapi import Limiter
from backend.api.rate_limit import client_ip
from sqlmodel import Session, select

from backend.api.anon_id import get_or_set_anon_id
from backend.api.deps import get_current_user_optional
from backend.api.schemas import (
    EventAttendanceRequest,
    EventSaveRequest,
    EventViewRequest,
    EventLinkClickRequest,
    EventExportRequest,
    ShareEventRequest,
)
from backend.config.loader import get_admin_email, get_analytics_enabled
from backend.db.database import get_session
from backend.db.models import (
    EventAttendance,
    EventSave,
    EventView,
    EventLinkClick,
    EventExport,
    ShareEvent,
    User,
    UserEventAttendance,
    UserSavedEvent,
    ShareToken,
)
from backend.services.ip_geolocation import geolocate_ip
from backend.services.notifications import fan_out_going, withdraw_going

router = APIRouter(prefix="/api", tags=["tracking"])

limiter = Limiter(key_func=client_ip)


def _is_admin(user: User | None) -> bool:
    """Admin sessions are excluded from analytics so moderation activity
    does not skew product KPIs and ranking signals. Functional state
    (UserSavedEvent, UserEventAttendance) is still maintained — only the
    analytics rows and geolocation lookups are skipped."""
    if user is None:
        return False
    admin_email = get_admin_email()
    return bool(admin_email) and user.email == admin_email


async def _update_view_geo(view_id: int, ip: str) -> None:
    """Resolve IP geo and update the EventView row. Fire-and-forget — failures are silent."""
    geo = await geolocate_ip(ip)
    if not geo:
        return
    from backend.db.database import get_engine
    from sqlmodel import Session as _Session

    with _Session(get_engine()) as session:
        view = session.get(EventView, view_id)
        if view:
            view.country = geo.get("country")
            view.city = geo.get("city")
            session.add(view)
            session.commit()


async def _update_click_geo(click_id: int, ip: str) -> None:
    """Resolve IP geo and update the EventLinkClick row. Fire-and-forget — failures are silent."""
    geo = await geolocate_ip(ip)
    if not geo:
        return
    from backend.db.database import get_engine
    from sqlmodel import Session as _Session

    with _Session(get_engine()) as session:
        click = session.get(EventLinkClick, click_id)
        if click:
            click.country = geo.get("country")
            click.city = geo.get("city")
            session.add(click)
            session.commit()


@router.post("/track/event-view", status_code=201)
@limiter.limit("30/minute")
async def track_event_view(
    request: Request,
    payload: EventViewRequest,
    background_tasks: BackgroundTasks,
    session: Session = Depends(get_session),
    current_user: User | None = Depends(get_current_user_optional),
):
    if not get_analytics_enabled():
        return {"status": "disabled"}
    if _is_admin(current_user):
        return {"status": "skipped", "reason": "admin"}
    view = EventView(
        event_id=payload.event_id,
        device_id=payload.device_id,
        source=payload.source,
    )
    session.add(view)
    session.commit()
    session.refresh(view)
    if request.client:
        background_tasks.add_task(_update_view_geo, view.id, request.client.host)
    return {"status": "tracked"}


@router.post("/track/event-save", status_code=201)
@limiter.limit("30/minute")
def track_event_save(
    request: Request,
    response: Response,
    payload: EventSaveRequest,
    session: Session = Depends(get_session),
    current_user: User | None = Depends(get_current_user_optional),
):
    if (
        payload.record_analytics
        and not _is_admin(current_user)
        and get_analytics_enabled()
    ):
        session.add(
            EventSave(
                event_id=payload.event_id,
                device_id=payload.device_id,
                action=payload.action,
            )
        )

    user_id = current_user.id if current_user else None
    # Stable anonymous identity (httpOnly cookie). Survives localStorage
    # clears, so re-clicking save after wiping local data does not insert a
    # second UserSavedEvent row and inflate total_saved.
    #
    # Seed the cookie with the client's localStorage device_id on first
    # write. Without seeding, two parallel "first" writes from the same
    # anonymous human (no cookie yet) land on different backend machines,
    # mint independent UUIDs, and produce duplicate rows that bypass the
    # (device_id, event_id) unique constraint — visible in prod as
    # double-counted total_saved / total_going. Seeding makes both
    # parallel requests use the same key so the constraint protects them.
    anon_id = get_or_set_anon_id(request, response, preferred_value=payload.device_id)
    # For anonymous callers the cookie value is the dedupe key. For authed
    # callers we keep the payload device_id (so cross-device dedupe via
    # user_id keeps working as before).
    state_key = anon_id if user_id is None else payload.device_id

    # Maintain materialized state table (source of truth for sharing).
    if payload.action == "save":
        existing = session.exec(
            select(UserSavedEvent).where(
                UserSavedEvent.device_id == state_key,
                UserSavedEvent.event_id == payload.event_id,
            )
        ).first()
        if existing is None and user_id is None:
            # Back-compat: an older client without the cookie may have
            # written a row keyed by the legacy localStorage device_id.
            # Reuse it instead of inserting a duplicate.
            existing = session.exec(
                select(UserSavedEvent).where(
                    UserSavedEvent.device_id == payload.device_id,
                    UserSavedEvent.event_id == payload.event_id,
                    UserSavedEvent.user_id.is_(None),
                )
            ).first()
        if existing:
            mutated = False
            if user_id and existing.user_id is None:
                existing.user_id = user_id
                mutated = True
            if current_user is not None and payload.audience is not None:
                existing.audience = payload.audience
                mutated = True
            if mutated:
                session.add(existing)
        else:
            if current_user is not None:
                # Per-event audience: explicit value wins, otherwise fall
                # back to the user's ``share_attendance_default_audience``
                # (the same default that drives the Going picker), which
                # itself defaults to ``friends`` per GDPR privacy-by-default.
                audience = (
                    payload.audience
                    if payload.audience is not None
                    else (current_user.share_attendance_default_audience or "friends")
                )
            else:
                audience = "private"
            session.add(
                UserSavedEvent(
                    device_id=state_key,
                    event_id=payload.event_id,
                    user_id=user_id,
                    audience=audience,
                )
            )
    else:
        # Unsave: when authed, remove every row for this event owned by the user
        # across all their devices so the cross-device view is consistent.
        if user_id:
            user_rows = session.exec(
                select(UserSavedEvent).where(
                    UserSavedEvent.user_id == user_id,
                    UserSavedEvent.event_id == payload.event_id,
                )
            ).all()
            for row in user_rows:
                session.delete(row)
        # Anonymous unsave: remove the row for this anon identity. Also
        # sweep the legacy device_id row for back-compat.
        keys = {state_key, payload.device_id}
        for key in keys:
            row = session.exec(
                select(UserSavedEvent).where(
                    UserSavedEvent.device_id == key,
                    UserSavedEvent.event_id == payload.event_id,
                    UserSavedEvent.user_id.is_(None),
                )
            ).first()
            if row:
                session.delete(row)

    session.commit()
    return {"status": "tracked"}


@router.post("/track/event-attendance", status_code=201)
@limiter.limit("30/minute")
def track_event_attendance(
    request: Request,
    response: Response,
    payload: EventAttendanceRequest,
    session: Session = Depends(get_session),
    current_user: User | None = Depends(get_current_user_optional),
):
    if (
        payload.record_analytics
        and not _is_admin(current_user)
        and get_analytics_enabled()
    ):
        session.add(
            EventAttendance(
                event_id=payload.event_id,
                device_id=payload.device_id,
                action=payload.action,
            )
        )

    user_id = current_user.id if current_user else None
    # See track_event_save for the rationale on seeding the cookie with
    # payload.device_id (multi-machine first-write race).
    anon_id = get_or_set_anon_id(request, response, preferred_value=payload.device_id)
    state_key = anon_id if user_id is None else payload.device_id

    # Maintain materialized state table.
    if payload.action == "going":
        existing = session.exec(
            select(UserEventAttendance).where(
                UserEventAttendance.device_id == state_key,
                UserEventAttendance.event_id == payload.event_id,
            )
        ).first()
        if existing is None and user_id is not None:
            existing = session.exec(
                select(UserEventAttendance).where(
                    UserEventAttendance.user_id == user_id,
                    UserEventAttendance.event_id == payload.event_id,
                    UserEventAttendance.created_by_admin_user_id.is_not(None),
                )
            ).first()
        if existing is None and user_id is None:
            # Back-compat: pick up a pre-cookie row keyed by legacy device_id.
            existing = session.exec(
                select(UserEventAttendance).where(
                    UserEventAttendance.device_id == payload.device_id,
                    UserEventAttendance.event_id == payload.event_id,
                    UserEventAttendance.user_id.is_(None),
                )
            ).first()
        # Track final share_publicly state for Phase C fan-out.
        share_publicly_after = False
        share_publicly_before = bool(existing.share_publicly) if existing else False
        # Resolve incoming desired audience: explicit ``share_audience`` wins,
        # then legacy ``share_publicly`` (true→public, false→private), else
        # None (no change).
        incoming_audience: str | None = payload.share_audience
        if incoming_audience is None and payload.share_publicly is not None:
            incoming_audience = "public" if payload.share_publicly else "private"
        if existing:
            if user_id and existing.user_id is None:
                existing.user_id = user_id
            # Only authenticated callers can change the visibility flag.
            # Anonymous callers' field is ignored (rows with user_id=NULL
            # are always treated as private/anonymous in the read path).
            if current_user is not None and incoming_audience is not None:
                existing.share_audience = incoming_audience
                existing.share_publicly = incoming_audience == "public"
            session.add(existing)
            share_publicly_after = bool(existing.share_publicly)
        else:
            if current_user is not None:
                resolved_audience = (
                    incoming_audience
                    if incoming_audience is not None
                    else (
                        current_user.share_attendance_default_audience
                        or (
                            "public"
                            if current_user.share_attendance_default
                            else "private"
                        )
                    )
                )
                share_publicly = resolved_audience == "public"
            else:
                resolved_audience = "private"
                share_publicly = False
            session.add(
                UserEventAttendance(
                    device_id=state_key,
                    event_id=payload.event_id,
                    user_id=user_id,
                    share_publicly=share_publicly,
                    share_audience=resolved_audience,
                )
            )
            share_publicly_after = bool(share_publicly)

        # Phase C: fan out to subscribers when the row ends up shared
        # (public or friends) AND the actor is authenticated. Audience
        # is propagated to the fan-out so friends-tier RSVPs only notify
        # mutual friends. Idempotent via unique
        # (recipient, kind, actor, event); we still gate on a transition
        # to avoid pointless work on no-op repeat-Going pings.
        current_share_audience = (
            existing.share_audience if existing is not None else resolved_audience
        )
        if current_user is not None and current_share_audience in ("public", "friends"):
            # Fire when transitioning into a shared state OR when audience
            # changed between shared tiers (e.g. friends -> public widens
            # the eligible recipient set).
            should_fan = (existing is None and share_publicly_after) or (
                existing is not None
                and (
                    not share_publicly_before  # private -> shared
                    or share_publicly_after != share_publicly_before  # bool changed
                )
            )
            # Always fan out on the initial insert if shared.
            if existing is None and current_share_audience in ("public", "friends"):
                should_fan = True
            if should_fan:
                fan_out_going(
                    session,
                    current_user,
                    payload.event_id,
                    audience=current_share_audience,
                )
        # Conversely, when the user transitions an existing Going row
        # from a shared tier back to ``private``, withdraw any
        # notifications that were already fanned out. Without this,
        # opting out of public sharing would silently leave the
        # (now-private) attendance visible in subscribers' feeds.
        elif (
            current_user is not None
            and existing is not None
            and share_publicly_before
            and not share_publicly_after
        ):
            withdraw_going(session, current_user, payload.event_id)
    else:
        if user_id:
            user_rows = session.exec(
                select(UserEventAttendance).where(
                    UserEventAttendance.user_id == user_id,
                    UserEventAttendance.event_id == payload.event_id,
                )
            ).all()
            for row in user_rows:
                session.delete(row)
        keys = {state_key, payload.device_id}
        for key in keys:
            row = session.exec(
                select(UserEventAttendance).where(
                    UserEventAttendance.device_id == key,
                    UserEventAttendance.event_id == payload.event_id,
                    UserEventAttendance.user_id.is_(None),
                )
            ).first()
            if row:
                session.delete(row)
        # Withdraw any subscription_going notifications when the
        # authenticated owner toggles Going off entirely.
        if current_user is not None:
            withdraw_going(session, current_user, payload.event_id)

    session.commit()
    return {"status": "tracked"}


@router.post("/track/link-click", status_code=201)
@limiter.limit("30/minute")
async def track_link_click(
    request: Request,
    payload: EventLinkClickRequest,
    background_tasks: BackgroundTasks,
    session: Session = Depends(get_session),
    current_user: User | None = Depends(get_current_user_optional),
):
    if not get_analytics_enabled():
        return {"status": "disabled"}
    if _is_admin(current_user):
        return {"status": "skipped", "reason": "admin"}
    click = EventLinkClick(
        event_id=payload.event_id,
        url=payload.url,
        device_id=payload.device_id,
    )
    session.add(click)
    session.commit()
    session.refresh(click)
    if request.client:
        background_tasks.add_task(_update_click_geo, click.id, request.client.host)
    return {"status": "tracked"}


@router.post("/track/export", status_code=201)
@limiter.limit("30/minute")
def track_export(
    request: Request,
    payload: EventExportRequest,
    session: Session = Depends(get_session),
    current_user: User | None = Depends(get_current_user_optional),
):
    if not get_analytics_enabled():
        return {"status": "disabled"}
    if _is_admin(current_user):
        return {"status": "skipped", "reason": "admin"}
    export = EventExport(
        format=payload.format,
        event_count=payload.event_count,
        device_id=payload.device_id,
    )
    session.add(export)
    session.commit()
    return {"status": "tracked"}


@router.post("/track/share", status_code=201)
@limiter.limit("60/minute")
def track_share(
    request: Request,
    payload: ShareEventRequest,
    session: Session = Depends(get_session),
    current_user: User | None = Depends(get_current_user_optional),
):
    """Append-only log row for the share funnel.

    - ``share``: caller is the originator. We use the authenticated user's
      ``share_code`` (if any) and ignore the payload's ``share_code`` to
      prevent spoofing one user as another.
    - ``click`` / ``conversion``: caller is the *recipient*. The payload
      carries the originator's ``share_code`` (captured from the URL on
      landing). We accept it as-is — worst case is an invalid code that
      simply produces an unattributable row.
    """
    if not get_analytics_enabled():
        return {"status": "disabled"}
    if _is_admin(current_user):
        return {"status": "skipped", "reason": "admin"}

    if payload.action == "share":
        share_code = current_user.share_code if current_user else None
    else:
        share_code = payload.share_code

    row = ShareEvent(
        event_id=payload.event_id,
        action=payload.action,
        share_code=share_code,
        device_id=payload.device_id,
    )
    session.add(row)
    session.commit()
    return {"status": "tracked"}


@router.delete("/user-data/{device_id}", status_code=200)
@limiter.limit("5/minute")
def delete_user_data(
    request: Request,
    device_id: str,
    session: Session = Depends(get_session),
):
    """GDPR data deletion: remove all tracking data associated with a device_id."""
    counts = {}

    views = session.exec(
        select(EventView).where(EventView.device_id == device_id)
    ).all()
    counts["event_views"] = len(views)
    for v in views:
        session.delete(v)

    saves = session.exec(
        select(EventSave).where(EventSave.device_id == device_id)
    ).all()
    counts["event_saves"] = len(saves)
    for s in saves:
        session.delete(s)

    clicks = session.exec(
        select(EventLinkClick).where(EventLinkClick.device_id == device_id)
    ).all()
    counts["event_link_clicks"] = len(clicks)
    for c in clicks:
        session.delete(c)

    exports = session.exec(
        select(EventExport).where(EventExport.device_id == device_id)
    ).all()
    counts["event_exports"] = len(exports)
    for e in exports:
        session.delete(e)

    user_saved = session.exec(
        select(UserSavedEvent).where(UserSavedEvent.device_id == device_id)
    ).all()
    counts["user_saved_events"] = len(user_saved)
    for row in user_saved:
        session.delete(row)

    share_tokens = session.exec(
        select(ShareToken).where(ShareToken.device_id == device_id)
    ).all()
    counts["share_tokens"] = len(share_tokens)
    for row in share_tokens:
        session.delete(row)

    attendances = session.exec(
        select(EventAttendance).where(EventAttendance.device_id == device_id)
    ).all()
    counts["event_attendances"] = len(attendances)
    for a in attendances:
        session.delete(a)

    user_attendances = session.exec(
        select(UserEventAttendance).where(UserEventAttendance.device_id == device_id)
    ).all()
    counts["user_event_attendances"] = len(user_attendances)
    for row in user_attendances:
        session.delete(row)

    session.commit()
    return {"deleted": counts}
