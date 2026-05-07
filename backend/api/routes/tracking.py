from fastapi import APIRouter, BackgroundTasks, Depends, Request
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlmodel import Session, select

from backend.api.deps import get_current_user_optional
from backend.api.schemas import (
    EventAttendanceRequest,
    EventSaveRequest,
    EventViewRequest,
    EventLinkClickRequest,
    EventExportRequest,
)
from backend.config.loader import get_admin_email
from backend.db.database import get_session
from backend.db.models import (
    EventAttendance,
    EventSave,
    EventView,
    EventLinkClick,
    EventExport,
    User,
    UserEventAttendance,
    UserSavedEvent,
    ShareToken,
)
from backend.services.ip_geolocation import geolocate_ip

router = APIRouter(prefix="/api", tags=["tracking"])

limiter = Limiter(key_func=get_remote_address)


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
    payload: EventSaveRequest,
    session: Session = Depends(get_session),
    current_user: User | None = Depends(get_current_user_optional),
):
    if payload.record_analytics and not _is_admin(current_user):
        session.add(
            EventSave(
                event_id=payload.event_id,
                device_id=payload.device_id,
                action=payload.action,
            )
        )

    user_id = current_user.id if current_user else None

    # Maintain materialized state table (source of truth for sharing).
    if payload.action == "save":
        existing = session.exec(
            select(UserSavedEvent).where(
                UserSavedEvent.device_id == payload.device_id,
                UserSavedEvent.event_id == payload.event_id,
            )
        ).first()
        if existing:
            if user_id and existing.user_id is None:
                existing.user_id = user_id
                session.add(existing)
        else:
            session.add(
                UserSavedEvent(
                    device_id=payload.device_id,
                    event_id=payload.event_id,
                    user_id=user_id,
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
        row = session.exec(
            select(UserSavedEvent).where(
                UserSavedEvent.device_id == payload.device_id,
                UserSavedEvent.event_id == payload.event_id,
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
    payload: EventAttendanceRequest,
    session: Session = Depends(get_session),
    current_user: User | None = Depends(get_current_user_optional),
):
    if payload.record_analytics and not _is_admin(current_user):
        session.add(
            EventAttendance(
                event_id=payload.event_id,
                device_id=payload.device_id,
                action=payload.action,
            )
        )

    user_id = current_user.id if current_user else None

    # Maintain materialized state table.
    if payload.action == "going":
        existing = session.exec(
            select(UserEventAttendance).where(
                UserEventAttendance.device_id == payload.device_id,
                UserEventAttendance.event_id == payload.event_id,
            )
        ).first()
        if existing:
            if user_id and existing.user_id is None:
                existing.user_id = user_id
            # Only authenticated callers can change the visibility flag.
            # Anonymous callers' field is ignored (rows with user_id=NULL
            # are always treated as private/anonymous in the read path).
            if current_user is not None and payload.share_publicly is not None:
                existing.share_publicly = payload.share_publicly
            session.add(existing)
        else:
            if current_user is not None:
                share_publicly = (
                    payload.share_publicly
                    if payload.share_publicly is not None
                    else current_user.share_attendance_default
                )
            else:
                share_publicly = False
            session.add(
                UserEventAttendance(
                    device_id=payload.device_id,
                    event_id=payload.event_id,
                    user_id=user_id,
                    share_publicly=share_publicly,
                )
            )
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
        row = session.exec(
            select(UserEventAttendance).where(
                UserEventAttendance.device_id == payload.device_id,
                UserEventAttendance.event_id == payload.event_id,
            )
        ).first()
        if row:
            session.delete(row)

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
