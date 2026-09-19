import io
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from slowapi import Limiter
from backend.api.rate_limit import client_ip
from sqlalchemy import or_
from sqlmodel import Session, select

from backend.api.deps import get_current_user_optional
from backend.api.schemas import ExportRequest
from backend.db.database import get_session
from backend.db.models import CachedEvent, User, UserEventAttendance, UserSavedEvent
from backend.services.ics import build_ics, ics_escape

router = APIRouter(prefix="/api/events/export", tags=["export"])

limiter = Limiter(key_func=client_ip)


def _fetch_events(session: Session, event_ids: list[str]) -> list[CachedEvent]:
    """Fetch events by IDs, filtering out deleted ones."""
    if not event_ids:
        return []
    return list(
        session.exec(
            select(CachedEvent).where(
                CachedEvent.event_id.in_(event_ids),
                CachedEvent.deleted_at == None,
            )
        ).all()
    )


def _build_ics(events: list[CachedEvent]) -> str:
    """Build an iCalendar string from a list of events."""
    return build_ics(events)


def _ics_escape(text: str) -> str:
    """Escape special characters for iCalendar text values."""
    return ics_escape(text)


@router.post("/ics")
@limiter.limit("10/minute")
def export_ics(
    request: Request,
    payload: ExportRequest,
    session: Session = Depends(get_session),
):
    events = _fetch_events(session, payload.event_ids)
    ics_content = _build_ics(events)

    # Contextual filename: my-movida-events-upcoming.ics or just my-movida-events.ics
    filename = f"my-movida-events{f'-{payload.view}' if payload.view else ''}.ics"

    return StreamingResponse(
        io.BytesIO(ics_content.encode("utf-8")),
        media_type="text/calendar",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@router.post("/xlsx")
@limiter.limit("10/minute")
def export_xlsx(
    request: Request,
    payload: ExportRequest,
    session: Session = Depends(get_session),
    current_user: User | None = Depends(get_current_user_optional),
):
    """Export events to XLSX with Status column showing RSVP status.

    Requires authentication to populate Status column accurately.
    """
    from openpyxl import Workbook

    events = _fetch_events(session, payload.event_ids)
    events.sort(key=lambda e: e.start)

    # Build status map if user is authenticated
    status_map: dict[str, str] = {}
    if current_user:
        # Fetch user's attending events
        attending = session.exec(
            select(UserEventAttendance).where(
                or_(
                    UserEventAttendance.user_id == current_user.id,
                    UserEventAttendance.device_id is not None,  # Include device-based
                )
            )
        ).all()
        attending_ids = {row.event_id for row in attending}

        # Fetch user's saved/interested events
        saved = session.exec(
            select(UserSavedEvent).where(
                or_(
                    UserSavedEvent.user_id == current_user.id,
                    UserSavedEvent.device_id is not None,  # Include device-based
                )
            )
        ).all()
        saved_ids = {row.event_id for row in saved}

        # Map each event ID to its status
        for event_id in payload.event_ids:
            if event_id in attending_ids:
                status_map[event_id] = "I'm going"
            elif event_id in saved_ids:
                status_map[event_id] = "I'm interested"

    wb = Workbook()
    ws = wb.active

    # Contextual worksheet title
    view_labels = {"upcoming": "Upcoming", "saved": "Saved", "past": "Past"}
    ws.title = f"{view_labels.get(payload.view or 'all', 'My Movida')} Events"

    # New column set: Title, Date, Start Time, End Time, Location, Status
    ws.append(["Title", "Date", "Start Time", "End Time", "Location", "Status"])

    for e in events:
        if e.all_day:
            date_str = e.start.strftime("%Y-%m-%d")
            start_time = "All day"
            end_time = ""
        else:
            date_str = e.start.strftime("%Y-%m-%d")
            start_time = e.start.strftime("%H:%M")
            end_time = e.end.strftime("%H:%M")

        # Get status for this event
        status = status_map.get(e.event_id, "")

        ws.append(
            [
                e.title,
                date_str,
                start_time,
                end_time,
                e.location or "",
                status,
            ]
        )

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)

    # Contextual filename
    filename = f"my-movida-events{f'-{payload.view}' if payload.view else ''}.xlsx"

    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )
