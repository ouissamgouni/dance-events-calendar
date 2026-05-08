"""Anonymous-identity cookie dedupe tests for save/going tracking.

These tests cover the bug where an anonymous visitor could inflate
``total_saved`` / ``total_going`` simply by clearing localStorage and
re-clicking save / going (each clear minted a fresh ``device_id`` UUID
which the server treated as a brand-new identity).

The fix introduces a server-issued httpOnly ``movida_aid`` cookie that
the backend uses as the dedupe key for anonymous writers.
"""

import os

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

os.environ.setdefault("SESSION_SECRET", "test-secret-anon-id")
os.environ["DEV_AUTH"] = "true"

from backend.api.anon_id import ANON_COOKIE_NAME  # noqa: E402
from backend.api.main import app  # noqa: E402
from backend.api.routes import tracking as tracking_module  # noqa: E402
from backend.db.database import get_session  # noqa: E402
from backend.db.models import UserEventAttendance, UserSavedEvent  # noqa: E402


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
def client(engine):
    def _override():
        with Session(engine) as s:
            yield s

    app.dependency_overrides[get_session] = _override
    tracking_module.limiter.reset()
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def _save(client: TestClient, *, event_id: str, device_id: str):
    return client.post(
        "/api/track/event-save",
        json={
            "event_id": event_id,
            "device_id": device_id,
            "action": "save",
            "record_analytics": False,
        },
    )


def _going(client: TestClient, *, event_id: str, device_id: str):
    return client.post(
        "/api/track/event-attendance",
        json={
            "event_id": event_id,
            "device_id": device_id,
            "action": "going",
            "record_analytics": False,
        },
    )


@pytest.mark.unit
def test_save_sets_anon_id_cookie_on_first_call(client, engine):
    resp = _save(client, event_id="evt-1", device_id="dev-A")
    assert resp.status_code == 201
    assert ANON_COOKIE_NAME in resp.cookies
    # Subsequent call reuses the cookie — no new Set-Cookie header.
    resp2 = _save(client, event_id="evt-1", device_id="dev-A")
    assert resp2.status_code == 201
    assert ANON_COOKIE_NAME not in resp2.cookies


@pytest.mark.unit
def test_anonymous_save_dedupes_across_device_id_changes(client, engine):
    """Reproduces bug #1: clearing localStorage mints a new device_id; the
    cookie-based dedupe must keep total_saved == 1 across rotated device_ids."""
    r1 = _save(client, event_id="evt-X", device_id="dev-original")
    assert r1.status_code == 201
    # Simulate localStorage.clear(): a new device_id is sent on the next call,
    # but the same anon-id cookie is still attached by the TestClient.
    r2 = _save(client, event_id="evt-X", device_id="dev-rotated-1")
    assert r2.status_code == 201
    r3 = _save(client, event_id="evt-X", device_id="dev-rotated-2")
    assert r3.status_code == 201

    with Session(engine) as s:
        rows = s.exec(
            select(UserSavedEvent).where(UserSavedEvent.event_id == "evt-X")
        ).all()
    assert len(rows) == 1


@pytest.mark.unit
def test_anonymous_going_dedupes_across_device_id_changes(client, engine):
    r1 = _going(client, event_id="evt-Y", device_id="dev-original")
    assert r1.status_code == 201
    r2 = _going(client, event_id="evt-Y", device_id="dev-rotated")
    assert r2.status_code == 201

    with Session(engine) as s:
        rows = s.exec(
            select(UserEventAttendance).where(
                UserEventAttendance.event_id == "evt-Y"
            )
        ).all()
    assert len(rows) == 1


@pytest.mark.unit
def test_anonymous_dedupes_independently_per_browser(engine):
    """Two separate clients (different cookie jars) → two separate anon ids → 2 rows."""
    def _override():
        with Session(engine) as s:
            yield s

    app.dependency_overrides[get_session] = _override
    tracking_module.limiter.reset()
    try:
        c1 = TestClient(app)
        c2 = TestClient(app)
        assert _save(c1, event_id="evt-Z", device_id="d1").status_code == 201
        assert _save(c2, event_id="evt-Z", device_id="d2").status_code == 201
    finally:
        app.dependency_overrides.clear()

    with Session(engine) as s:
        rows = s.exec(
            select(UserSavedEvent).where(UserSavedEvent.event_id == "evt-Z")
        ).all()
    assert len(rows) == 2


@pytest.mark.unit
def test_save_then_unsave_then_save_does_not_double_count(client, engine):
    """Toggling off and on again must not insert a second row."""
    assert _save(client, event_id="evt-T", device_id="d").status_code == 201
    r = client.post(
        "/api/track/event-save",
        json={
            "event_id": "evt-T",
            "device_id": "d",
            "action": "unsave",
            "record_analytics": False,
        },
    )
    assert r.status_code == 201
    assert _save(client, event_id="evt-T", device_id="d").status_code == 201

    with Session(engine) as s:
        rows = s.exec(
            select(UserSavedEvent).where(UserSavedEvent.event_id == "evt-T")
        ).all()
    assert len(rows) == 1
