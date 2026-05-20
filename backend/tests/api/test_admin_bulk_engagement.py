"""Tests for ``POST /api/admin/engagement/bulk``.

Covers:
- auth gate (require_admin)
- ownership gate: non-admin-managed targets are skipped
- happy path: cross-product writes Saved/Going with audit stamp
- idempotency: re-running is a noop
- unknown handle / unknown event id are skipped per-row
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

os.environ.setdefault("SESSION_SECRET", "test-secret-bulk-engagement")
os.environ.setdefault("ADMIN_EMAIL", "admin@example.com")
os.environ["DEV_AUTH"] = "true"

from backend.api.main import app  # noqa: E402
from backend.api.routes import auth as auth_module  # noqa: E402
from backend.api.routes import social as social_module  # noqa: E402
from backend.db.database import get_session  # noqa: E402
from backend.db.models import (  # noqa: E402
    CachedEvent,
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


def _seed(session: Session) -> dict[str, str]:
    """Create admin, one managed, one unmanaged user, and two events."""
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
    )
    civilian = User(
        email="civ@example.com",
        handle="civilian",
        display_name="Civilian",
        provider="google",
        provider_subject="mock|civ@example.com",
        is_admin_managed=False,
    )
    session.add_all([admin, curator, civilian])
    session.commit()
    start = datetime.now(timezone.utc) + timedelta(days=3)
    e1 = CachedEvent(
        event_id="evt-aaa",
        title="Salsa Night",
        start=start,
        end=start + timedelta(hours=4),
        calendar_id="cal-1",
    )
    e2 = CachedEvent(
        event_id="evt-bbb",
        title="Bachata Social",
        start=start + timedelta(days=1),
        end=start + timedelta(days=1, hours=4),
        calendar_id="cal-1",
    )
    session.add_all([e1, e2])
    session.commit()
    return {"curator": "curator-paris", "civilian": "civilian"}


@pytest.mark.unit
def test_bulk_requires_admin(client, session):
    _seed(session)
    _login(client, "curator@example.com")
    r = client.post(
        "/api/admin/engagement/bulk",
        json={
            "handles": ["curator-paris"],
            "event_ids": ["evt-aaa"],
            "kind": "save",
            "action": "add",
        },
    )
    assert r.status_code == 403


@pytest.mark.unit
def test_bulk_save_cross_product_and_audit_stamp(client, session):
    _seed(session)
    _login(client, "admin@example.com")
    r = client.post(
        "/api/admin/engagement/bulk",
        json={
            "handles": ["curator-paris"],
            "event_ids": ["evt-aaa", "evt-bbb"],
            "kind": "save",
            "action": "add",
            "audience": "public",
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["changed_count"] == 2
    assert body["skipped_count"] == 0
    assert {i["status"] for i in body["items"]} == {"changed"}

    rows = session.exec(select(UserSavedEvent)).all()
    assert len(rows) == 2
    assert all(r.created_by_admin_user_id is not None for r in rows)
    assert all(r.audience == "public" for r in rows)


@pytest.mark.unit
def test_bulk_skips_non_managed_target(client, session):
    _seed(session)
    _login(client, "admin@example.com")
    r = client.post(
        "/api/admin/engagement/bulk",
        json={
            "handles": ["civilian"],
            "event_ids": ["evt-aaa"],
            "kind": "going",
            "action": "add",
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["changed_count"] == 0
    assert body["skipped_count"] == 1
    assert body["items"][0]["status"] == "skipped_not_managed"
    rows = session.exec(select(UserEventAttendance)).all()
    assert rows == []


@pytest.mark.unit
def test_bulk_idempotent_second_call_noops(client, session):
    _seed(session)
    _login(client, "admin@example.com")
    payload = {
        "handles": ["curator-paris"],
        "event_ids": ["evt-aaa"],
        "kind": "going",
        "action": "add",
    }
    r1 = client.post("/api/admin/engagement/bulk", json=payload)
    assert r1.json()["changed_count"] == 1
    r2 = client.post("/api/admin/engagement/bulk", json=payload)
    body = r2.json()
    assert body["changed_count"] == 0
    assert body["items"][0]["status"] == "noop"


@pytest.mark.unit
def test_bulk_unknown_handle_and_event_skipped_per_row(client, session):
    _seed(session)
    _login(client, "admin@example.com")
    r = client.post(
        "/api/admin/engagement/bulk",
        json={
            "handles": ["curator-paris", "ghost"],
            "event_ids": ["evt-aaa", "evt-missing"],
            "kind": "save",
            "action": "add",
        },
    )
    assert r.status_code == 200
    statuses = sorted(i["status"] for i in r.json()["items"])
    # curator x [evt-aaa=changed, evt-missing=skipped_no_event]
    # ghost   x [evt-aaa, evt-missing] both skipped_no_user
    assert statuses == [
        "changed",
        "skipped_no_event",
        "skipped_no_user",
        "skipped_no_user",
    ]


@pytest.mark.unit
def test_bulk_remove_sweeps_curated_rows(client, session):
    _seed(session)
    _login(client, "admin@example.com")
    client.post(
        "/api/admin/engagement/bulk",
        json={
            "handles": ["curator-paris"],
            "event_ids": ["evt-aaa"],
            "kind": "save",
            "action": "add",
        },
    )
    r = client.post(
        "/api/admin/engagement/bulk",
        json={
            "handles": ["curator-paris"],
            "event_ids": ["evt-aaa"],
            "kind": "save",
            "action": "remove",
        },
    )
    assert r.status_code == 200
    assert r.json()["changed_count"] == 1
    rows = session.exec(select(UserSavedEvent)).all()
    assert rows == []
