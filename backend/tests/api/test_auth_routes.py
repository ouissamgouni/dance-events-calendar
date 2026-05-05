"""Tests for the user-account auth routes (Sign in with Google + GDPR delete).

Uses an in-memory SQLite engine and a per-test session override so the routes
exercise the real SQLModel queries (merging anon device data, soft-delete,
share-token claim, etc.).
"""

import os
import time
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

# A stable session secret so token signing is deterministic across the test run.
os.environ.setdefault("SESSION_SECRET", "test-secret-for-auth-routes")
# The auth flow checks ADMIN_EMAIL to set is_admin in the cookie/me payload.
os.environ.setdefault("ADMIN_EMAIL", "admin@example.com")
# We want the dev/mock auth path so we don't need a real Google ID token.
os.environ["DEV_AUTH"] = "true"

from backend.api.main import app  # noqa: E402
from backend.api.routes import auth as auth_module  # noqa: E402
from backend.db.database import get_session  # noqa: E402
from backend.db.models import (  # noqa: E402
    ShareToken,
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
    """TestClient wired to the in-memory DB. Resets the slowapi limiter
    in-process state between tests so per-IP counters don't leak."""

    def _override():
        with Session(engine) as s:
            yield s

    app.dependency_overrides[get_session] = _override
    # Reset the rate limiter's per-IP counters between tests.
    auth_module.limiter.reset()
    try:
        # NOTE: do NOT use `with TestClient(app)` — that triggers the FastAPI
        # lifespan which calls init_db() against the real Postgres URL.
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def _login(client: TestClient, *, email: str, device_id: str | None = None):
    """Drive POST /api/auth/google via the DEV_AUTH dev path.

    The dev path now picks identity from `mock_email` (any email), so tests
    can sign in as admin or regular users by passing a different email.
    `is_admin` is derived from email == get_admin_email() inside the route.
    """
    body: dict = {"credential": "ignored-in-mock", "mock_email": email}
    if device_id is not None:
        body["device_id"] = device_id
    return client.post("/api/auth/google", json=body)


@pytest.mark.unit
def test_auth_google_creates_user_on_first_login(client, session, monkeypatch):
    monkeypatch.setattr(auth_module, "get_admin_email", lambda: "alice@example.com")

    resp = _login(client, email="alice@example.com")
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["email"] == "alice@example.com"
    assert data["is_admin"] is True  # ADMIN_EMAIL was patched to match
    assert data["user_id"]

    users = session.exec(select(User)).all()
    assert len(users) == 1
    assert users[0].provider == "google"
    assert users[0].provider_subject == "mock|alice@example.com"


@pytest.mark.unit
def test_auth_google_reuses_user_on_repeat_login(client, session, monkeypatch):
    monkeypatch.setattr(auth_module, "get_admin_email", lambda: "alice@example.com")

    r1 = _login(client, email="alice@example.com")
    assert r1.status_code == 200
    r2 = _login(client, email="alice@example.com")
    assert r2.status_code == 200

    users = session.exec(select(User)).all()
    assert len(users) == 1
    assert r1.json()["user_id"] == r2.json()["user_id"]


@pytest.mark.unit
def test_auth_google_merges_anonymous_device_data(client, session, monkeypatch):
    monkeypatch.setattr(auth_module, "get_admin_email", lambda: "alice@example.com")

    device_id = "dev-abc"
    # Pre-existing anonymous rows tied only to a device.
    session.add(UserSavedEvent(device_id=device_id, event_id="evt-1", user_id=None))
    session.add(
        UserEventAttendance(device_id=device_id, event_id="evt-2", user_id=None)
    )
    session.add(ShareToken(token="tok-anon", device_id=device_id, user_id=None))
    session.commit()

    resp = _login(client, email="alice@example.com", device_id=device_id)
    assert resp.status_code == 200
    user_id = resp.json()["user_id"]

    saved = session.exec(select(UserSavedEvent)).all()
    assert len(saved) == 1
    assert str(saved[0].user_id) == user_id

    attending = session.exec(select(UserEventAttendance)).all()
    assert len(attending) == 1
    assert str(attending[0].user_id) == user_id

    share = session.exec(select(ShareToken)).all()
    assert len(share) == 1
    assert str(share[0].user_id) == user_id


@pytest.mark.unit
def test_auth_me_returns_is_admin_true_for_admin_email(client, monkeypatch):
    monkeypatch.setattr(auth_module, "get_admin_email", lambda: "admin@example.com")
    login_resp = _login(client, email="admin@example.com")
    assert login_resp.status_code == 200

    me = client.get("/api/auth/me")
    assert me.status_code == 200
    assert me.json()["is_admin"] is True
    assert me.json()["email"] == "admin@example.com"


@pytest.mark.unit
def test_auth_me_returns_is_admin_false_for_regular_user(client, monkeypatch):
    monkeypatch.setattr(auth_module, "get_admin_email", lambda: "bob@example.com")
    login_resp = _login(client, email="alice@example.com")
    assert login_resp.status_code == 200

    me = client.get("/api/auth/me")
    assert me.status_code == 200
    body = me.json()
    assert body["email"] == "alice@example.com"
    assert body["is_admin"] is False


@pytest.mark.unit
def test_mock_login_default_is_non_admin(client, session, monkeypatch):
    """With no mock_email supplied, the dev path uses dev-user@example.com
    and the resulting user is NOT admin (was the original bug)."""
    monkeypatch.setattr(auth_module, "get_admin_email", lambda: "admin@example.com")
    resp = client.post("/api/auth/google", json={"credential": "ignored"})
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["email"] == "dev-user@example.com"
    assert data["is_admin"] is False


@pytest.mark.unit
def test_mock_email_rejected_when_not_dev_mode(client, monkeypatch):
    """Outside dev mode the route must refuse caller-supplied identities."""
    monkeypatch.setattr(auth_module, "_is_dev_auth", lambda: False)
    # Provide a valid client_id so we don't 500 before reaching the check.
    monkeypatch.setattr(auth_module, "get_google_client_id", lambda: "any")
    resp = client.post(
        "/api/auth/google",
        json={"credential": "x", "mock_email": "attacker@example.com"},
    )
    assert resp.status_code == 400
    assert "mock_email" in resp.json()["detail"]


@pytest.mark.unit
def test_dev_users_endpoint_empty_when_not_dev_mode(client, monkeypatch):
    monkeypatch.setattr(auth_module, "_is_dev_auth", lambda: False)
    resp = client.get("/api/auth/dev-users")
    assert resp.status_code == 200
    assert resp.json() == {"users": []}


@pytest.mark.unit
def test_dev_users_endpoint_returns_seeded_users(client, monkeypatch, tmp_path):
    """With SCENARIO_DIR pointing at a dir containing mock-users.yaml, the
    endpoint returns the parsed users."""
    (tmp_path / "mock-users.yaml").write_text(
        "users:\n"
        "  - email: Alice@Example.com\n"
        "    name: Alice\n"
        "  - email: bob@example.com\n"  # name omitted on purpose
        "  - email: not-an-email\n"  # silently dropped
    )
    monkeypatch.setenv("SCENARIO_DIR", str(tmp_path))
    resp = client.get("/api/auth/dev-users")
    assert resp.status_code == 200
    users = resp.json()["users"]
    assert users == [
        {"email": "alice@example.com", "name": "Alice"},
        {"email": "bob@example.com", "name": "bob"},
    ]


@pytest.mark.unit
def test_delete_me_removes_user_and_personal_rows(client, session, monkeypatch):
    monkeypatch.setattr(auth_module, "get_admin_email", lambda: "alice@example.com")

    device_id = "dev-del"
    login_resp = _login(client, email="alice@example.com", device_id=device_id)
    assert login_resp.status_code == 200
    user_id = UUID(login_resp.json()["user_id"])

    # Add some personal rows so there is something to delete.
    session.add(UserSavedEvent(device_id=device_id, event_id="evt-9", user_id=user_id))
    session.add(
        UserEventAttendance(device_id=device_id, event_id="evt-9", user_id=user_id)
    )
    session.add(ShareToken(token="tok-del", device_id=device_id, user_id=user_id))
    session.commit()

    resp = client.delete("/api/auth/me")
    assert resp.status_code == 200
    assert resp.json()["status"] == "deleted"

    # Personal rows are gone.
    assert session.exec(select(UserSavedEvent)).all() == []
    assert session.exec(select(UserEventAttendance)).all() == []
    assert session.exec(select(ShareToken)).all() == []

    # User row is soft-deleted + anonymized.
    db_user = session.get(User, user_id)
    assert db_user is not None
    assert db_user.deleted_at is not None
    assert db_user.email.startswith("deleted-")
    assert db_user.provider_subject is None

    # Cookie was cleared → /me now 401s.
    me = client.get("/api/auth/me")
    assert me.status_code == 401


@pytest.mark.unit
def test_auth_google_rate_limit_returns_429_after_threshold(client, monkeypatch):
    """The route is decorated @limiter.limit("10/minute"); the 11th call from
    the same IP within the window must return 429."""
    monkeypatch.setattr(auth_module, "get_admin_email", lambda: "alice@example.com")

    statuses = []
    for _ in range(11):
        statuses.append(_login(client, email="alice@example.com").status_code)
        # Tiny sleep avoids any per-second rounding edge in slowapi.
        time.sleep(0.001)

    assert statuses[:10] == [200] * 10, statuses
    assert statuses[10] == 429, statuses


@pytest.mark.unit
def test_saved_events_route_uses_user_when_authed(client, session, monkeypatch):
    """/api/auth/saved-events returns event_ids saved across all the user's
    devices, regardless of which device cookie is present."""
    monkeypatch.setattr(auth_module, "get_admin_email", lambda: "alice@example.com")

    device_a = "dev-A"
    login_resp = _login(client, email="alice@example.com", device_id=device_a)
    assert login_resp.status_code == 200
    user_id = UUID(login_resp.json()["user_id"])

    # Saves from two different devices, both linked to the same user.
    session.add(UserSavedEvent(device_id=device_a, event_id="evt-1", user_id=user_id))
    session.add(UserSavedEvent(device_id="dev-B", event_id="evt-2", user_id=user_id))
    # And one anonymous row that must NOT show up.
    session.add(UserSavedEvent(device_id="dev-X", event_id="evt-other", user_id=None))
    session.commit()

    resp = client.get("/api/auth/saved-events")
    assert resp.status_code == 200
    assert resp.json() == {"event_ids": ["evt-1", "evt-2"]}


@pytest.mark.unit
def test_saves_persist_across_logout_and_relogin(client, session, monkeypatch):
    """Simulates the scenario:
    1. Anonymous user (device A) saves 2 events via /track/event-save.
    2. Same browser signs in as Dev User -> merge attributes saves to user.
    3. /api/auth/saved-events returns those 2 saves.
    4. User logs out, then logs back in (same browser, same device).
    5. /api/auth/saved-events MUST still return those 2 saves.
    Also covers the cross-device case: a fresh device that has never seen
    the events still gets the user's saves on first login.
    """
    monkeypatch.setattr(auth_module, "get_admin_email", lambda: "admin@example.com")
    device_a = "dev-A"

    # Step 1: anonymous saves on device A.
    for evt in ["evt-acct-001", "evt-acct-002"]:
        r = client.post(
            "/api/track/event-save",
            json={
                "event_id": evt,
                "device_id": device_a,
                "action": "save",
                "record_analytics": False,
            },
        )
        assert r.status_code == 201, r.text

    # Step 2: sign in.
    login1 = _login(client, email="dev-user@example.com", device_id=device_a)
    assert login1.status_code == 200
    user_id = login1.json()["user_id"]

    # Step 3: saves attributed to user.
    saved1 = client.get("/api/auth/saved-events")
    assert saved1.status_code == 200
    assert sorted(saved1.json()["event_ids"]) == ["evt-acct-001", "evt-acct-002"]

    # Step 4: log out then log back in.
    logout = client.post("/api/auth/logout")
    assert logout.status_code == 200
    login2 = _login(client, email="dev-user@example.com", device_id=device_a)
    assert login2.status_code == 200
    assert login2.json()["user_id"] == user_id  # same user row

    # Step 5: saves still visible.
    saved2 = client.get("/api/auth/saved-events")
    assert saved2.status_code == 200
    assert sorted(saved2.json()["event_ids"]) == ["evt-acct-001", "evt-acct-002"]

    # Cross-device: fresh device B logs in as same user -> sees the saves.
    fresh = TestClient(app)
    login3 = fresh.post(
        "/api/auth/google",
        json={
            "credential": "ignored-in-mock",
            "mock_email": "dev-user@example.com",
            "device_id": "dev-B",
        },
    )
    assert login3.status_code == 200, login3.text
    saved3 = fresh.get("/api/auth/saved-events")
    assert saved3.status_code == 200
    assert sorted(saved3.json()["event_ids"]) == ["evt-acct-001", "evt-acct-002"]


@pytest.mark.unit
def test_share_link_includes_saved_and_attending_events(client, session, monkeypatch):
    """The shared calendar must mirror My Calendar = saved \u222a attending."""
    from backend.db.models import CalendarSetting, CachedEvent
    from datetime import datetime, timedelta

    monkeypatch.setattr(auth_module, "get_admin_email", lambda: "admin@example.com")
    device_a = "dev-share"
    login = _login(client, email="dev-user@example.com", device_id=device_a)
    assert login.status_code == 200
    user_id = UUID(login.json()["user_id"])

    # Enable a calendar and pre-load events into the cache.
    session.add(
        CalendarSetting(calendar_id="cal-1", name="Cal 1", enabled=True, color="#fff")
    )
    now = datetime.utcnow()
    for evt in ["evt-saved-1", "evt-attending-1", "evt-both"]:
        session.add(
            CachedEvent(
                event_id=evt,
                calendar_id="cal-1",
                title=evt,
                start=now,
                end=now + timedelta(hours=2),
            )
        )
    session.add(
        UserSavedEvent(device_id=device_a, event_id="evt-saved-1", user_id=user_id)
    )
    session.add(
        UserSavedEvent(device_id=device_a, event_id="evt-both", user_id=user_id)
    )
    session.add(
        UserEventAttendance(
            device_id=device_a, event_id="evt-attending-1", user_id=user_id
        )
    )
    session.add(
        UserEventAttendance(device_id=device_a, event_id="evt-both", user_id=user_id)
    )
    session.commit()

    # Mint share token for this user.
    create = client.post("/api/share/calendar", json={"device_id": device_a})
    assert create.status_code == 201, create.text
    token = create.json()["token"]

    resp = client.get(f"/api/share/calendar/{token}")
    assert resp.status_code == 200, resp.text
    returned = sorted(e["event_id"] for e in resp.json()["events"])
    assert returned == ["evt-attending-1", "evt-both", "evt-saved-1"]
