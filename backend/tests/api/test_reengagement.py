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
        session, "alice@example.com", "alice", reminder_email_enabled=False
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
        lambda recipient, lines: calls.append((recipient.id, list(lines))),
    )
    monkeypatch.setattr(activity_email, "send_push", lambda *a, **k: 0)

    bob = _make_user(session, "bob@example.com", "bob")
    a1 = _make_user(session, "a1@example.com", "a1")
    a2 = _make_user(session, "a2@example.com", "a2")
    old = datetime.utcnow() - timedelta(minutes=5)
    _notif(session, recipient=bob, actor=a1, kind="new_follower", created_at=old)
    _notif(session, recipient=bob, actor=a2, kind="new_friend", created_at=old)

    stats = activity_email.run_once()
    assert stats["digests"] == 1
    assert len(calls) == 1
    assert calls[0][0] == bob.id
    assert len(calls[0][1]) == 2  # both notifications in one digest


def test_activity_digest_emailed_at_is_idempotent(session, monkeypatch):
    calls: list = []
    monkeypatch.setattr(
        activity_email,
        "send_activity_digest_email",
        lambda recipient, lines: calls.append(recipient.id),
    )
    monkeypatch.setattr(activity_email, "send_push", lambda *a, **k: 0)

    bob = _make_user(session, "bob@example.com", "bob")
    a1 = _make_user(session, "a1@example.com", "a1")
    old = datetime.utcnow() - timedelta(minutes=5)
    _notif(session, recipient=bob, actor=a1, kind="new_follower", created_at=old)

    activity_email.run_once()
    # Re-run: the notification is now stamped, so nothing to send.
    assert activity_email.run_once() == {"digests": 0}
    assert calls == [bob.id]


def test_activity_digest_optout_skips_email_but_stamps(session, monkeypatch):
    calls: list = []
    monkeypatch.setattr(
        activity_email,
        "send_activity_digest_email",
        lambda recipient, lines: calls.append(recipient.id),
    )
    monkeypatch.setattr(activity_email, "send_push", lambda *a, **k: 0)

    bob = _make_user(session, "bob@example.com", "bob", activity_email_enabled=False)
    a1 = _make_user(session, "a1@example.com", "a1")
    old = datetime.utcnow() - timedelta(minutes=5)
    n = _notif(session, recipient=bob, actor=a1, kind="new_follower", created_at=old)

    stats = activity_email.run_once()
    assert stats["digests"] == 0
    assert calls == []
    # Still stamped so it is not re-scanned forever.
    session.refresh(n)
    assert n.emailed_at is not None


def test_activity_digest_skips_recent_and_too_old(session, monkeypatch):
    monkeypatch.setattr(
        activity_email, "send_activity_digest_email", lambda *a, **k: None
    )
    monkeypatch.setattr(activity_email, "send_push", lambda *a, **k: 0)

    bob = _make_user(session, "bob@example.com", "bob")
    a1 = _make_user(session, "a1@example.com", "a1")
    # Too recent (inside the 2-min batch delay) and too old (>24h) are both skipped.
    _notif(
        session,
        recipient=bob,
        actor=a1,
        kind="new_follower",
        created_at=datetime.utcnow(),
    )
    _notif(
        session,
        recipient=bob,
        actor=a1,
        kind="new_friend",
        event_id=None,
        created_at=datetime.utcnow() - timedelta(hours=30),
    )

    assert activity_email.run_once() == {"digests": 0}


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


def test_unsubscribe_token_flips_flag(client, session):
    from backend.services.email_tokens import make_unsubscribe_token

    alice = _make_user(session, "alice@example.com", "alice")
    token = make_unsubscribe_token(str(alice.id), "reminder")

    r = client.get(f"/api/auth/unsubscribe?token={token}")
    assert r.status_code == 200
    assert r.json()["status"] == "unsubscribed"

    session.expire_all()
    refreshed = session.get(User, alice.id)
    assert refreshed.reminder_email_enabled is False
    # The other category is untouched.
    assert refreshed.activity_email_enabled is True


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
    monkeypatch.setattr(push_module, "get_webpush_enabled", lambda: False)
    r = client.get("/api/push/vapid-public-key")
    assert r.status_code == 404


def test_vapid_public_key_returns_key_when_enabled(client, monkeypatch):
    monkeypatch.setattr(push_module, "get_webpush_enabled", lambda: True)
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
    monkeypatch.setattr(push_service, "get_webpush_enabled", lambda: True)
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
