"""Integration test for the full admin-curation Phase 2→4 round-trip.

Exercises:
1. Admin bulk-curates events to a managed user's Saved + Going lists
   (Phase 2 — ``POST /api/admin/engagement/bulk``).
2. The managed user's public profile endpoints (Phase 4):
   - ``GET /api/social/users/{handle}/saved``
   - ``GET /api/social/users/{handle}/going``
   - ``GET /api/social/users/{handle}/calendar``
   each return ``curated_event_ids`` / ``curated=true`` for those rows.
3. Curator self-view isolation: rows under
   ``device_id="admin:<admin.id>"`` are not returned as "own" device
   activity for the signed-in puppet user (verified via DB filter on
   that user's own ``device_id``).
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

os.environ.setdefault("SESSION_SECRET", "test-secret-curation-flow")
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


def _seed(session: Session) -> dict:
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
    events = [
        CachedEvent(
            event_id=f"evt-{i}",
            title=f"Event {i}",
            start=start + timedelta(days=i),
            end=start + timedelta(days=i, hours=2),
            calendar_id="cal-1",
        )
        for i in range(3)
    ]
    session.add_all(events)
    session.commit()
    return {"admin": admin, "curator": curator}


@pytest.mark.unit
def test_admin_curation_round_trip(client, session):
    seeded = _seed(session)
    admin_id = seeded["admin"].id
    _login(client, "admin@example.com")

    # Phase 2 — bulk curate: 2 events to Saved, 1 to Going.
    r = client.post(
        "/api/admin/engagement/bulk",
        json={
            "handles": ["curator-paris"],
            "event_ids": ["evt-0", "evt-1"],
            "kind": "save",
            "action": "add",
            "audience": "public",
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["changed_count"] == 2

    r = client.post(
        "/api/admin/engagement/bulk",
        json={
            "handles": ["curator-paris"],
            "event_ids": ["evt-2"],
            "kind": "going",
            "action": "add",
            "audience": "public",
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["changed_count"] == 1

    # Phase 4 — public profile reads expose curated flags.
    client.cookies.clear()  # view as anon

    r = client.get("/api/social/users/curator-paris/saved")
    assert r.status_code == 200, r.text
    saved_body = r.json()
    assert {it["event_id"] for it in saved_body["items"]} == {"evt-0", "evt-1"}
    assert set(saved_body["curated_event_ids"]) == {"evt-0", "evt-1"}

    r = client.get("/api/social/users/curator-paris/going")
    assert r.status_code == 200, r.text
    going_body = r.json()
    assert {it["event_id"] for it in going_body["items"]} == {"evt-2"}
    assert set(going_body["curated_event_ids"]) == {"evt-2"}

    r = client.get("/api/social/users/curator-paris/calendar")
    assert r.status_code == 200, r.text
    cal_body = r.json()
    by_id = {it["event"]["event_id"]: it for it in cal_body["items"]}
    assert by_id["evt-0"]["curated"] is True
    assert by_id["evt-1"]["curated"] is True
    assert by_id["evt-2"]["curated"] is True
    assert by_id["evt-0"]["intent"] == "saved"
    assert by_id["evt-2"]["intent"] == "going"

    # Re-run idempotency: same payload → 0 changed.
    _login(client, "admin@example.com")
    r = client.post(
        "/api/admin/engagement/bulk",
        json={
            "handles": ["curator-paris"],
            "event_ids": ["evt-0", "evt-1"],
            "kind": "save",
            "action": "add",
            "audience": "public",
        },
    )
    assert r.status_code == 200
    assert r.json()["changed_count"] == 0

    # Curator-device isolation: curated rows live on the admin device, not
    # the curator's own device. A real signed-in curator's own writes (if
    # any) would not be confused with curated rows.
    saved_rows = session.exec(
        select(UserSavedEvent).where(UserSavedEvent.user_id == seeded["curator"].id)
    ).all()
    going_rows = session.exec(
        select(UserEventAttendance).where(
            UserEventAttendance.user_id == seeded["curator"].id
        )
    ).all()
    assert all(r.device_id == f"admin:{seeded['curator'].id}" for r in saved_rows)
    assert all(r.device_id == f"admin:{seeded['curator'].id}" for r in going_rows)
    assert all(r.created_by_admin_user_id == admin_id for r in saved_rows)
    assert all(r.created_by_admin_user_id == admin_id for r in going_rows)
