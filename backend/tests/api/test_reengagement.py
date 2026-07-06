"""Tests for the re-engagement features (reminders, activity emails, web-push).

Covers:
  - reminder_service: due-window selection, idempotency (no double-send),
    email opt-out keeps the in-app reminder, deleted user + hidden event +
    saved-but-not-going exclusions
  - activity_email: batching many notifications into one digest, emailed_at
    idempotency across runs, per-user opt-out still stamps, deleted recipient
    skip
  - PATCH /api/auth/notification-preferences validation + partial update
  - GET /api/auth/unsubscribe one-click token flips the right flag
  - push: vapid-public-key gating, subscribe upsert + unsubscribe, and
    send_push stale-endpoint (410) cleanup
"""

import os
from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

os.environ.setdefault("SESSION_SECRET", "test-secret-reengage")
os.environ.setdefault("ADMIN_EMAIL", "admin@example.com")
os.environ["DEV_AUTH"] = "true"

from backend.api.main import app  # noqa: E402
from backend.api.routes import auth as auth_module  # noqa: E402
from backend.api.routes import push as push_module  # noqa: E402
from backend.db import database as database_module  # noqa: E402
from backend.db.database import get_session  # noqa: E402
from backend.db.models import (  # noqa: E402
    CachedEvent,
    CalendarSetting,
    Notification,
    PushSubscription,
    User,
    UserEventAttendance,
)
from backend.services import activity_email, push_service, reminder_service  # noqa: E402
from backend.services import scheduler as scheduler_module  # noqa: E402


@pytest.fixture
def engine():
    eng = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(eng)
    # Point the cached app engine at the in-memory test DB so the background
    # workers (which open their own ``Session(get_engine())``) hit it too.
    prev = database_module._engine
    database_module._engine = eng
    yield eng
    database_module._engine = prev
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
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


# --- Helpers ----------------------------------------------------------------


def _login(client: TestClient, email: str) -> None:
    r = client.post(
        "/api/auth/google",
        json={"credential": "ignored", "mock_email": email},
    )
    assert r.status_code == 200, r.text


def _make_user(session: Session, email: str, handle: str, **kwargs) -> User:
    u = User(
        email=email,
        display_name=handle.title(),
        handle=handle,
        provider="google",
        provider_subject=f"mock|{email}",
        **kwargs,
    )
    session.add(u)
    session.commit()
    session.refresh(u)
    return u


def _make_event(
    session: Session,
    event_id: str,
    *,
    start: datetime | None = None,
    title: str = "Salsa Night",
    is_hidden: bool = False,
    deleted_at: datetime | None = None,
) -> CachedEvent:
    if session.get(CalendarSetting, "cal") is None:
        session.add(
            CalendarSetting(calendar_id="cal", name="C", color="#abc", enabled=True)
        )
    e = CachedEvent(
        event_id=event_id,
        calendar_id="cal",
        title=title,
        start=start or (datetime.utcnow() + timedelta(hours=6)),
        end=(start or (datetime.utcnow() + timedelta(hours=6))) + timedelta(hours=2),
        all_day=False,
        is_hidden=is_hidden,
        deleted_at=deleted_at,
    )
    session.add(e)
    session.commit()
    session.refresh(e)
    return e


def _going(session: Session, user: User, event_id: str) -> None:
    session.add(
        UserEventAttendance(
            device_id=str(user.id).replace("-", "")[:24] + event_id[:8],
            user_id=user.id,
            event_id=event_id,
            attending_since=datetime.utcnow(),
        )
    )
    session.commit()


def _notif(
    session: Session,
    *,
    recipient: User,
    actor: User,
    kind: str,
    event_id: str | None = None,
    created_at: datetime | None = None,
) -> Notification:
    n = Notification(
        recipient_user_id=recipient.id,
        actor_user_id=actor.id,
        kind=kind,
        event_id=event_id,
        created_at=created_at or datetime.utcnow(),
    )
    session.add(n)
    session.commit()
    session.refresh(n)
    return n


