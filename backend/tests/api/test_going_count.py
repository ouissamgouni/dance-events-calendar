"""Tests for the public ``going_count`` aggregate exposed on event responses.

C2 added a per-event count of "I'm going" rows to both the events list and
detail endpoints. These tests assert the count is correctly aggregated from
``user_event_attendances`` and that endpoints serving multiple events share a
single batched query (no N+1 regressions are caught here directly, but the
shape of the response is locked in).
"""

import os
from datetime import datetime, timedelta
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

os.environ.setdefault("SESSION_SECRET", "test-secret-going-count")

from backend.api.main import app  # noqa: E402
from backend.db.database import get_session  # noqa: E402
from backend.db.models import (  # noqa: E402
    CachedEvent,
    CalendarSetting,
    UserEventAttendance,
)


@pytest.fixture
def engine():
    eng = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(eng)
    yield eng
    SQLModel.metadata.drop_all(eng)


@pytest.fixture
def session(engine):
    with Session(engine) as s:
        yield s


@pytest.fixture
def client(engine):
    def _override():
        with Session(engine) as s:
            yield s

    app.dependency_overrides[get_session] = _override
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def _seed(session: Session) -> tuple[str, str]:
    """Seed a calendar plus two future events; return their IDs."""
    session.add(
        CalendarSetting(calendar_id="cal-1", name="Salsa", enabled=True, color="#fff")
    )
    # Use start times far enough in the future that the route's
    # ``effective_start`` since-date filter never excludes them.
    start = datetime.utcnow() + timedelta(days=7)
    session.add(
        CachedEvent(
            event_id="evt-popular",
            calendar_id="cal-1",
            title="Popular night",
            start=start,
            end=start + timedelta(hours=3),
        )
    )
    session.add(
        CachedEvent(
            event_id="evt-empty",
            calendar_id="cal-1",
            title="Quiet night",
            start=start + timedelta(days=1),
            end=start + timedelta(days=1, hours=3),
        )
    )
    session.commit()
    return "evt-popular", "evt-empty"


def test_going_count_zero_when_no_attendances(client, session):
    _, evt_empty = _seed(session)

    resp = client.get(f"/api/events/{evt_empty}")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["event_id"] == evt_empty
    assert body["going_count"] == 0


def test_going_count_aggregates_attendance_rows(client, session):
    evt_popular, evt_empty = _seed(session)

    # Three "going" rows for the popular event, none for the quiet one.
    session.add(UserEventAttendance(device_id="dev-a", event_id=evt_popular))
    session.add(UserEventAttendance(device_id="dev-b", event_id=evt_popular))
    session.add(
        UserEventAttendance(device_id="dev-c", event_id=evt_popular, user_id=uuid4())
    )
    session.commit()

    resp = client.get(f"/api/events/{evt_popular}")
    assert resp.status_code == 200, resp.text
    assert resp.json()["going_count"] == 3

    # Quiet event should remain at 0 — counts must not bleed across events.
    resp = client.get(f"/api/events/{evt_empty}")
    assert resp.json()["going_count"] == 0


def test_going_count_in_list_response(client, session):
    evt_popular, evt_empty = _seed(session)
    session.add(UserEventAttendance(device_id="dev-a", event_id=evt_popular))
    session.add(UserEventAttendance(device_id="dev-b", event_id=evt_popular))
    session.commit()

    resp = client.get("/api/events")
    assert resp.status_code == 200, resp.text
    by_id = {e["event_id"]: e for e in resp.json()}
    assert by_id[evt_popular]["going_count"] == 2
    assert by_id[evt_empty]["going_count"] == 0


def test_going_count_in_by_ids_response(client, session):
    evt_popular, evt_empty = _seed(session)
    session.add(UserEventAttendance(device_id="dev-a", event_id=evt_popular))
    session.commit()

    resp = client.post(
        "/api/events/by-ids", json={"event_ids": [evt_popular, evt_empty]}
    )
    assert resp.status_code == 200, resp.text
    by_id = {e["event_id"]: e for e in resp.json()}
    assert by_id[evt_popular]["going_count"] == 1
    assert by_id[evt_empty]["going_count"] == 0
