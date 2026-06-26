import io
from datetime import datetime

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from slowapi import Limiter
from backend.api.rate_limit import client_ip
from sqlmodel import Session, select

from backend.api.schemas import ExportRequest
from backend.db.database import get_session
from backend.db.models import CachedEvent
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
    return StreamingResponse(
        io.BytesIO(ics_content.encode("utf-8")),
        media_type="text/calendar",
        headers={"Content-Disposition": "attachment; filename=my-movida-events.ics"},
    )


@router.post("/xlsx")
@limiter.limit("10/minute")
def export_xlsx(
    request: Request,
    payload: ExportRequest,
    session: Session = Depends(get_session),
):
    from openpyxl import Workbook

    events = _fetch_events(session, payload.event_ids)
    events.sort(key=lambda e: e.start)

    wb = Workbook()
    ws = wb.active
    ws.title = "My Movida Events"
    ws.append(
        ["Title", "Date", "Start Time", "End Time", "Location", "Description", "Price"]
    )

    for e in events:
        if e.all_day:
            date_str = e.start.strftime("%Y-%m-%d")
            start_time = "All day"
            end_time = ""
        else:
            date_str = e.start.strftime("%Y-%m-%d")
            start_time = e.start.strftime("%H:%M")
            end_time = e.end.strftime("%H:%M")

        if e.price_is_free:
            price = "Free"
        elif e.price_min is not None and e.price_currency:
            price = f"{e.price_currency} {e.price_min}"
            if e.price_max is not None and e.price_max != e.price_min:
                price += f"–{e.price_max}"
        else:
            price = ""

        ws.append(
            [
                e.title,
                date_str,
                start_time,
                end_time,
                e.location or "",
                (e.description or "")[:500],
                price,
            ]
        )

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)

    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=my-movida-events.xlsx"},
    )
