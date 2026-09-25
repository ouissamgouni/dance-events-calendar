from collections.abc import Iterable

from sqlmodel import Session, col, select

from backend.db.models import CachedEvent, SiteSetting


SHOW_PENDING_EVENTS_KEY = "show_pending_events"


def show_pending_events_enabled(session: Session) -> bool:
    row = session.get(SiteSetting, SHOW_PENDING_EVENTS_KEY)
    value = getattr(row, "value", None)
    return bool(row and isinstance(value, str) and value.strip().lower() == "true")


def event_is_user_facing(session: Session, event: CachedEvent) -> bool:
    return event.review_status != "pending" or show_pending_events_enabled(session)


def apply_event_visibility(statement, session: Session):
    if show_pending_events_enabled(session):
        return statement
    return statement.where(CachedEvent.review_status != "pending")


def eligible_event_ids(session: Session, event_ids: Iterable[str]) -> set[str]:
    ids = list(dict.fromkeys(event_ids))
    if not ids:
        return set()
    statement = select(CachedEvent.event_id).where(col(CachedEvent.event_id).in_(ids))
    statement = apply_event_visibility(statement, session)
    return set(session.exec(statement).all())
