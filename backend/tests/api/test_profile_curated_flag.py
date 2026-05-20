"""Tests for the Phase 4 ``curated`` read-path fields.

Covers:
- ``/users/{handle}/saved`` ``curated_event_ids`` reflects rows with a
  non-null ``created_by_admin_user_id``.
- ``/users/{handle}/going`` ditto.
- ``/users/{handle}/calendar`` items set ``curated=True`` when either
  the saved or going row is curator-stamped.
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

os.environ.setdefault("SESSION_SECRET", "test-secret-curated-flag")
os.environ.setdefault("ADMIN_EMAIL", "admin@example.com")
os.environ["DEV_AUTH"] = "true"

from backend.api.main import app  # noqa: E402
from backend.api.routes import auth as auth_module  # noqa: E402
from backend.api.routes import social as social_module  # noqa: E402
from backend.db.database import get_session  # noqa: E402
from backend.db.models import (  # noqa: E402
    CachedEvent,
    CalendarSetting,
    User,
    UserEventAttendance,
    UserSavedEvent,
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
    auth_module.limiter.reset()
    social_module.limiter.reset()
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def _login(client: TestClient, email: str) -> None:
    r = client.post(
        "/api/auth/google",
        json={"credential": "ignored", "mock_email": email},
    )
    assert r.status_code == 200, r.text


def _seed_curator_with_events(session: Session) -> dict:
    """Curator (public account) with two events: one curated, one self-saved."""
    admin = User(
        email="admin@example.com",
        handle="admin",
        display_name="Admin",
        provider="google",
        provider_subject="mock|admin@example.com",
    )
    curator = User(
        email="curator@example.com",
        handle="curator-paris",
        display_name="Curator Paris",
        provider="google",
        provider_subject="mock|curator@example.com",
        is_admin_managed=True,
        account_visibility="public",
    )
    session.add_all([admin, curator])
    session.add(CalendarSetting(calendar_id="cal-1", name="Cal 1", enabled=True))
    session.commit()
    start = datetime.now(timezone.utc) + timedelta(days=3)
    e_curated = CachedEvent(
        event_id="evt-curated",
        title="Curated Night",
        start=start,
        end=start + timedelta(hours=2),
        calendar_id="cal-1",
    )
    e_self = CachedEvent(
        event_id="evt-self",
        title="Self-saved Night",
        start=start + timedelta(days=1),
        end=start + timedelta(days=1, hours=2),
        calendar_id="cal-1",
    )
    session.add_all([e_curated, e_self])
    session.commit()
    return {"admin": admin, "curator": curator}


@pytest.mark.unit
def test_saved_endpoint_returns_curated_event_ids(client, session):
    seeded = _seed_curator_with_events(session)
    curator = seeded["curator"]
    admin = seeded["admin"]
    session.add(
        UserSavedEvent(
            user_id=curator.id,
            event_id="evt-curated",
            audience="public",
            device_id=f"admin:{admin.id}",
            created_by_admin_user_id=admin.id,
        )
    )
    session.add(
        UserSavedEvent(
            user_id=curator.id,
            event_id="evt-self",
            audience="public",
            device_id="own-device",
        )
    )
    session.commit()

    r = client.get("/api/social/users/curator-paris/saved")
    assert r.status_code == 200, r.text
    body = r.json()
    ids = {it["event_id"] for it in body["items"]}
    assert ids == {"evt-curated", "evt-self"}
    assert body["curated_event_ids"] == ["evt-curated"]


@pytest.mark.unit
def test_going_endpoint_returns_curated_event_ids(client, session):
    seeded = _seed_curator_with_events(session)
    curator = seeded["curator"]
    admin = seeded["admin"]
    session.add(
        UserEventAttendance(
            user_id=curator.id,
            event_id="evt-curated",
            share_audience="public",
            share_publicly=True,
            device_id=f"admin:{admin.id}",
            created_by_admin_user_id=admin.id,
        )
    )
    session.commit()

    r = client.get("/api/social/users/curator-paris/going")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["curated_event_ids"] == ["evt-curated"]


@pytest.mark.unit
def test_calendar_endpoint_marks_curated_per_row(client, session):
    seeded = _seed_curator_with_events(session)
    curator = seeded["curator"]
    admin = seeded["admin"]
    session.add(
        UserSavedEvent(
            user_id=curator.id,
            event_id="evt-curated",
            audience="public",
            device_id=f"admin:{admin.id}",
            created_by_admin_user_id=admin.id,
        )
    )
    session.add(
        UserSavedEvent(
            user_id=curator.id,
            event_id="evt-self",
            audience="public",
            device_id="own-device",
        )
    )
    session.commit()

    r = client.get("/api/social/users/curator-paris/calendar")
    assert r.status_code == 200, r.text
    body = r.json()
    by_id = {it["event"]["event_id"]: it for it in body["items"]}
    assert by_id["evt-curated"]["curated"] is True
    assert by_id["evt-self"]["curated"] is False
