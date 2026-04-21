from fastapi import APIRouter, Depends, Request
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlmodel import Session, select, delete

from backend.api.schemas import (
    EventSaveRequest,
    EventViewRequest,
    EventLinkClickRequest,
    EventExportRequest,
)
from backend.db.database import get_session
from backend.db.models import EventSave, EventView, EventLinkClick, EventExport

router = APIRouter(prefix="/api", tags=["tracking"])

limiter = Limiter(key_func=get_remote_address)


@router.post("/track/event-view", status_code=201)
@limiter.limit("30/minute")
def track_event_view(
    request: Request,
    payload: EventViewRequest,
    session: Session = Depends(get_session),
):
    view = EventView(
        event_id=payload.event_id,
        device_id=payload.device_id,
        source=payload.source,
    )
    session.add(view)
    session.commit()
    return {"status": "tracked"}


@router.post("/track/event-save", status_code=201)
@limiter.limit("30/minute")
def track_event_save(
    request: Request,
    payload: EventSaveRequest,
    session: Session = Depends(get_session),
):
    save = EventSave(
        event_id=payload.event_id,
        device_id=payload.device_id,
        action=payload.action,
    )
    session.add(save)
    session.commit()
    return {"status": "tracked"}


@router.post("/track/link-click", status_code=201)
@limiter.limit("30/minute")
def track_link_click(
    request: Request,
    payload: EventLinkClickRequest,
    session: Session = Depends(get_session),
):
    click = EventLinkClick(
        event_id=payload.event_id,
        url=payload.url,
        device_id=payload.device_id,
    )
    session.add(click)
    session.commit()
    return {"status": "tracked"}


@router.post("/track/export", status_code=201)
@limiter.limit("30/minute")
def track_export(
    request: Request,
    payload: EventExportRequest,
    session: Session = Depends(get_session),
):
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

    session.commit()
    return {"deleted": counts}
