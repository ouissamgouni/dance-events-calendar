"""Tests for the user-account auth routes (Sign in with Google + GDPR delete).

Uses an in-memory SQLite engine and a per-test session override so the routes
exercise the real SQLModel queries (merging anon device data, soft-delete,
share-token claim, etc.).
"""

import os
import time
from datetime import datetime, timedelta
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
from backend.db import seed as seed_module  # noqa: E402
from backend.db.models import (  # noqa: E402
    BlockedUserIdentity,
    CalendarSubscription,
    EmailLoginCode,
    ShareToken,
    User,
    UserEventAttendance,
    UserFollow,
    UserSavedEvent,
)

_REAL_NOTIFY_ADMIN_NEW_USER = auth_module._notify_admin_new_user


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


@pytest.fixture(autouse=True)
def disable_admin_signup_email(monkeypatch):
    monkeypatch.setattr(auth_module, "_notify_admin_new_user", lambda user_id: None)


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
    assert data["is_new_user"] is True

    users = session.exec(select(User)).all()
    assert len(users) == 1
    assert users[0].provider == "google"
    assert users[0].provider_subject == "mock|alice@example.com"


@pytest.mark.unit
def test_auth_google_reuses_user_on_repeat_login(client, session, monkeypatch):
    monkeypatch.setattr(auth_module, "get_admin_email", lambda: "alice@example.com")

    r1 = _login(client, email="alice@example.com")
    assert r1.status_code == 200
    assert r1.json()["is_new_user"] is True
    r2 = _login(client, email="alice@example.com")
    assert r2.status_code == 200
    assert r2.json()["is_new_user"] is False

    users = session.exec(select(User)).all()
    assert len(users) == 1
    assert r1.json()["user_id"] == r2.json()["user_id"]


@pytest.mark.unit
def test_auth_google_notifies_admin_only_on_first_signup(client, monkeypatch):
    sent_users = []
    monkeypatch.setattr(auth_module, "get_admin_email", lambda: "admin@example.com")
    monkeypatch.setattr(
        auth_module,
        "_notify_admin_new_user",
        lambda user: sent_users.append(user),
    )

    r1 = _login(client, email="alice@example.com")
    assert r1.status_code == 200, r1.text
    assert r1.json()["is_new_user"] is True

    r2 = _login(client, email="alice@example.com")
    assert r2.status_code == 200, r2.text
    assert r2.json()["is_new_user"] is False

    assert [user.id for user in sent_users] == [UUID(r1.json()["user_id"])]