# --- Reminders --------------------------------------------------------------


def test_reminder_created_for_due_going_event(session, monkeypatch):
    sent: list = []
    monkeypatch.setattr(
        reminder_service,
        "send_event_reminder_email",
        lambda u, e, w: sent.append(e.event_id) or True,
    )
    monkeypatch.setattr(reminder_service, "send_push", lambda *a, **k: 0)

    alice = _make_user(session, "alice@example.com", "alice")
    _make_event(session, "ev-soon", start=datetime.utcnow() + timedelta(hours=3))
    _going(session, alice, "ev-soon")

    stats = reminder_service.run_once()
    assert stats["reminders"] == 1
    assert sent == ["ev-soon"]  # opted-in by default

    notifs = session.exec(
        select(Notification).where(Notification.kind == "event_reminder")
    ).all()
    assert len(notifs) == 1
    assert notifs[0].recipient_user_id == alice.id
    assert notifs[0].actor_user_id == alice.id  # self-actor
    assert notifs[0].event_id == "ev-soon"


def test_reminder_is_idempotent(session, monkeypatch):
    monkeypatch.setattr(
        reminder_service, "send_event_reminder_email", lambda *a, **k: True
    )
    monkeypatch.setattr(reminder_service, "send_push", lambda *a, **k: 0)

    alice = _make_user(session, "alice@example.com", "alice")
    _make_event(session, "ev-soon", start=datetime.utcnow() + timedelta(hours=3))
    _going(session, alice, "ev-soon")

    assert reminder_service.run_once()["reminders"] == 1
    # Second pass finds the existing reminder and creates nothing.
    assert reminder_service.run_once() == {"reminders": 0}
    notifs = session.exec(
        select(Notification).where(Notification.kind == "event_reminder")
    ).all()
    assert len(notifs) == 1


def test_reminder_email_optout_keeps_inapp(session, monkeypatch):
    sent: list = []
    monkeypatch.setattr(
        reminder_service,
        "send_event_reminder_email",
        lambda u, e, w: sent.append(e) or True,
    )
    monkeypatch.setattr(reminder_service, "send_push", lambda *a, **k: 0)

    alice = _make_user(
        session, "alice@example.com", "alice", email_event_reminders_enabled=False
    )
    _make_event(session, "ev-soon", start=datetime.utcnow() + timedelta(hours=3))
    _going(session, alice, "ev-soon")

    stats = reminder_service.run_once()
    assert stats["reminders"] == 1
    assert sent == []  # email suppressed
    # In-app reminder still created.
    assert (
        len(
            session.exec(
                select(Notification).where(Notification.kind == "event_reminder")
            ).all()
        )
        == 1
    )


def test_reminder_excludes_hidden_deleted_and_out_of_window(session, monkeypatch):
    monkeypatch.setattr(
        reminder_service, "send_event_reminder_email", lambda *a, **k: True
    )
    monkeypatch.setattr(reminder_service, "send_push", lambda *a, **k: 0)

    alice = _make_user(session, "alice@example.com", "alice")
    # Hidden event — excluded.
    _make_event(
        session,
        "ev-hidden",
        start=datetime.utcnow() + timedelta(hours=3),
        is_hidden=True,
    )
    _going(session, alice, "ev-hidden")
    # Soft-deleted event — excluded.
    _make_event(
        session,
        "ev-deleted",
        start=datetime.utcnow() + timedelta(hours=3),
        deleted_at=datetime.utcnow(),
    )
    _going(session, alice, "ev-deleted")
    # Far-future event beyond the 24h lead — excluded.
    _make_event(session, "ev-far", start=datetime.utcnow() + timedelta(days=5))
    _going(session, alice, "ev-far")

    assert reminder_service.run_once() == {"reminders": 0}


