from fastapi import APIRouter, Depends, Request
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlmodel import Session

from backend.api.schemas import EventViewRequest
from backend.db.database import get_session
from backend.db.models import EventView

router = APIRouter(prefix="/api/track", tags=["tracking"])

limiter = Limiter(key_func=get_remote_address)


@router.post("/event-view", status_code=201)
@limiter.limit("30/minute")
def track_event_view(
    request: Request,
    payload: EventViewRequest,
    session: Session = Depends(get_session),
):
    view = EventView(event_id=payload.event_id)
    session.add(view)
    session.commit()
    return {"status": "tracked"}