@pytest.mark.unit
def test_notify_admin_new_user_skips_when_admin_email_empty(monkeypatch):
    sent = []
    monkeypatch.setattr(
        auth_module, "_notify_admin_new_user", _REAL_NOTIFY_ADMIN_NEW_USER
    )
    monkeypatch.setattr(auth_module, "get_admin_email", lambda: "")
    monkeypatch.setattr(
        auth_module,
        "send_new_user_notification",
        lambda user, admin_email: sent.append((user, admin_email)),
    )

    auth_module._notify_admin_new_user(UUID("00000000-0000-0000-0000-000000000001"))

    assert sent == []


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
def test_dev_users_endpoint_falls_back_to_default_users(client, monkeypatch, tmp_path):
    scenarios_dir = tmp_path / "scenarios"
    scenario_dir = scenarios_dir / "sparse"
    default_dir = scenarios_dir / "default"
    scenario_dir.mkdir(parents=True)
    default_dir.mkdir()
    (default_dir / "mock-users.yaml").write_text(
        "users:\n  - email: Default@Example.com\n    name: Default User\n"
    )
    monkeypatch.setenv("SCENARIO_DIR", str(scenario_dir))
    monkeypatch.setattr(seed_module, "SCENARIOS_DIR", scenarios_dir)

    resp = client.get("/api/auth/dev-users")

    assert resp.status_code == 200
    assert resp.json()["users"] == [
        {"email": "default@example.com", "name": "Default User"}
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
    assert db_user.provider_subject == "mock|alice@example.com"

    # Cookie was cleared → /me now 401s.
    me = client.get("/api/auth/me")
    assert me.status_code == 401


@pytest.mark.unit
def test_delete_me_reactivates_same_user_on_repeat_signup(client, session, monkeypatch):
    monkeypatch.setattr(auth_module, "get_admin_email", lambda: "admin@example.com")

    first_login = _login(client, email="alice@example.com")
    assert first_login.status_code == 200
    user_id = UUID(first_login.json()["user_id"])
    provider_subject = "mock|alice@example.com"

    db_user = session.get(User, user_id)
    assert db_user is not None
    db_user.onboarded_at = datetime.utcnow()
    session.add(db_user)
    session.commit()

    first_delete = client.delete("/api/auth/me")
    assert first_delete.status_code == 200

    second_login = _login(client, email="alice@example.com")
    assert second_login.status_code == 200
    assert second_login.json()["user_id"] == str(user_id)
    assert second_login.json()["email"] == "alice@example.com"
    assert second_login.json()["is_new_user"] is False
    assert second_login.json()["onboarded_at"] is None

    session.expire_all()
    reactivated_user = session.get(User, user_id)
    assert reactivated_user is not None
    assert reactivated_user.onboarded_at is None

    second_delete = client.delete("/api/auth/me")
    assert second_delete.status_code == 200

    session.expire_all()
    rows = session.exec(
        select(User).where(User.provider_subject == provider_subject)
    ).all()
    assert len(rows) == 1
    assert rows[0].id == user_id
    assert rows[0].deleted_at is not None
    assert rows[0].email.startswith("deleted-")


@pytest.mark.unit
def test_admin_block_prevents_signup_until_revoked(client, session, monkeypatch):
    monkeypatch.setattr(auth_module, "get_admin_email", lambda: "admin@example.com")

    victim_login = _login(client, email="victim@example.com")
    assert victim_login.status_code == 200
    victim_id = UUID(victim_login.json()["user_id"])

    admin_login = _login(client, email="admin@example.com")
    assert admin_login.status_code == 200
    admin_cookie = client.cookies.get("session_token")

    block = client.post(
        f"/api/social/admin/users/id/{victim_id}/block",
        json={"reason": "spam"},
    )
    assert block.status_code == 200, block.text
    block_id = block.json()["id"]
    assert block.json()["reason"] == "spam"

    blocked_login = _login(client, email="victim@example.com")
    assert blocked_login.status_code == 403
    assert blocked_login.json()["detail"] == "This account is blocked from signing in"
    assert client.cookies.get("session_token") == admin_cookie

    session.expire_all()
    row = session.get(BlockedUserIdentity, block_id)
    assert row is not None
    assert row.revoked_at is None

    revoked = client.delete(f"/api/social/admin/user-blocks/{block_id}")
    assert revoked.status_code == 200, revoked.text
    assert revoked.json()["revoked_at"] is not None

    unblocked_login = _login(client, email="victim@example.com")
    assert unblocked_login.status_code == 200
    assert unblocked_login.json()["user_id"] == str(victim_id)


@pytest.mark.unit
def test_delete_me_does_not_create_signup_block(client, session, monkeypatch):
    monkeypatch.setattr(auth_module, "get_admin_email", lambda: "admin@example.com")

    login = _login(client, email="delete-only@example.com")
    assert login.status_code == 200
    delete = client.delete("/api/auth/me")
    assert delete.status_code == 200

    assert session.exec(select(BlockedUserIdentity)).all() == []


@pytest.mark.unit
def test_delete_me_drops_follows_and_subscriptions(client, session, monkeypatch):
    """Regression: account deletion must clear social edges in BOTH directions
    so other users' follower / friend / subscription counts shrink instead of
    counting a ghost row pointing at a soft-deleted user."""
    monkeypatch.setattr(auth_module, "get_admin_email", lambda: "admin@example.com")

    alice = _login(client, email="alice@example.com", device_id="dev-a")
    assert alice.status_code == 200
    alice_id = UUID(alice.json()["user_id"])

    carol = _login(client, email="carol@example.com", device_id="dev-c")
    assert carol.status_code == 200
    carol_id = UUID(carol.json()["user_id"])

    # Carol follows Alice and subscribes to her calendar.
    session.add(UserFollow(follower_id=carol_id, followee_id=alice_id))
    session.add(CalendarSubscription(subscriber_id=carol_id, target_user_id=alice_id))
    session.commit()

    # Carol deletes her account (current cookie is Carol's from last _login).
    resp = client.delete("/api/auth/me")
    assert resp.status_code == 200

    # Edges in both directions are gone — Alice's follower count drops to 0.
    assert session.exec(select(UserFollow)).all() == []
    assert session.exec(select(CalendarSubscription)).all() == []


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
    # Force ``audience='public'`` so the existing assertion remains the
    # contract under test (the model default flipped to ``friends`` for
    # privacy-by-default; this test checks cross-device aggregation, not
    # the audience default).
    session.add(
        UserSavedEvent(
            device_id=device_a, event_id="evt-1", user_id=user_id, audience="public"
        )
    )
    session.add(
        UserSavedEvent(
            device_id="dev-B", event_id="evt-2", user_id=user_id, audience="public"
        )
    )
    # And one anonymous row that must NOT show up.
    session.add(UserSavedEvent(device_id="dev-X", event_id="evt-other", user_id=None))
    session.commit()

    resp = client.get("/api/auth/saved-events")
    assert resp.status_code == 200
    body = resp.json()
    assert body["event_ids"] == ["evt-1", "evt-2"]
    assert body["events"] == [
        {"event_id": "evt-1", "audience": "public"},
        {"event_id": "evt-2", "audience": "public"},
    ]


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


@pytest.mark.unit
def test_anonymous_attendance_inherits_share_default_on_signup(
    client, session, monkeypatch
):
    """Bug #2: anonymous "going" rows must adopt the user's
    share_attendance_default when they sign up, so the user appears in
    their own avatar stack without re-toggling."""
    monkeypatch.setattr(auth_module, "get_admin_email", lambda: "admin@example.com")

    device_id = "dev-merge-share"
    # Anonymous "going" row — share_publicly defaults to False for anon.
    session.add(
        UserEventAttendance(
            device_id=device_id,
            event_id="evt-share-1",
            user_id=None,
            share_publicly=False,
        )
    )
    session.commit()

    resp = _login(client, email="dev-user@example.com", device_id=device_id)
    assert resp.status_code == 200
    user_id = UUID(resp.json()["user_id"])

    rows = session.exec(
        select(UserEventAttendance).where(UserEventAttendance.event_id == "evt-share-1")
    ).all()
    assert len(rows) == 1
    assert rows[0].user_id == user_id
    # Default is True (see User.share_attendance_default in db/models.py).
    assert rows[0].share_publicly is True


@pytest.mark.unit
def test_merge_uses_anon_id_cookie_in_addition_to_device_id(
    client, session, monkeypatch
):
    """If the anonymous rows were keyed by the server-issued anon-id cookie
    (different from the legacy localStorage device_id), the merge must
    still claim them on sign-up."""
    monkeypatch.setattr(auth_module, "get_admin_email", lambda: "admin@example.com")
    from backend.api.anon_id import ANON_COOKIE_NAME

    anon_cookie = "cookie-anon-xyz"
    legacy_device = "dev-legacy"

    # The cookie-keyed row is what /track/* writes today for an anon user.
    session.add(
        UserSavedEvent(device_id=anon_cookie, event_id="evt-cookie", user_id=None)
    )
    # And a legacy row keyed by the localStorage device_id (pre-cookie clients).
    session.add(
        UserSavedEvent(device_id=legacy_device, event_id="evt-legacy", user_id=None)
    )
    session.commit()

    client.cookies.set(ANON_COOKIE_NAME, anon_cookie)
    resp = _login(client, email="dev-user@example.com", device_id=legacy_device)
    assert resp.status_code == 200
    user_id = UUID(resp.json()["user_id"])

    rows = session.exec(
        select(UserSavedEvent).where(UserSavedEvent.user_id == user_id)
    ).all()
    assert {r.event_id for r in rows} == {"evt-cookie", "evt-legacy"}


@pytest.mark.unit
def test_logout_clears_anon_id_cookie(client, session, monkeypatch):
    """Logout must clear the httpOnly ``movida_aid`` cookie so the next
    anonymous session on this browser is a fresh server-side identity.
    Without this, anonymous saves/going made after logout would attach to
    the previous user's anonymous dedupe identity."""
    monkeypatch.setattr(auth_module, "get_admin_email", lambda: "admin@example.com")
    from backend.api.anon_id import ANON_COOKIE_NAME

    # Mint the cookie via an anonymous save first.
    r = client.post(
        "/api/track/event-save",
        json={
            "event_id": "evt-cookie-clear",
            "device_id": "dev-cookie-clear",
            "action": "save",
            "record_analytics": False,
        },
    )
    assert r.status_code == 201
    assert client.cookies.get(ANON_COOKIE_NAME)

    # Sign in then sign out.
    login = _login(client, email="dev-user@example.com", device_id="dev-cookie-clear")
    assert login.status_code == 200
    logout = client.post("/api/auth/logout")
    assert logout.status_code == 200
    # The Set-Cookie header on the logout response must clear movida_aid.
    set_cookie_headers = (
        logout.headers.get_list("set-cookie")
        if hasattr(logout.headers, "get_list")
        else [v for k, v in logout.headers.items() if k.lower() == "set-cookie"]
    )
    assert any(
        ANON_COOKIE_NAME in h and ("Max-Age=0" in h or "expires=" in h.lower())
        for h in set_cookie_headers
    ), set_cookie_headers


@pytest.mark.unit
def test_delete_me_clears_anon_id_cookie(client, session, monkeypatch):
    """Same expectation as logout, for the GDPR account-delete path."""
    monkeypatch.setattr(auth_module, "get_admin_email", lambda: "admin@example.com")
    from backend.api.anon_id import ANON_COOKIE_NAME

    login = _login(client, email="dev-user@example.com", device_id="dev-delete-me")
    assert login.status_code == 200
    # Trigger cookie mint via any tracked write.
    client.post(
        "/api/track/event-save",
        json={
            "event_id": "evt-delete-me",
            "device_id": "dev-delete-me",
            "action": "save",
            "record_analytics": False,
        },
    )
    delete = client.delete("/api/auth/me")
    assert delete.status_code == 200
    set_cookie_headers = (
        delete.headers.get_list("set-cookie")
        if hasattr(delete.headers, "get_list")
        else [v for k, v in delete.headers.items() if k.lower() == "set-cookie"]
    )
    assert any(
        ANON_COOKIE_NAME in h and ("Max-Age=0" in h or "expires=" in h.lower())
        for h in set_cookie_headers
    ), set_cookie_headers


@pytest.mark.unit
def test_anonymous_get_saved_events_returns_cookie_identity(client, session):
    """``GET /api/auth/saved-events`` must work for anonymous callers and
    return rows owned by the ``movida_aid`` cookie identity, so the
    frontend can replace its local cache from server truth without
    requiring a sign-in first."""
    from backend.api.anon_id import ANON_COOKIE_NAME

    # Anonymous save mints the cookie.
    r = client.post(
        "/api/track/event-save",
        json={
            "event_id": "evt-anon-read",
            "device_id": "dev-anon-read",
            "action": "save",
            "record_analytics": False,
        },
    )
    assert r.status_code == 201
    assert client.cookies.get(ANON_COOKIE_NAME)

    saved = client.get("/api/auth/saved-events")
    assert saved.status_code == 200
    assert saved.json()["event_ids"] == ["evt-anon-read"]


@pytest.mark.unit
def test_anonymous_get_saved_events_empty_without_cookie(client, session):
    """No cookie, no authed user -> empty list (not 401)."""
    saved = client.get("/api/auth/saved-events")
    assert saved.status_code == 200
    assert saved.json()["event_ids"] == []


@pytest.mark.unit
def test_anonymous_get_attending_events_returns_cookie_identity(client, session):
    """Same anon-read contract for attending events."""
    from backend.api.anon_id import ANON_COOKIE_NAME

    r = client.post(
        "/api/track/event-attendance",
        json={
            "event_id": "evt-anon-attending",
            "device_id": "dev-anon-attending",
            "action": "going",
            "record_analytics": False,
        },
    )
    assert r.status_code == 201
    assert client.cookies.get(ANON_COOKIE_NAME)

    attending = client.get("/api/auth/attending-events")
    assert attending.status_code == 200
    body = attending.json()
    assert body["event_ids"] == ["evt-anon-attending"]
    # Anonymous rows can never opt in to public sharing.
    assert body["events"] == [
        {
            "event_id": "evt-anon-attending",
            "share_publicly": False,
            "share_audience": "private",
        }
    ]


# --- needs_onboarding gating (onboarding_version bump) ---------------------


@pytest.mark.unit
def test_auth_google_reports_needs_onboarding_true_for_new_user(client, monkeypatch):
    monkeypatch.setattr(auth_module, "get_current_onboarding_version", lambda: 2)
    r = _login(client, email="new@example.com")
    assert r.status_code == 200
    assert r.json()["needs_onboarding"] is True


@pytest.mark.unit
def test_auth_google_reports_needs_onboarding_false_after_completion(
    client, session, monkeypatch
):
    monkeypatch.setattr(auth_module, "get_current_onboarding_version", lambda: 2)
    _login(client, email="alice@example.com")
    user = session.exec(select(User).where(User.email == "alice@example.com")).one()
    user.onboarded_at = datetime.utcnow()
    user.onboarding_version = 2
    session.add(user)
    session.commit()

    r = _login(client, email="alice@example.com")
    assert r.status_code == 200
    body = r.json()
    assert body["needs_onboarding"] is False
    assert body["onboarded_at"] is not None

    me = client.get("/api/auth/me")
    assert me.json()["needs_onboarding"] is False


@pytest.mark.unit
def test_auth_google_forces_re_onboarding_when_version_bumped(
    client, session, monkeypatch
):
    """Users who onboarded at an older version get sent back through."""
    monkeypatch.setattr(auth_module, "get_current_onboarding_version", lambda: 3)
    _login(client, email="alice@example.com")
    user = session.exec(select(User).where(User.email == "alice@example.com")).one()
    user.onboarded_at = datetime.utcnow()
    user.onboarding_version = 1  # older version than current (3)
    session.add(user)
    session.commit()

    r = _login(client, email="alice@example.com")
    assert r.status_code == 200
    assert r.json()["needs_onboarding"] is True

    me = client.get("/api/auth/me")
    assert me.json()["needs_onboarding"] is True


# ── Email one-time-code sign-in ────────────────────────────────────────


def _request_code(client: TestClient, email: str):
    return client.post("/api/auth/email-code/request", json={"email": email})


def _verify_code(
    client: TestClient, email: str, code: str, device_id: str | None = None
):
    body: dict = {"email": email, "code": code}
    if device_id is not None:
        body["device_id"] = device_id
    return client.post("/api/auth/email-code/verify", json=body)


@pytest.mark.unit
def test_email_code_request_returns_dev_code_and_stores_hash(client, session):
    resp = _request_code(client, "alice@example.com")
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["sent"] is True
    assert data["expires_in"] == 600
    assert data["dev_code"] and len(data["dev_code"]) == 6

    rows = session.exec(select(EmailLoginCode)).all()
    assert len(rows) == 1
    # The plaintext code is never stored — only its SHA-256 hash.
    assert rows[0].code_hash != data["dev_code"]
    assert rows[0].email == "alice@example.com"
    assert rows[0].consumed_at is None


@pytest.mark.unit
def test_email_code_request_rejects_invalid_email(client):
    resp = _request_code(client, "not-an-email")
    assert resp.status_code == 400


@pytest.mark.unit
def test_email_code_request_resend_cooldown(client):
    first = _request_code(client, "alice@example.com")
    assert first.status_code == 200
    second = _request_code(client, "alice@example.com")
    assert second.status_code == 429


@pytest.mark.unit
def test_email_code_verify_creates_email_user(client, session, monkeypatch):
    monkeypatch.setattr(auth_module, "get_admin_email", lambda: "admin@example.com")
    req = _request_code(client, "alice@example.com")
    code = req.json()["dev_code"]

    resp = _verify_code(client, "alice@example.com", code)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["email"] == "alice@example.com"
    assert data["is_new_user"] is True
    assert data["is_admin"] is False
    assert data["user_id"]
    # Session cookie is issued just like the Google flow.
    assert "session_token" in resp.cookies

    user = session.exec(select(User).where(User.email == "alice@example.com")).one()
    assert user.provider == "email"
    assert user.provider_subject is None
    # The code is single-use — consumed after a successful verify.
    row = session.exec(select(EmailLoginCode)).one()
    assert row.consumed_at is not None


@pytest.mark.unit
def test_email_code_verify_reused_code_fails(client, session, monkeypatch):
    monkeypatch.setattr(auth_module, "get_admin_email", lambda: "admin@example.com")
    code = _request_code(client, "alice@example.com").json()["dev_code"]

    assert _verify_code(client, "alice@example.com", code).status_code == 200
    # Same code cannot be replayed.
    assert _verify_code(client, "alice@example.com", code).status_code == 400


@pytest.mark.unit
def test_email_code_verify_wrong_code_burns_after_max_attempts(client):
    code = _request_code(client, "alice@example.com").json()["dev_code"]
    wrong = "111111" if code != "111111" else "222222"

    for _ in range(5):
        assert _verify_code(client, "alice@example.com", wrong).status_code == 400
    # The correct code no longer works — the row was burned at the attempt cap.
    assert _verify_code(client, "alice@example.com", code).status_code == 400


@pytest.mark.unit
def test_email_code_verify_expired_code_fails(client, session):
    code = _request_code(client, "alice@example.com").json()["dev_code"]
    row = session.exec(select(EmailLoginCode)).one()
    row.expires_at = datetime.utcnow() - timedelta(minutes=1)
    session.add(row)
    session.commit()

    assert _verify_code(client, "alice@example.com", code).status_code == 400


@pytest.mark.unit
def test_email_code_unifies_with_existing_google_user(client, session, monkeypatch):
    """Verifying an email code for an address that already signed in with
    Google logs into the SAME internal user id (no duplicate account)."""
    monkeypatch.setattr(auth_module, "get_admin_email", lambda: "admin@example.com")

    google_resp = _login(client, email="alice@example.com")
    assert google_resp.status_code == 200
    google_user_id = google_resp.json()["user_id"]

    code = _request_code(client, "alice@example.com").json()["dev_code"]
    email_resp = _verify_code(client, "alice@example.com", code)
    assert email_resp.status_code == 200
    assert email_resp.json()["user_id"] == google_user_id
    assert email_resp.json()["is_new_user"] is False

    users = session.exec(select(User)).all()
    assert len(users) == 1
    # Provider is not rewritten — the original Google identity is preserved.
    assert users[0].provider == "google"


@pytest.mark.unit
def test_email_code_verify_merges_anonymous_device_data(client, session, monkeypatch):
    monkeypatch.setattr(auth_module, "get_admin_email", lambda: "admin@example.com")
    device_id = "dev-email-merge"
    session.add(UserSavedEvent(device_id=device_id, event_id="evt-e1", user_id=None))
    session.commit()

    code = _request_code(client, "alice@example.com").json()["dev_code"]
    resp = _verify_code(client, "alice@example.com", code, device_id=device_id)
    assert resp.status_code == 200
    user_id = resp.json()["user_id"]

    saved = session.exec(select(UserSavedEvent)).all()
    assert len(saved) == 1
    assert str(saved[0].user_id) == user_id


@pytest.mark.unit
def test_email_code_request_sends_email_when_not_dev(client, monkeypatch):
    """Outside dev mode a real email is dispatched and no code is leaked."""
    monkeypatch.setattr(auth_module, "_is_dev_auth", lambda: False)
    sent: list[tuple[str, str]] = []
    monkeypatch.setattr(
        auth_module,
        "send_login_code_email",
        lambda to_addr, code: sent.append((to_addr, code)) or True,
    )

    resp = _request_code(client, "alice@example.com")
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["sent"] is True
    assert "dev_code" not in data
    assert len(sent) == 1
    assert sent[0][0] == "alice@example.com"
    assert len(sent[0][1]) == 6