def test_reminder_excludes_deleted_user(session, monkeypatch):
    monkeypatch.setattr(
        reminder_service, "send_event_reminder_email", lambda *a, **k: True
    )
    monkeypatch.setattr(reminder_service, "send_push", lambda *a, **k: 0)

    ghost = _make_user(
        session, "ghost@example.com", "ghost", deleted_at=datetime.utcnow()
    )
    _make_event(session, "ev-soon", start=datetime.utcnow() + timedelta(hours=3))
    _going(session, ghost, "ev-soon")

    assert reminder_service.run_once() == {"reminders": 0}


# --- Activity digest emails -------------------------------------------------


def test_activity_digest_batches_into_one_email(session, monkeypatch):
    calls: list = []
    monkeypatch.setattr(
        activity_email,
        "send_activity_digest_email",
        lambda recipient, lines, **_: calls.append((recipient.id, list(lines))),
    )
    monkeypatch.setattr(activity_email, "send_push", lambda *a, **k: 0)

    bob = _make_user(session, "bob@example.com", "bob")
    a1 = _make_user(session, "a1@example.com", "a1")
    a2 = _make_user(session, "a2@example.com", "a2")
    old = datetime.utcnow() - timedelta(minutes=5)
    _notif(session, recipient=bob, actor=a1, kind="new_follower", created_at=old)
    _notif(session, recipient=bob, actor=a2, kind="new_friend", created_at=old)

    # ``force=True`` bypasses the per-user schedule window so this test
    # is deterministic regardless of wall-clock time.
    stats = activity_email.run_once(force=True)
    assert stats["digests"] == 1
    assert len(calls) == 1
    assert calls[0][0] == bob.id
    assert len(calls[0][1]) == 2  # both notifications in one digest


def test_activity_digest_emailed_at_is_idempotent(session, monkeypatch):
    calls: list = []
    monkeypatch.setattr(
        activity_email,
        "send_activity_digest_email",
        lambda recipient, lines, **_: calls.append(recipient.id),
    )
    monkeypatch.setattr(activity_email, "send_push", lambda *a, **k: 0)

    bob = _make_user(session, "bob@example.com", "bob")
    a1 = _make_user(session, "a1@example.com", "a1")
    old = datetime.utcnow() - timedelta(minutes=5)
    _notif(session, recipient=bob, actor=a1, kind="new_follower", created_at=old)

    activity_email.run_once(force=True)
    # Re-run: the notification is now stamped, so nothing to send.
    assert activity_email.run_once(force=True) == {"digests": 0}
    assert calls == [bob.id]


def test_activity_digest_optout_skips_email_but_stamps(session, monkeypatch):
    calls: list = []
    monkeypatch.setattr(
        activity_email,
        "send_activity_digest_email",
        lambda recipient, lines, **_: calls.append(recipient.id),
    )
    monkeypatch.setattr(activity_email, "send_push", lambda *a, **k: 0)

    bob = _make_user(session, "bob@example.com", "bob", email_social_activity_enabled=False)
    a1 = _make_user(session, "a1@example.com", "a1")
    old = datetime.utcnow() - timedelta(minutes=5)
    n = _notif(session, recipient=bob, actor=a1, kind="new_follower", created_at=old)

    stats = activity_email.run_once(force=True)
    assert stats["digests"] == 0
    assert calls == []
    # Still stamped so it is not re-scanned forever.
    session.refresh(n)
    assert n.emailed_at is not None


def test_activity_digest_skips_notifs_older_than_max_age(session, monkeypatch):
    """Rows older than _MAX_AGE (14 days) are dropped even with force=True."""
    monkeypatch.setattr(
        activity_email, "send_activity_digest_email", lambda *a, **k: None
    )
    monkeypatch.setattr(activity_email, "send_push", lambda *a, **k: 0)

    bob = _make_user(session, "bob@example.com", "bob")
    a1 = _make_user(session, "a1@example.com", "a1")
    _notif(
        session,
        recipient=bob,
        actor=a1,
        kind="new_friend",
        event_id=None,
        created_at=datetime.utcnow() - timedelta(days=30),
    )

    assert activity_email.run_once(force=True) == {"digests": 0}


