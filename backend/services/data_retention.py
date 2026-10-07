"""Storage-limitation jobs: pseudonymise or drop analytics data past its retention window."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, update
from sqlmodel import Session

from backend.db.models import (
    EmailLoginCode,
    EventAttendance,
    EventExport,
    EventLinkClick,
    EventSave,
    EventView,
    ShareEvent,
)

# Matches the retention stated in the privacy policy.
ANALYTICS_RETENTION = timedelta(days=365)
LOGIN_CODE_RETENTION = timedelta(days=1)

# Counts on these tables power public popularity, so rows stay and only lose the device link.
_PSEUDONYMISE = (EventView, EventLinkClick, EventExport, ShareEvent)
# device_id is NOT NULL here and the rows only feed admin stats, so old rows go.
_DELETE = (EventSave, EventAttendance)


def apply_retention(session: Session, now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    cutoff = now - ANALYTICS_RETENTION
    stats: dict[str, int] = {}
    for model in _PSEUDONYMISE:
        result = session.execute(
            update(model)
            .where(model.created_at < cutoff, model.device_id.is_not(None))
            .values(device_id=None)
        )
        stats[model.__tablename__] = result.rowcount or 0
    for model in _DELETE:
        result = session.execute(delete(model).where(model.created_at < cutoff))
        stats[model.__tablename__] = result.rowcount or 0
    result = session.execute(
        delete(EmailLoginCode).where(
            EmailLoginCode.expires_at < now - LOGIN_CODE_RETENTION
        )
    )
    stats[EmailLoginCode.__tablename__] = result.rowcount or 0
    session.commit()
    return stats


def run_once() -> dict:
    from backend.db.database import get_engine

    with Session(get_engine()) as session:
        return apply_retention(session)
