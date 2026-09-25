from datetime import datetime

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from backend.db.models import CachedEvent, SiteSetting
from backend.services.event_visibility import (
    apply_event_visibility,
    eligible_event_ids,
    event_is_user_facing,
    show_pending_events_enabled,
)


@pytest.fixture
def session():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as db_session:
        yield db_session
    SQLModel.metadata.drop_all(engine)


def _event(event_id: str, review_status: str) -> CachedEvent:
    return CachedEvent(
        event_id=event_id,
        calendar_id="calendar",
        title=event_id,
        start=datetime(2026, 10, 1, 18),
        end=datetime(2026, 10, 1, 20),
        review_status=review_status,
    )


@pytest.mark.unit
def test_pending_events_are_ineligible_by_default(session):
    reviewed = _event("reviewed", "reviewed")
    pending = _event("pending", "pending")
    session.add(reviewed)
    session.add(pending)
    session.commit()

    assert show_pending_events_enabled(session) is False
    assert event_is_user_facing(session, reviewed) is True
    assert event_is_user_facing(session, pending) is False
    assert eligible_event_ids(session, [reviewed.event_id, pending.event_id]) == {
        reviewed.event_id
    }
    rows = session.exec(apply_event_visibility(select(CachedEvent), session)).all()
    assert [row.event_id for row in rows] == [reviewed.event_id]


@pytest.mark.unit
def test_pending_events_are_eligible_when_enabled(session):
    pending = _event("pending", "pending")
    session.add(pending)
    session.add(SiteSetting(key="show_pending_events", value="true"))
    session.commit()

    assert show_pending_events_enabled(session) is True
    assert event_is_user_facing(session, pending) is True
    assert eligible_event_ids(session, [pending.event_id]) == {pending.event_id}
    rows = session.exec(apply_event_visibility(select(CachedEvent), session)).all()
    assert [row.event_id for row in rows] == [pending.event_id]