def test_activity_digest_gates_on_scheduled_slot(session, monkeypatch):
    """Without ``force``, run_once only delivers to users in their local slot."""
    calls: list = []
    monkeypatch.setattr(
        activity_email,
        "send_activity_digest_email",
        lambda recipient, lines, **_: calls.append(recipient.id),
    )
    monkeypatch.setattr(activity_email, "send_push", lambda *a, **k: 0)
    # Freeze the schedule so this test is TZ-independent.
    monkeypatch.setattr(
        "backend.services.activity_email.get_activity_digest_schedule",
        lambda: "tue,fri @ 09:00",
    )

    bob = _make_user(session, "bob@example.com", "bob", timezone="UTC")
    a1 = _make_user(session, "a1@example.com", "a1")
    old = datetime.utcnow() - timedelta(minutes=5)
    n = _notif(session, recipient=bob, actor=a1, kind="new_follower", created_at=old)

    class _FakeDateTime:
        """Freeze ``datetime.utcnow`` to a Monday 09:00 UTC (off-schedule)."""

        @staticmethod
        def utcnow():
            return datetime(2026, 7, 6, 9, 0)  # Monday

    monkeypatch.setattr("backend.services.activity_email.datetime", _FakeDateTime)

    stats = activity_email.run_once()
    assert stats.get("digests", 0) == 0
    assert stats.get("skipped_off_schedule", 0) == 1
    assert calls == []
    session.refresh(n)
    # Off-schedule rows stay unstamped so they roll into the next slot.
    assert n.emailed_at is None


def test_activity_digest_delivers_in_scheduled_slot(session, monkeypatch):
    """When ``now`` matches the user's local slot the digest ships."""
    calls: list = []
    monkeypatch.setattr(
        activity_email,
        "send_activity_digest_email",
        lambda recipient, lines, **_: calls.append(recipient.id),
    )
    monkeypatch.setattr(activity_email, "send_push", lambda *a, **k: 0)
    monkeypatch.setattr(
        "backend.services.activity_email.get_activity_digest_schedule",
        lambda: "tue,fri @ 09:00",
    )

    bob = _make_user(session, "bob@example.com", "bob", timezone="UTC")
    a1 = _make_user(session, "a1@example.com", "a1")
    _notif(
        session,
        recipient=bob,
        actor=a1,
        kind="new_follower",
        created_at=datetime.utcnow() - timedelta(minutes=5),
    )

    class _FakeDateTime:
        """Freeze ``datetime.utcnow`` to Tuesday 09:00 UTC."""

        @staticmethod
        def utcnow():
            return datetime(2026, 7, 7, 9, 0)  # Tuesday

    monkeypatch.setattr("backend.services.activity_email.datetime", _FakeDateTime)

    stats = activity_email.run_once()
    assert stats["digests"] == 1
    assert calls == [bob.id]


def test_activity_digest_per_user_timezone(session, monkeypatch):
    """Two users on the same schedule ship in different UTC slots."""
    calls: list = []
    monkeypatch.setattr(
        activity_email,
        "send_activity_digest_email",
        lambda recipient, lines, **_: calls.append(recipient.id),
    )
    monkeypatch.setattr(activity_email, "send_push", lambda *a, **k: 0)
    monkeypatch.setattr(
        "backend.services.activity_email.get_activity_digest_schedule",
        lambda: "tue @ 09:00",
    )

    paris = _make_user(
        session, "paris@example.com", "paris", timezone="Europe/Paris"
    )
    tokyo = _make_user(
        session, "tokyo@example.com", "tokyo", timezone="Asia/Tokyo"
    )
    a1 = _make_user(session, "a1@example.com", "a1")
    _notif(
        session,
        recipient=paris,
        actor=a1,
        kind="new_follower",
        created_at=datetime.utcnow() - timedelta(minutes=5),
    )
    _notif(
        session,
        recipient=tokyo,
        actor=a1,
        kind="new_follower",
        created_at=datetime.utcnow() - timedelta(minutes=5),
    )

    # Tuesday 07:00 UTC → 09:00 Europe/Paris (in slot), but 16:00 in Tokyo
    # (also past 09:00 slot for that day → in slot too). To isolate Paris,
    # freeze to Tue 08:00 UTC = 09:00 Paris (in slot) but 17:00 Tokyo
    # (past 09:00, in slot). Both fire.
    class _FakeDateTime:
        @staticmethod
        def utcnow():
            # Tuesday 00:15 UTC → 09:15 Tokyo (in slot), 01:15 Paris (before).
            return datetime(2026, 7, 7, 0, 15)

    monkeypatch.setattr("backend.services.activity_email.datetime", _FakeDateTime)

    stats = activity_email.run_once()
    assert stats["digests"] == 1
    assert calls == [tokyo.id]


# --- Notification preferences + unsubscribe ---------------------------------


def test_update_notification_preferences(client, session):
    _make_user(session, "alice@example.com", "alice")
    _login(client, "alice@example.com")

    r = client.patch(
        "/api/auth/notification-preferences",
        json={"reminder_email_enabled": False, "timezone": "Europe/Paris"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["reminder_email_enabled"] is False
    assert body["timezone"] == "Europe/Paris"
    assert body["activity_email_enabled"] is True  # untouched


def test_update_notification_preferences_rejects_bad_timezone(client, session):
    _make_user(session, "alice@example.com", "alice")
    _login(client, "alice@example.com")
    r = client.patch(
        "/api/auth/notification-preferences",
        json={"timezone": "Mars/Phobos"},
    )
    assert r.status_code == 400


# --- Phase G: per-feature x per-channel flags --------------------------------


def test_patch_new_flag_names_persists(client, session):
    """Six new Phase G flags PATCH through unchanged and round-trip in GET /me."""
    alice = _make_user(session, "alice@example.com", "alice")
    _login(client, "alice@example.com")

    r = client.patch(
        "/api/auth/notification-preferences",
        json={
            "email_event_reminders_enabled": False,
            "push_interest_matches_enabled": False,
        },
    )
    assert r.status_code == 200, r.text

    session.expire_all()
    refreshed = session.get(User, alice.id)
    assert refreshed.email_event_reminders_enabled is False
    assert refreshed.push_interest_matches_enabled is False
    # Untouched.
    assert refreshed.email_social_activity_enabled is True
    assert refreshed.email_interest_matches_enabled is True
    assert refreshed.push_event_reminders_enabled is True
    assert refreshed.push_social_activity_enabled is True

    me = client.get("/api/auth/me").json()
    assert me["email_event_reminders_enabled"] is False
    assert me["push_interest_matches_enabled"] is False
    # Legacy mirrors: `activity_email_enabled` = social AND interest email,
    # `push_enabled` = AND of all three push_* flags,
    # `interest_notifications_enabled` = email_interest AND push_interest.
    assert me["reminder_email_enabled"] is False  # mirrors email_event_reminders
    assert me["activity_email_enabled"] is True  # social+interest email both on
    assert me["push_enabled"] is False  # any push off => legacy off
    assert me["interest_notifications_enabled"] is False  # push_interest off


def test_patch_legacy_flag_names_write_through_new_columns(client, session):
    """Old clients PATCHing legacy names write through to the new flag matrix."""
    alice = _make_user(session, "alice@example.com", "alice")
    _login(client, "alice@example.com")

    # Legacy `activity_email_enabled=False` must clear BOTH social and interest
    # email flags on the new matrix (activity was the umbrella for both).
    r = client.patch(
        "/api/auth/notification-preferences",
        json={"activity_email_enabled": False, "push_enabled": False},
    )
    assert r.status_code == 200, r.text

    session.expire_all()
    refreshed = session.get(User, alice.id)
    assert refreshed.email_social_activity_enabled is False
    assert refreshed.email_interest_matches_enabled is False
    # push_enabled=False propagates to all three push channels.
    assert refreshed.push_event_reminders_enabled is False
    assert refreshed.push_social_activity_enabled is False
    assert refreshed.push_interest_matches_enabled is False
    # Reminder email was untouched.
    assert refreshed.email_event_reminders_enabled is True


def test_get_me_returns_all_six_new_flags(client, session):
    """GET /me exposes every Phase G flag (plus the four legacy mirrors)."""
    _make_user(session, "alice@example.com", "alice")
    _login(client, "alice@example.com")

    me = client.get("/api/auth/me").json()
    for key in (
        "email_event_reminders_enabled",
        "email_social_activity_enabled",
        "email_interest_matches_enabled",
        "push_event_reminders_enabled",
        "push_social_activity_enabled",
        "push_interest_matches_enabled",
        # Legacy mirrors still returned for one release.
        "reminder_email_enabled",
        "activity_email_enabled",
        "push_enabled",
        "interest_notifications_enabled",
    ):
        assert key in me, f"missing {key} in GET /me"
        assert me[key] is True


def test_unsubscribe_token_flips_flag(client, session):
    from backend.services.email_tokens import make_unsubscribe_token

    alice = _make_user(session, "alice@example.com", "alice")
    token = make_unsubscribe_token(str(alice.id), "reminder")

    r = client.get(f"/api/auth/unsubscribe?token={token}")
    assert r.status_code == 200
    assert r.json()["status"] == "unsubscribed"

    session.expire_all()
    refreshed = session.get(User, alice.id)
    assert refreshed.email_event_reminders_enabled is False
    # The other categories are untouched.
    assert refreshed.email_social_activity_enabled is True


def test_unsubscribe_activity_token_leaves_reminder_untouched(client, session):
    """The 'activity' category (which carries interest-profile event
    matches) must be isolated from the 'reminder' category so a user
    can opt out of one without losing the other."""
    from backend.services.email_tokens import make_unsubscribe_token

    alice = _make_user(session, "alice@example.com", "alice")
    token = make_unsubscribe_token(str(alice.id), "activity")

    r = client.get(f"/api/auth/unsubscribe?token={token}")
    assert r.status_code == 200
    assert r.json()["status"] == "unsubscribed"

    session.expire_all()
    refreshed = session.get(User, alice.id)
    # 'activity' is the legacy compat token — it flips BOTH social + interest
    # email flags off (see UNSUBSCRIBE_CATEGORIES in email_tokens.py).
    assert refreshed.email_social_activity_enabled is False
    assert refreshed.email_interest_matches_enabled is False
    assert refreshed.email_event_reminders_enabled is True


def test_unsubscribe_invalid_token(client, session):
    r = client.get("/api/auth/unsubscribe?token=not-a-real-token")
    assert r.status_code == 200
    assert r.json()["status"] == "invalid"


def test_admin_trigger_notifications_requires_admin(client, session):
    _make_user(session, "alice@example.com", "alice")

    # Anonymous caller is rejected.
    anon = client.post("/api/admin/trigger-notifications")
    assert anon.status_code == 401

    # Signed-in non-admin is rejected.
    _login(client, "alice@example.com")
    non_admin = client.post("/api/admin/trigger-notifications")
    assert non_admin.status_code == 403


def test_admin_trigger_notifications_runs_dispatch(client, session, monkeypatch):
    _make_user(session, "admin@example.com", "admin")
    _login(client, "admin@example.com")

    monkeypatch.setattr(
        scheduler_module,
        "run_notification_dispatch_once",
        lambda: {
            "reminders": {"reminders": 1, "emailed": 1, "pushed": 0},
            "activity": {"digests": 1, "pushed": 1},
        },
    )

    r = client.post("/api/admin/trigger-notifications")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "ok"
    assert body["stats"] == {
        "reminders": {"reminders": 1, "emailed": 1, "pushed": 0},
        "activity": {"digests": 1, "pushed": 1},
    }


# --- Web push ---------------------------------------------------------------


def test_vapid_public_key_404_when_disabled(client, monkeypatch):
    monkeypatch.setattr(push_module, "get_web_push_enabled", lambda: False)
    r = client.get("/api/push/vapid-public-key")
    assert r.status_code == 404


def test_vapid_public_key_returns_key_when_enabled(client, monkeypatch):
    monkeypatch.setattr(push_module, "get_web_push_enabled", lambda: True)
    monkeypatch.setattr(
        push_module,
        "get_vapid_config",
        lambda: {"public_key": "PUBKEY", "private_key": "x", "subject": "mailto:a@b.c"},
    )
    r = client.get("/api/push/vapid-public-key")
    assert r.status_code == 200
    assert r.json()["public_key"] == "PUBKEY"


def test_subscribe_and_unsubscribe_push(client, session):
    _make_user(session, "alice@example.com", "alice")
    _login(client, "alice@example.com")

    payload = {
        "endpoint": "https://push.example.com/abc",
        "keys": {"p256dh": "key-p256", "auth": "key-auth"},
        "user_agent": "pytest",
    }
    r = client.post("/api/push/subscribe", json=payload)
    assert r.status_code == 200
    assert len(session.exec(select(PushSubscription)).all()) == 1

    # Re-subscribe same endpoint upserts (no duplicate row).
    r = client.post("/api/push/subscribe", json=payload)
    assert r.status_code == 200
    assert len(session.exec(select(PushSubscription)).all()) == 1

    r = client.post(
        "/api/push/unsubscribe", json={"endpoint": "https://push.example.com/abc"}
    )
    assert r.status_code == 200
    assert session.exec(select(PushSubscription)).all() == []


def test_subscribe_and_unsubscribe_push_anonymous(client, session):
    # No login: web push is per-browser, so anonymous visitors must be able
    # to subscribe before ever signing in.
    payload = {
        "endpoint": "https://push.example.com/anon",
        "keys": {"p256dh": "key-p256", "auth": "key-auth"},
        "user_agent": "pytest",
    }
    r = client.post("/api/push/subscribe", json=payload)
    assert r.status_code == 200
    rows = session.exec(select(PushSubscription)).all()
    assert len(rows) == 1
    assert rows[0].user_id is None

    r = client.post(
        "/api/push/unsubscribe", json={"endpoint": "https://push.example.com/anon"}
    )
    assert r.status_code == 200
    assert session.exec(select(PushSubscription)).all() == []


def test_send_push_prunes_stale_endpoints(session, monkeypatch):
    import sys
    import types

    class FakeWebPushException(Exception):
        def __init__(self, msg, response=None):
            super().__init__(msg)
            self.response = response

    class _Resp:
        def __init__(self, status):
            self.status_code = status

    def fake_webpush(*, subscription_info, **kwargs):
        if "gone" in subscription_info["endpoint"]:
            raise FakeWebPushException("gone", response=_Resp(410))
        return None  # delivered

    fake = types.ModuleType("pywebpush")
    fake.webpush = fake_webpush
    fake.WebPushException = FakeWebPushException
    monkeypatch.setitem(sys.modules, "pywebpush", fake)
    monkeypatch.setattr(push_service, "get_web_push_enabled", lambda: True)
    monkeypatch.setattr(
        push_service,
        "get_vapid_config",
        lambda: {"public_key": "p", "private_key": "k", "subject": "mailto:a@b.c"},
    )

    alice = _make_user(session, "alice@example.com", "alice")
    session.add(
        PushSubscription(
            user_id=alice.id, endpoint="https://push/live", p256dh="a", auth="b"
        )
    )
    session.add(
        PushSubscription(
            user_id=alice.id, endpoint="https://push/gone", p256dh="a", auth="b"
        )
    )
    session.commit()

    delivered = push_service.send_push(alice.id, "T", "B", url="/x")
    assert delivered == 1  # only the live endpoint
    # Stale (410) endpoint was pruned; live one remains.
    remaining = [s.endpoint for s in session.exec(select(PushSubscription)).all()]
    assert remaining == ["https://push/live"]
