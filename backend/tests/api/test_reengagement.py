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
from datetime import datetime, timedelta, timezone

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
    EventRating,
    Notification,
    PushSubscription,
    SiteSetting,
    Tag,
    TagGroup,
    User,
    UserEventAttendance,
    UserFollow,
    UserInterestProfile,
    UserInterestProfileTag,
)
from backend.services import (
    activity_email,
    push_service,
    reminder_service,
    review_prompt_service,
)  # noqa: E402
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
        start=start or (datetime.now(timezone.utc) + timedelta(hours=6)),
        end=(start or (datetime.now(timezone.utc) + timedelta(hours=6)))
        + timedelta(hours=2),
        all_day=False,
        is_hidden=is_hidden,
        deleted_at=deleted_at,
        review_status="reviewed",
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
            attending_since=datetime.now(timezone.utc),
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
        created_at=created_at or datetime.now(timezone.utc),
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
        lambda u, e, w, **k: sent.append(e.event_id) or True,
    )
    monkeypatch.setattr(reminder_service, "send_push", lambda *a, **k: 0)

    alice = _make_user(session, "alice@example.com", "alice")
    _make_event(
        session, "ev-soon", start=datetime.now(timezone.utc) + timedelta(hours=3)
    )
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


def test_reminder_ask_cta_gated_by_going_threshold(session, monkeypatch):
    """The "Ask a question" CTA (context="ask" + include_ask_cta email flag)
    is added only when an event has at least the configured number of Going
    attendees (default 3)."""
    seen: list = []
    monkeypatch.setattr(
        reminder_service,
        "send_event_reminder_email",
        lambda u, e, w, include_ask_cta=False, **_: (
            seen.append((e.event_id, include_ask_cta)) or True
        ),
    )
    monkeypatch.setattr(reminder_service, "send_push", lambda *a, **k: 0)

    # Popular event: 3 Going attendees → CTA on.
    popular = _make_event(
        session, "ev-popular", start=datetime.now(timezone.utc) + timedelta(hours=3)
    )
    for i in range(3):
        u = _make_user(session, f"pop{i}@example.com", f"pop{i}")
        _going(session, u, popular.event_id)

    # Quiet event: single Going attendee → CTA off.
    quiet = _make_event(
        session, "ev-quiet", start=datetime.now(timezone.utc) + timedelta(hours=3)
    )
    solo = _make_user(session, "solo@example.com", "solo")
    _going(session, solo, quiet.event_id)

    reminder_service.run_once()

    by_event = dict(seen)
    assert by_event["ev-popular"] is True
    assert by_event["ev-quiet"] is False

    notifs = {
        n.event_id: n
        for n in session.exec(
            select(Notification).where(Notification.kind == "event_reminder")
        ).all()
    }
    assert notifs["ev-popular"].context == "ask"
    assert notifs["ev-quiet"].context is None


def test_reminder_is_idempotent(session, monkeypatch):
    monkeypatch.setattr(
        reminder_service, "send_event_reminder_email", lambda *a, **k: True
    )
    monkeypatch.setattr(reminder_service, "send_push", lambda *a, **k: 0)

    alice = _make_user(session, "alice@example.com", "alice")
    _make_event(
        session, "ev-soon", start=datetime.now(timezone.utc) + timedelta(hours=3)
    )
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
        lambda u, e, w, **_: sent.append(e) or True,
    )
    monkeypatch.setattr(reminder_service, "send_push", lambda *a, **k: 0)

    alice = _make_user(
        session, "alice@example.com", "alice", email_event_reminders_enabled=False
    )
    _make_event(
        session, "ev-soon", start=datetime.now(timezone.utc) + timedelta(hours=3)
    )
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
        start=datetime.now(timezone.utc) + timedelta(hours=3),
        is_hidden=True,
    )
    _going(session, alice, "ev-hidden")
    # Soft-deleted event — excluded.
    _make_event(
        session,
        "ev-deleted",
        start=datetime.now(timezone.utc) + timedelta(hours=3),
        deleted_at=datetime.now(timezone.utc),
    )
    _going(session, alice, "ev-deleted")
    # Far-future event beyond the 24h lead — excluded.
    _make_event(session, "ev-far", start=datetime.now(timezone.utc) + timedelta(days=5))
    _going(session, alice, "ev-far")

    assert reminder_service.run_once() == {"reminders": 0}


def test_reminder_excludes_deleted_user(session, monkeypatch):
    monkeypatch.setattr(
        reminder_service, "send_event_reminder_email", lambda *a, **k: True
    )
    monkeypatch.setattr(reminder_service, "send_push", lambda *a, **k: 0)

    ghost = _make_user(
        session, "ghost@example.com", "ghost", deleted_at=datetime.now(timezone.utc)
    )
    _make_event(
        session, "ev-soon", start=datetime.now(timezone.utc) + timedelta(hours=3)
    )
    _going(session, ghost, "ev-soon")

    assert reminder_service.run_once() == {"reminders": 0}


# --- Review prompts ----------------------------------------------------------


def test_review_prompt_created_for_ended_going_event(session, monkeypatch):
    sent: list = []
    monkeypatch.setattr(
        review_prompt_service,
        "send_event_review_prompt_email",
        lambda u, e, friend_proof=None, **_: sent.append(e.event_id) or True,
    )
    monkeypatch.setattr(review_prompt_service, "send_push", lambda *a, **k: 0)

    alice = _make_user(session, "alice@example.com", "alice")
    # Ended 4h ago — past the default 3h delay.
    _make_event(
        session, "ev-past", start=datetime.now(timezone.utc) - timedelta(hours=6)
    )
    _going(session, alice, "ev-past")

    stats = review_prompt_service.run_once()
    assert stats["prompts"] == 1
    assert sent == ["ev-past"]

    notifs = session.exec(
        select(Notification).where(Notification.kind == "event_review_prompt")
    ).all()
    assert len(notifs) == 1
    assert notifs[0].recipient_user_id == alice.id
    assert notifs[0].actor_user_id == alice.id  # self-actor
    assert notifs[0].event_id == "ev-past"


def test_notifications_filter_by_review_prompt_kind(client, session):
    """GET /api/notifications?kind=event_review_prompt must be accepted (200),
    not rejected as an invalid kind (400)."""
    alice = _make_user(session, "alice@example.com", "alice")
    _make_event(
        session, "ev-past", start=datetime.now(timezone.utc) - timedelta(hours=6)
    )
    _notif(
        session,
        recipient=alice,
        actor=alice,
        kind="event_review_prompt",
        event_id="ev-past",
    )

    _login(client, "alice@example.com")  # reuses alice (matching provider_subject)

    resp = client.get("/api/notifications?kind=event_review_prompt&limit=50")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert [n["kind"] for n in body["items"]] == ["event_review_prompt"]

    # Sanity: a genuinely unknown kind is still rejected.
    assert client.get("/api/notifications?kind=bogus_kind").status_code == 400


def test_review_prompt_is_idempotent(session, monkeypatch):
    monkeypatch.setattr(
        review_prompt_service, "send_event_review_prompt_email", lambda *a, **k: True
    )
    monkeypatch.setattr(review_prompt_service, "send_push", lambda *a, **k: 0)

    alice = _make_user(session, "alice@example.com", "alice")
    _make_event(
        session, "ev-past", start=datetime.now(timezone.utc) - timedelta(hours=6)
    )
    _going(session, alice, "ev-past")

    assert review_prompt_service.run_once()["prompts"] == 1
    # Second pass finds the existing prompt and creates nothing.
    assert review_prompt_service.run_once() == {"prompts": 0}
    notifs = session.exec(
        select(Notification).where(Notification.kind == "event_review_prompt")
    ).all()
    assert len(notifs) == 1


def test_review_prompt_skips_already_rated(session, monkeypatch):
    sent: list = []
    monkeypatch.setattr(
        review_prompt_service,
        "send_event_review_prompt_email",
        lambda u, e, friend_proof=None, **_: sent.append(e.event_id) or True,
    )
    monkeypatch.setattr(review_prompt_service, "send_push", lambda *a, **k: 0)

    alice = _make_user(session, "alice@example.com", "alice")
    _make_event(
        session, "ev-past", start=datetime.now(timezone.utc) - timedelta(hours=6)
    )
    _going(session, alice, "ev-past")
    session.add(
        EventRating(
            event_id="ev-past",
            user_id=alice.id,
            stars=5,
            status="approved",
        )
    )
    session.commit()

    assert review_prompt_service.run_once() == {"prompts": 0}
    assert sent == []


def test_review_prompt_still_sent_after_earlier_edition_review(session, monkeypatch):
    """A review written about an earlier edition doesn't count as reviewing
    the edition the user just attended."""
    monkeypatch.setattr(
        review_prompt_service, "send_event_review_prompt_email", lambda *a, **k: True
    )
    monkeypatch.setattr(review_prompt_service, "send_push", lambda *a, **k: 0)

    alice = _make_user(session, "alice@example.com", "alice")
    _make_event(
        session, "ev-past", start=datetime.now(timezone.utc) - timedelta(hours=6)
    )
    _going(session, alice, "ev-past")
    session.add(
        EventRating(
            event_id="ev-past",
            user_id=alice.id,
            stars=5,
            status="approved",
            scope="past_edition",
        )
    )
    session.commit()

    assert review_prompt_service.run_once()["prompts"] == 1


def test_review_prompt_email_optout_keeps_inapp(session, monkeypatch):
    sent: list = []
    monkeypatch.setattr(
        review_prompt_service,
        "send_event_review_prompt_email",
        lambda u, e, friend_proof=None, **_: sent.append(e) or True,
    )
    monkeypatch.setattr(review_prompt_service, "send_push", lambda *a, **k: 0)

    alice = _make_user(
        session, "alice@example.com", "alice", email_review_prompt_enabled=False
    )
    _make_event(
        session, "ev-past", start=datetime.now(timezone.utc) - timedelta(hours=6)
    )
    _going(session, alice, "ev-past")

    stats = review_prompt_service.run_once()
    assert stats["prompts"] == 1
    assert sent == []  # email suppressed
    assert (
        len(
            session.exec(
                select(Notification).where(Notification.kind == "event_review_prompt")
            ).all()
        )
        == 1
    )


def test_review_prompt_backfills_email_after_toggle(session, monkeypatch):
    """A user who opted out of email at prompt-creation time and later
    flips the toggle on should still get the email on a later tick, as
    long as they haven't rated the event and no email has gone out yet."""
    sent: list = []
    monkeypatch.setattr(
        review_prompt_service,
        "send_event_review_prompt_email",
        lambda u, e, friend_proof=None, **_: sent.append(e.event_id) or True,
    )
    monkeypatch.setattr(review_prompt_service, "send_push", lambda *a, **k: 0)

    bob = _make_user(
        session, "bob@example.com", "bob", email_review_prompt_enabled=False
    )
    _make_event(
        session, "ev-past", start=datetime.now(timezone.utc) - timedelta(hours=6)
    )
    _going(session, bob, "ev-past")

    # First tick: in-app prompt created, no email (opted out).
    stats = review_prompt_service.run_once()
    assert stats == {"prompts": 1, "emailed": 0, "pushed": 0}
    assert sent == []

    # Bob flips the toggle on, still hasn't rated the event.
    bob.email_review_prompt_enabled = True
    session.add(bob)
    session.commit()

    # Second tick: no new in-app row, but the backfill email goes out.
    stats = review_prompt_service.run_once()
    assert stats == {"prompts": 0, "emailed": 1, "pushed": 0}
    assert sent == ["ev-past"]

    notifs = session.exec(
        select(Notification).where(Notification.kind == "event_review_prompt")
    ).all()
    assert len(notifs) == 1
    assert notifs[0].emailed_at is not None

    # Third tick: already emailed, nothing left to do.
    sent.clear()
    assert review_prompt_service.run_once() == {"prompts": 0}
    assert sent == []


def test_review_prompt_no_backfill_once_rated(session, monkeypatch):
    """Once the user rates the event, a later toggle flip must not
    resurrect the prompt for that event."""
    sent: list = []
    monkeypatch.setattr(
        review_prompt_service,
        "send_event_review_prompt_email",
        lambda u, e, friend_proof=None, **_: sent.append(e.event_id) or True,
    )
    monkeypatch.setattr(review_prompt_service, "send_push", lambda *a, **k: 0)

    bob = _make_user(
        session, "bob@example.com", "bob", email_review_prompt_enabled=False
    )
    _make_event(
        session, "ev-past", start=datetime.now(timezone.utc) - timedelta(hours=6)
    )
    _going(session, bob, "ev-past")

    assert review_prompt_service.run_once()["prompts"] == 1

    session.add(
        EventRating(event_id="ev-past", user_id=bob.id, stars=5, status="approved")
    )
    session.commit()

    bob.email_review_prompt_enabled = True
    session.add(bob)
    session.commit()

    assert review_prompt_service.run_once() == {"prompts": 0}
    assert sent == []


def _set(session: Session, **settings: str) -> None:
    for key, value in settings.items():
        session.add(SiteSetting(key=key, value=value))
    session.commit()


def _capture_digest(monkeypatch) -> list:
    calls: list = []
    monkeypatch.setattr(
        activity_email,
        "send_activity_digest_v2_email",
        lambda recipient, sections, **_: (
            calls.append(
                {
                    s["feature"]: [e["primary_html"] for e in s["entries"]]
                    for s in sections
                }
            )
            or True
        ),
    )
    monkeypatch.setattr(activity_email, "send_push", lambda *a, **k: 0)
    return calls


def test_review_prompt_digest_mode_moves_email_to_digest(session, monkeypatch):
    sent: list = []
    monkeypatch.setattr(
        review_prompt_service,
        "send_event_review_prompt_email",
        lambda u, e, **_: sent.append(e.event_id) or True,
    )
    pushed: list = []
    monkeypatch.setattr(
        review_prompt_service, "send_push", lambda uid, **k: pushed.append(uid) or 1
    )
    digests = _capture_digest(monkeypatch)
    _set(
        session, review_prompt_email_instant="false", review_prompt_email_digest="true"
    )
    alice = _make_user(session, "alice@example.com", "alice")
    _make_event(
        session, "ev-past", start=datetime.now(timezone.utc) - timedelta(hours=6)
    )
    _going(session, alice, "ev-past")

    assert review_prompt_service.run_once() == {"prompts": 1, "emailed": 0, "pushed": 1}
    assert sent == [] and pushed == [alice.id]
    # Email is no longer pending for the prompt service.
    assert review_prompt_service.run_once() == {"prompts": 0}

    assert activity_email.run_once(force=True)["digests"] == 1
    assert list(digests[0]) == ["review_prompt"]
    assert "/event/ev-past/review" in digests[0]["review_prompt"][0]
    notif = session.exec(
        select(Notification).where(Notification.kind == "event_review_prompt")
    ).one()
    session.refresh(notif)
    assert notif.emailed_at is not None
    assert activity_email.run_once(force=True)["digests"] == 0


def test_review_prompt_digest_drops_rated_event(session, monkeypatch):
    digests = _capture_digest(monkeypatch)
    _set(
        session, review_prompt_email_instant="false", review_prompt_email_digest="true"
    )
    alice = _make_user(session, "alice@example.com", "alice")
    _make_event(
        session, "ev-past", start=datetime.now(timezone.utc) - timedelta(hours=6)
    )
    n = _notif(
        session,
        recipient=alice,
        actor=alice,
        kind="event_review_prompt",
        event_id="ev-past",
    )
    session.add(
        EventRating(event_id="ev-past", user_id=alice.id, stars=5, status="approved")
    )
    session.commit()

    assert activity_email.run_once(force=True)["digests"] == 0
    assert digests == []
    session.refresh(n)
    assert n.emailed_at is not None


def test_review_prompt_instant_mode_never_digested(session, monkeypatch):
    digests = _capture_digest(monkeypatch)
    alice = _make_user(
        session, "alice@example.com", "alice", email_review_prompt_enabled=False
    )
    _make_event(
        session, "ev-past", start=datetime.now(timezone.utc) - timedelta(hours=6)
    )
    _notif(
        session,
        recipient=alice,
        actor=alice,
        kind="event_review_prompt",
        event_id="ev-past",
    )
    # Even with digest also ticked, instant owns the email route.
    _set(session, review_prompt_email_digest="true")

    activity_email.run_once(force=True)
    assert digests == []


def test_review_prompt_admin_push_off(session, monkeypatch):
    sent: list = []
    monkeypatch.setattr(
        review_prompt_service,
        "send_event_review_prompt_email",
        lambda u, e, **_: sent.append(e.event_id) or True,
    )
    pushed: list = []
    monkeypatch.setattr(
        review_prompt_service, "send_push", lambda uid, **k: pushed.append(uid) or 1
    )
    _set(session, review_prompt_push_enabled="false")
    alice = _make_user(session, "alice@example.com", "alice")
    _make_event(
        session, "ev-past", start=datetime.now(timezone.utc) - timedelta(hours=6)
    )
    _going(session, alice, "ev-past")

    assert review_prompt_service.run_once()["pushed"] == 0
    assert pushed == [] and sent == ["ev-past"]
    assert review_prompt_service.run_once() == {"prompts": 0}


def test_reminder_respects_admin_channels(session, monkeypatch):
    sent: list = []
    monkeypatch.setattr(
        reminder_service,
        "send_event_reminder_email",
        lambda u, e, w, **k: sent.append(e.event_id) or True,
    )
    pushed: list = []
    monkeypatch.setattr(
        reminder_service, "send_push", lambda uid, **k: pushed.append(uid) or 1
    )
    _set(session, event_reminders_email_instant="false")
    alice = _make_user(session, "alice@example.com", "alice")
    _make_event(
        session, "ev-soon", start=datetime.now(timezone.utc) + timedelta(hours=3)
    )
    _going(session, alice, "ev-soon")

    stats = reminder_service.run_once()
    assert stats == {"reminders": 1, "emailed": 0, "pushed": 1}
    assert sent == []


def test_activity_push_respects_admin_feature_switch(session, monkeypatch):
    monkeypatch.setattr(
        activity_email, "send_activity_digest_v2_email", lambda *a, **k: True
    )
    pushed: list = []
    monkeypatch.setattr(
        activity_email, "send_push", lambda uid, **k: pushed.append(uid) or 1
    )
    _set(session, social_activity_push_enabled="false")
    bob = _make_user(session, "bob@example.com", "bob")
    amy = _make_user(session, "amy@example.com", "amy")
    _notif(session, recipient=bob, actor=amy, kind="new_follower")

    assert activity_email.run_once()["pushed"] == 0
    assert pushed == []


def test_review_prompt_excludes_too_recent_hidden_and_deleted(session, monkeypatch):
    monkeypatch.setattr(
        review_prompt_service, "send_event_review_prompt_email", lambda *a, **k: True
    )
    monkeypatch.setattr(review_prompt_service, "send_push", lambda *a, **k: 0)

    alice = _make_user(session, "alice@example.com", "alice")
    # Ended too recently — still inside the configured delay window.
    _make_event(
        session, "ev-just-ended", start=datetime.now(timezone.utc) - timedelta(hours=1)
    )
    _going(session, alice, "ev-just-ended")
    # Hidden event — excluded.
    _make_event(
        session,
        "ev-hidden",
        start=datetime.now(timezone.utc) - timedelta(hours=6),
        is_hidden=True,
    )
    _going(session, alice, "ev-hidden")
    # Soft-deleted event — excluded.
    _make_event(
        session,
        "ev-deleted",
        start=datetime.now(timezone.utc) - timedelta(hours=6),
        deleted_at=datetime.now(timezone.utc),
    )
    _going(session, alice, "ev-deleted")

    assert review_prompt_service.run_once() == {"prompts": 0}


def test_review_prompt_lookback_hours_widens_scan_window(session, monkeypatch):
    """An event that ended just past the DEFAULT 24h lookback (delay+lookback)
    is skipped, but is picked up once REVIEW_PROMPT_LOOKBACK_HOURS is widened
    to cover it — proves the lookback window is actually configurable and not
    a hardcoded constant."""
    monkeypatch.setattr(
        review_prompt_service, "send_event_review_prompt_email", lambda *a, **k: True
    )
    monkeypatch.setattr(review_prompt_service, "send_push", lambda *a, **k: 0)

    alice = _make_user(session, "alice@example.com", "alice")
    # Default delay=3h + lookback=24h => window covers events whose `end`
    # is [3h, 27h] ago. `start` is 30h ago and `_make_event` sets
    # `end = start + 2h`, so this event's `end` is 28h ago — just outside
    # the default window.
    _make_event(
        session, "ev-old", start=datetime.now(timezone.utc) - timedelta(hours=30)
    )
    _going(session, alice, "ev-old")

    assert review_prompt_service.run_once() == {"prompts": 0}

    monkeypatch.setattr(
        "backend.config.loader.get_review_prompt_lookback_hours", lambda: 48
    )
    stats = review_prompt_service.run_once()
    assert stats["prompts"] == 1


# --- Review-prompt friend social proof --------------------------------------


def _follow(
    session: Session, follower: User, followee: User, *, status: str = "approved"
) -> None:
    session.add(
        UserFollow(follower_id=follower.id, followee_id=followee.id, status=status)
    )
    session.commit()


def _rate(
    session: Session,
    user: User,
    event_id: str,
    *,
    stars: int = 5,
    status: str = "approved",
    is_anonymous: bool = False,
) -> None:
    session.add(
        EventRating(
            event_id=event_id,
            user_id=user.id,
            stars=stars,
            status=status,
            is_anonymous=is_anonymous,
        )
    )
    session.commit()


def test_friend_review_proof_names_and_others(session):
    alice = _make_user(session, "alice@example.com", "alice")
    carol = _make_user(session, "carol@example.com", "carol")
    dan = _make_user(session, "dan@example.com", "dan")
    erin = _make_user(session, "erin@example.com", "erin")
    flo = _make_user(session, "flo@example.com", "flo")
    _make_event(session, "ev1", start=datetime.now(timezone.utc) - timedelta(hours=6))
    for reviewer in (carol, dan, erin, flo):
        _follow(session, alice, reviewer)
    _rate(session, carol, "ev1")
    _rate(session, dan, "ev1")
    _rate(session, erin, "ev1")
    _rate(session, flo, "ev1", is_anonymous=True)  # anon: counts, no name

    proof = review_prompt_service.friend_review_proof(session, alice.id, "ev1")
    assert proof is not None
    # Named reviewers sorted case-insensitively, truncated to _MAX_PROOF_NAMES.
    assert proof.names == ["Carol", "Dan"]
    # 1 remaining named (Erin) + 1 anonymous (Flo) fold into "+2 others".
    assert proof.others == 2
    assert review_prompt_service.proof_phrase(proof) == "Carol, Dan +2 others"


def test_friend_review_proof_none_when_only_anon_or_rejected(session):
    alice = _make_user(session, "alice@example.com", "alice")
    carol = _make_user(session, "carol@example.com", "carol")
    dan = _make_user(session, "dan@example.com", "dan")
    _make_event(session, "ev1", start=datetime.now(timezone.utc) - timedelta(hours=6))
    _follow(session, alice, carol)
    _follow(session, alice, dan)
    _rate(session, carol, "ev1", is_anonymous=True)  # no name
    _rate(session, dan, "ev1", status="rejected")  # excluded entirely

    assert review_prompt_service.friend_review_proof(session, alice.id, "ev1") is None


def test_friend_review_proof_is_directional(session):
    """Only the recipient's own outgoing follows count — a follower who
    reviewed the event does not produce social proof for the recipient."""
    alice = _make_user(session, "alice@example.com", "alice")
    carol = _make_user(session, "carol@example.com", "carol")
    _make_event(session, "ev1", start=datetime.now(timezone.utc) - timedelta(hours=6))
    # Carol follows Alice (reverse direction), and Carol reviewed the event.
    _follow(session, carol, alice)
    _rate(session, carol, "ev1")

    assert review_prompt_service.friend_review_proof(session, alice.id, "ev1") is None


def test_friend_review_proof_ignores_pending_follows(session):
    alice = _make_user(session, "alice@example.com", "alice")
    carol = _make_user(session, "carol@example.com", "carol")
    _make_event(session, "ev1", start=datetime.now(timezone.utc) - timedelta(hours=6))
    _follow(session, alice, carol, status="pending")
    _rate(session, carol, "ev1")

    assert review_prompt_service.friend_review_proof(session, alice.id, "ev1") is None


def test_proof_phrase_variants():
    FriendProof = review_prompt_service.FriendProof
    proof_phrase = review_prompt_service.proof_phrase
    assert proof_phrase(FriendProof(names=["Laura"], others=0)) == "Laura"
    assert (
        proof_phrase(FriendProof(names=["Laura", "Marc"], others=0)) == "Laura and Marc"
    )
    assert (
        proof_phrase(FriendProof(names=["Laura", "Marc"], others=3))
        == "Laura, Marc +3 others"
    )
    assert proof_phrase(FriendProof(names=["Laura"], others=1)) == "Laura +1 other"


def test_run_once_sets_friend_context_and_email_variant(session, monkeypatch):
    captured: list = []
    monkeypatch.setattr(
        review_prompt_service,
        "send_event_review_prompt_email",
        lambda u, e, friend_proof=None, **_: captured.append(friend_proof) or True,
    )
    monkeypatch.setattr(review_prompt_service, "send_push", lambda *a, **k: 0)

    alice = _make_user(session, "alice@example.com", "alice")
    carol = _make_user(session, "carol@example.com", "carol")
    _make_event(
        session, "ev-past", start=datetime.now(timezone.utc) - timedelta(hours=6)
    )
    _going(session, alice, "ev-past")
    _follow(session, alice, carol)
    _rate(session, carol, "ev-past")

    assert review_prompt_service.run_once()["prompts"] == 1
    assert captured == ["Carol"]

    notif = session.exec(
        select(Notification)
        .where(Notification.recipient_user_id == alice.id)
        .where(Notification.kind == review_prompt_service.EVENT_REVIEW_PROMPT)
    ).first()
    assert notif is not None
    assert notif.context == "Carol"


# --- Admin force-send review prompt -----------------------------------------


def test_review_prompt_send_now_per_user_statuses(client, session, monkeypatch):
    emailed: list = []
    monkeypatch.setattr(
        "backend.services.email.send_event_review_prompt_email",
        lambda u, e, friend_proof=None: emailed.append((u.email, friend_proof)) or True,
    )
    monkeypatch.setattr("backend.services.push_service.send_push", lambda *a, **k: 0)

    _make_event(
        session, "ev-past", start=datetime.now(timezone.utc) - timedelta(hours=6)
    )
    gina = _make_user(
        session,
        "gina@example.com",
        "gina",
        push_review_prompt_enabled=False,
    )
    bob = _make_user(
        session,
        "bob@example.com",
        "bob",
        email_review_prompt_enabled=False,
        push_review_prompt_enabled=False,
    )
    carol = _make_user(session, "carol@example.com", "carol")
    ned = _make_user(session, "ned@example.com", "ned")
    for u in (gina, bob, carol):
        _going(session, u, "ev-past")
    # ned attends nothing; carol already rated.
    _rate(session, carol, "ev-past")

    _login(client, "admin@example.com")
    r = client.post(
        "/api/admin/notifications/review-prompt/send-now",
        json={
            "event_id": "ev-past",
            "user_ids": [str(gina.id), str(bob.id), str(carol.id), str(ned.id)],
        },
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["emailed"] == 1
    assert data["in_app_created"] == 1  # only gina gets an in-app prompt
    status_by_email = {row["email"]: row["status"] for row in data["results"]}
    assert status_by_email["gina@example.com"] == "sent"
    assert status_by_email["bob@example.com"] == "skipped_disabled"
    assert status_by_email["carol@example.com"] == "skipped_already_rated"
    assert status_by_email["ned@example.com"] == "skipped_not_attended"
    assert emailed == [("gina@example.com", None)]


def test_review_prompt_send_now_resend(client, session, monkeypatch):
    emailed: list = []
    monkeypatch.setattr(
        "backend.services.email.send_event_review_prompt_email",
        lambda u, e, friend_proof=None: emailed.append(u.email) or True,
    )
    monkeypatch.setattr("backend.services.push_service.send_push", lambda *a, **k: 0)

    _make_event(
        session, "ev-past", start=datetime.now(timezone.utc) - timedelta(hours=6)
    )
    alice = _make_user(
        session, "alice@example.com", "alice", push_review_prompt_enabled=False
    )
    _going(session, alice, "ev-past")
    _login(client, "admin@example.com")

    def _send(resend: bool):
        return client.post(
            "/api/admin/notifications/review-prompt/send-now",
            json={
                "event_id": "ev-past",
                "user_ids": [str(alice.id)],
                "resend": resend,
            },
        ).json()

    first = _send(False)
    assert first["emailed"] == 1
    assert first["results"][0]["status"] == "sent"

    again = _send(False)
    assert again["emailed"] == 0
    assert again["results"][0]["status"] == "already_sent"

    resent = _send(True)
    assert resent["emailed"] == 1
    assert resent["results"][0]["status"] == "sent"
    assert emailed == ["alice@example.com", "alice@example.com"]


def test_review_prompt_send_now_friend_variant(client, session, monkeypatch):
    emailed: list = []
    monkeypatch.setattr(
        "backend.services.email.send_event_review_prompt_email",
        lambda u, e, friend_proof=None: emailed.append(friend_proof) or True,
    )
    monkeypatch.setattr("backend.services.push_service.send_push", lambda *a, **k: 0)

    _make_event(
        session, "ev-past", start=datetime.now(timezone.utc) - timedelta(hours=6)
    )
    alice = _make_user(
        session, "alice@example.com", "alice", push_review_prompt_enabled=False
    )
    carol = _make_user(session, "carol@example.com", "carol")
    _going(session, alice, "ev-past")
    _follow(session, alice, carol)
    _rate(session, carol, "ev-past")
    _login(client, "admin@example.com")

    r = client.post(
        "/api/admin/notifications/review-prompt/send-now",
        json={"event_id": "ev-past", "user_ids": [str(alice.id)]},
    )
    assert r.status_code == 200, r.text
    assert emailed == ["Carol"]
    notif = session.exec(
        select(Notification)
        .where(Notification.recipient_user_id == alice.id)
        .where(Notification.kind == review_prompt_service.EVENT_REVIEW_PROMPT)
    ).first()
    assert notif is not None
    assert notif.context == "Carol"


def test_review_prompt_send_now_requires_admin(client, session):
    _make_event(
        session, "ev-past", start=datetime.now(timezone.utc) - timedelta(hours=6)
    )
    plain = _make_user(session, "plain@example.com", "plain")
    _login(client, "plain@example.com")
    r = client.post(
        "/api/admin/notifications/review-prompt/send-now",
        json={"event_id": "ev-past", "user_ids": [str(plain.id)]},
    )
    assert r.status_code == 403


def test_review_prompt_send_now_missing_event(client, session):
    _login(client, "admin@example.com")
    r = client.post(
        "/api/admin/notifications/review-prompt/send-now",
        json={
            "event_id": "does-not-exist",
            "user_ids": ["00000000-0000-0000-0000-000000000001"],
        },
    )
    assert r.status_code == 404


def test_review_prompt_candidates_lists_only_attendees(client, session):
    _make_event(
        session, "ev-past", start=datetime.now(timezone.utc) - timedelta(hours=6)
    )
    gina = _make_user(session, "gina@example.com", "gina")
    carol = _make_user(session, "carol@example.com", "carol")
    _make_user(session, "ned@example.com", "ned")  # not an attendee
    _going(session, gina, "ev-past")
    _going(session, carol, "ev-past")
    _rate(session, carol, "ev-past")  # attended AND rated

    _login(client, "admin@example.com")
    r = client.get("/api/admin/events/ev-past/review-prompt-candidates")
    assert r.status_code == 200, r.text
    rows = {row["email"]: row for row in r.json()}
    assert set(rows) == {"gina@example.com", "carol@example.com"}  # ned excluded
    assert rows["gina@example.com"]["already_rated"] is False
    assert rows["carol@example.com"]["already_rated"] is True


def test_review_prompt_candidates_requires_admin(client, session):
    _make_event(
        session, "ev-past", start=datetime.now(timezone.utc) - timedelta(hours=6)
    )
    _make_user(session, "plain@example.com", "plain")
    _login(client, "plain@example.com")
    r = client.get("/api/admin/events/ev-past/review-prompt-candidates")
    assert r.status_code == 403


def test_review_prompt_candidates_missing_event(client, session):
    _login(client, "admin@example.com")
    r = client.get("/api/admin/events/nope/review-prompt-candidates")
    assert r.status_code == 404


def test_search_events_include_past(client, session):
    _make_event(
        session,
        "ev-past",
        start=datetime.now(timezone.utc) - timedelta(days=3),
        title="Rooftop Salsa Social",
    )
    # Default search excludes past events.
    r = client.get("/api/events/search?q=Rooftop")
    assert r.status_code == 200
    assert r.json() == []
    # include_past surfaces it.
    r = client.get("/api/events/search?q=Rooftop&include_past=true")
    assert r.status_code == 200
    ids = [e["event_id"] for e in r.json()]
    assert "ev-past" in ids


# --- Activity digest emails -------------------------------------------------


def test_activity_digest_batches_into_one_email(session, monkeypatch):
    calls: list = []
    monkeypatch.setattr(
        activity_email,
        "send_activity_digest_v2_email",
        lambda recipient, sections, **_: calls.append(
            (recipient.id, [e["primary_html"] for s in sections for e in s["entries"]])
        ),
    )
    monkeypatch.setattr(activity_email, "send_push", lambda *a, **k: 0)

    bob = _make_user(session, "bob@example.com", "bob")
    a1 = _make_user(session, "a1@example.com", "a1")
    a2 = _make_user(session, "a2@example.com", "a2")
    old = datetime.now(timezone.utc) - timedelta(minutes=5)
    _notif(session, recipient=bob, actor=a1, kind="new_follower", created_at=old)
    _notif(session, recipient=bob, actor=a2, kind="new_friend", created_at=old)

    # ``force=True`` bypasses the per-user schedule window so this test
    # is deterministic regardless of wall-clock time.
    stats = activity_email.run_once(force=True)
    assert stats["digests"] == 1
    assert len(calls) == 1
    assert calls[0][0] == bob.id
    assert len(calls[0][1]) == 2  # both notifications in one digest


def test_activity_digest_suppresses_follower_and_carries_grouping_data(
    session, monkeypatch
):
    calls: list[list[dict]] = []
    monkeypatch.setattr(
        activity_email,
        "send_activity_digest_v2_email",
        lambda _recipient, sections, **_: calls.append(sections) or True,
    )
    monkeypatch.setattr(activity_email, "send_push", lambda *a, **k: 0)

    bob = _make_user(session, "bob@example.com", "bob")
    alice = _make_user(session, "alice@example.com", "alice")
    event = _make_event(session, "ev-match", title="Matched Social")
    event.image_url = "https://cdn.test/matched.webp"
    suggested_event = _make_event(session, "ev-suggested", title="Suggested Social")
    session.add(event)
    session.commit()
    old = datetime.now(timezone.utc) - timedelta(minutes=5)
    follower = _notif(
        session, recipient=bob, actor=alice, kind="new_follower", created_at=old
    )
    friendship = _notif(
        session,
        recipient=bob,
        actor=alice,
        kind="new_friend",
        created_at=old + timedelta(seconds=1),
    )
    matched = _notif(
        session,
        recipient=bob,
        actor=bob,
        kind="interest_event",
        event_id="ev-match",
        created_at=old,
    )
    matched.context = "Salsa · International · Paris"
    session.add(matched)
    suggested = _notif(
        session,
        recipient=bob,
        actor=alice,
        kind="subscription_suggested",
        event_id=suggested_event.event_id,
        created_at=old,
    )
    session.commit()

    stats = activity_email.run_once(force=True)

    assert stats["digests"] == 1
    by_feature = {section["feature"]: section for section in calls[0]}
    social_entries = by_feature["social_activity"]["entries"]
    assert len(social_entries) == 1
    assert social_entries[0]["kind"] == "new_friend"
    assert social_entries[0]["group_key"] == str(alice.id)
    interest_entry = by_feature["interest_matches"]["entries"][0]
    assert interest_entry["group_key"] == "alert:Salsa · International · Paris"
    assert "Salsa · International · Paris" in interest_entry["group_header_html"]
    assert "/saved-searches" in interest_entry["group_header_html"]
    assert ">Matched Social</a>" in interest_entry["group_item_html"]
    assert interest_entry["event_image_url"] == "https://cdn.test/matched.webp"
    suggested_entry = by_feature["suggested_events"]["entries"][0]
    assert suggested_entry["group_key"] == str(alice.id)
    assert "Alice" in suggested_entry["group_header_html"]
    assert "suggested" in suggested_entry["group_header_html"]
    assert ">Suggested Social</a>" in suggested_entry["group_item_html"]

    for row in (follower, friendship, matched, suggested):
        session.refresh(row)
        assert row.emailed_at is not None


def test_activity_digest_expands_multi_profile_match_into_alert_groups(
    session, monkeypatch
):
    calls: list[list[dict]] = []
    monkeypatch.setattr(
        activity_email,
        "send_activity_digest_v2_email",
        lambda _recipient, sections, **_: calls.append(sections) or True,
    )
    monkeypatch.setattr(activity_email, "send_push", lambda *a, **k: 0)

    bob = _make_user(session, "bob@example.com", "bob")
    event = _make_event(session, "ev-match", title="Matched Social")
    dance_group = TagGroup(slug="dance-style", label="Dance styles")
    session.add(dance_group)
    session.commit()
    session.refresh(dance_group)
    salsa = Tag(group_id=dance_group.id, slug="salsa", label="Salsa")
    session.add(salsa)
    session.commit()
    session.refresh(salsa)
    profiles = [
        UserInterestProfile(
            user_id=bob.id,
            label="Home",
            area_label="Paris",
            min_lat=48,
            min_lng=2,
            max_lat=49,
            max_lng=3,
            reach_filter="international",
        ),
        UserInterestProfile(
            user_id=bob.id,
            label="Trip",
            area_label="Berlin",
            min_lat=52,
            min_lng=13,
            max_lat=53,
            max_lng=14,
            reach_filter="regional_plus",
        ),
    ]
    session.add_all(profiles)
    session.commit()
    for profile in profiles:
        session.refresh(profile)
        session.add(UserInterestProfileTag(profile_id=profile.id, tag_id=salsa.id))
    notification = _notif(
        session,
        recipient=bob,
        actor=bob,
        kind="interest_event",
        event_id=event.event_id,
        created_at=datetime.now(timezone.utc) - timedelta(minutes=5),
    )
    notification.context = "Home, Trip"
    session.add(notification)
    session.commit()

    assert activity_email.run_once(force=True)["digests"] == 1

    section = next(
        section for section in calls[0] if section["feature"] == "interest_matches"
    )
    entries = {entry["group_key"]: entry for entry in section["entries"]}
    assert set(entries) == {"alert:Home", "alert:Trip"}
    assert "Salsa · International · Paris" in entries["alert:Home"]["group_header_html"]
    assert "Salsa · Regional+ · Berlin" in entries["alert:Trip"]["group_header_html"]


def test_activity_digest_groups_friend_milestone_batch(session, monkeypatch):
    email_entries: list[dict] = []
    push_calls: list[dict] = []
    monkeypatch.setattr(
        activity_email,
        "send_activity_digest_v2_email",
        lambda _recipient, sections, **_: (
            email_entries.extend(
                entry for section in sections for entry in section["entries"]
            )
            or True
        ),
    )
    monkeypatch.setattr(
        activity_email,
        "send_push",
        lambda *a, **k: push_calls.append(k) or 1,
    )

    bob = _make_user(session, "bob@example.com", "bob")
    alice = _make_user(session, "alice@example.com", "alice")
    old = datetime.now(timezone.utc) - timedelta(minutes=5)
    rows = (
        Notification(
            recipient_user_id=bob.id,
            actor_user_id=alice.id,
            kind="subscription_milestone",
            subject_key="first_event",
            group_key="friend-batch",
            context="First Steps",
            created_at=old,
        ),
        Notification(
            recipient_user_id=bob.id,
            actor_user_id=alice.id,
            kind="subscription_milestone",
            subject_key="events_5",
            group_key="friend-batch",
            context="Regular",
            created_at=old + timedelta(seconds=1),
        ),
    )
    session.add_all(rows)
    session.commit()

    stats = activity_email.run_once(
        force=True,
        kinds=("subscription_milestone",),
        max_notifications_per_user=1,
    )

    assert stats["digests"] == 1
    assert len(email_entries) == 1
    assert "2 milestones" in email_entries[0]["primary_html"]
    assert "First Steps" not in email_entries[0]["primary_html"]
    assert email_entries[0]["subline"] == "First Steps, Regular"
    assert len(push_calls) == 1
    assert "2 milestones" in push_calls[0]["body"]
    assert "First Steps" in push_calls[0]["body"]
    assert "Regular" in push_calls[0]["body"]
    for row in rows:
        session.refresh(row)
        assert row.emailed_at is not None
        assert row.pushed_at is not None


def test_activity_digest_drops_past_event_but_stamps_it(session, monkeypatch):
    """Past-event guard: a ``subscription_going`` notice whose event has
    already ended is excluded from the digest email while the future one is
    kept. Both rows are stamped ``emailed_at`` so the past one is consumed
    and never re-sent on a later tick."""
    calls: list = []
    monkeypatch.setattr(
        activity_email,
        "send_activity_digest_v2_email",
        lambda recipient, sections, **_: (
            calls.append(
                (
                    recipient.id,
                    [e["primary_html"] for s in sections for e in s["entries"]],
                )
            )
            or True
        ),
    )
    monkeypatch.setattr(activity_email, "send_push", lambda *a, **k: 0)

    bob = _make_user(session, "bob@example.com", "bob")
    a1 = _make_user(session, "a1@example.com", "a1")
    _make_event(
        session, "ev-future", start=datetime.now(timezone.utc) + timedelta(hours=6)
    )
    _make_event(
        session, "ev-past", start=datetime.now(timezone.utc) - timedelta(hours=6)
    )
    old = datetime.now(timezone.utc) - timedelta(minutes=5)
    future = _notif(
        session,
        recipient=bob,
        actor=a1,
        kind="subscription_going",
        event_id="ev-future",
        created_at=old,
    )
    past = _notif(
        session,
        recipient=bob,
        actor=a1,
        kind="subscription_going",
        event_id="ev-past",
        created_at=old,
    )

    stats = activity_email.run_once(force=True)
    assert stats["digests"] == 1
    assert len(calls) == 1
    assert len(calls[0][1]) == 1  # only the future line rendered

    session.refresh(future)
    session.refresh(past)
    assert future.emailed_at is not None  # sent
    assert past.emailed_at is not None  # excluded but consumed
    # A later tick has nothing left to send (past row not re-selected).
    assert activity_email.run_once(force=True) == {"digests": 0, "pushed": 0}


def test_activity_digest_keeps_review_on_past_event(session, monkeypatch):
    """Reviews are inherently about past events, so the past-event guard must
    NOT drop a ``subscription_review`` notice even though its event has ended
    (mirrors ``skip_past_guard`` in the fan-out path)."""
    calls: list = []
    monkeypatch.setattr(
        activity_email,
        "send_activity_digest_v2_email",
        lambda recipient, sections, **_: (
            calls.append(
                (
                    recipient.id,
                    [e["primary_html"] for s in sections for e in s["entries"]],
                )
            )
            or True
        ),
    )
    monkeypatch.setattr(activity_email, "send_push", lambda *a, **k: 0)

    bob = _make_user(session, "bob@example.com", "bob")
    a1 = _make_user(session, "a1@example.com", "a1")
    _make_event(
        session, "ev-past", start=datetime.now(timezone.utc) - timedelta(hours=6)
    )
    old = datetime.now(timezone.utc) - timedelta(minutes=5)
    _notif(
        session,
        recipient=bob,
        actor=a1,
        kind="subscription_review",
        event_id="ev-past",
        created_at=old,
    )

    stats = activity_email.run_once(force=True)
    assert stats["digests"] == 1
    assert len(calls) == 1
    assert len(calls[0][1]) == 1  # review line kept despite past event


def test_milestone_delivered_via_activity_digest(session, monkeypatch):
    """A milestone notice left pending (digest mode, the default) is folded
    into the batched activity digest. activity_email must NOT send it
    instantly or push it — those channels are owned by the milestone
    service — so only the digest email fires and stamps ``emailed_at``."""
    calls: list = []
    pushes: list = []
    monkeypatch.setattr(
        activity_email,
        "send_activity_digest_v2_email",
        lambda recipient, sections, **_: (
            calls.append(
                (
                    recipient.id,
                    [e["primary_html"] for s in sections for e in s["entries"]],
                )
            )
            or True
        ),
    )
    monkeypatch.setattr(
        activity_email, "send_push", lambda *a, **k: pushes.append(1) or 0
    )

    bob = _make_user(session, "bob@example.com", "bob")
    old = datetime.now(timezone.utc) - timedelta(minutes=5)
    n = _notif(
        session, recipient=bob, actor=bob, kind="milestone_unlocked", created_at=old
    )
    n.subject_key = "first_event"
    n.description = "Attended your first event"
    session.add(n)
    session.commit()

    stats = activity_email.run_once(force=True)
    assert stats["digests"] == 1
    assert len(calls) == 1
    assert calls[0][0] == bob.id
    assert len(calls[0][1]) == 1  # the single milestone line
    assert pushes == []  # digest-only: activity_email never pushes milestone

    session.refresh(n)
    assert n.emailed_at is not None  # digest track stamped
    assert n.instant_emailed_at is None  # instant path skipped
    assert n.pushed_at is None  # push owned by milestone service


def test_milestone_not_sent_instantly_by_activity_email(session, monkeypatch):
    """Even with the milestone feature routed to instant, activity_email must
    leave the rich immediate email to the milestone service (digest-only from
    activity_email's perspective) — so no instant email is emitted here."""
    session.add(SiteSetting(key="milestone_unlocked_email_instant", value="true"))
    session.commit()
    calls: list = []
    monkeypatch.setattr(
        activity_email,
        "send_activity_digest_email",
        lambda recipient, lines, **_: calls.append(recipient.id) or True,
    )
    monkeypatch.setattr(activity_email, "send_push", lambda *a, **k: 0)

    bob = _make_user(session, "bob@example.com", "bob")
    old = datetime.now(timezone.utc) - timedelta(minutes=5)
    n = _notif(
        session, recipient=bob, actor=bob, kind="milestone_unlocked", created_at=old
    )
    n.subject_key = "first_event"
    session.add(n)
    session.commit()

    stats = activity_email.run_once(force=False)
    assert stats["instant_emails"] == 0
    session.refresh(n)
    assert n.instant_emailed_at is None


def test_activity_digest_kinds_filter_scopes_to_one_feature(session, monkeypatch):
    """Per-feature "Send now" passes ``kinds`` so only that feature's
    notifications are emailed; the other kinds stay pending for a later
    tick. Backs the admin ``digest/send-now?feature=`` scoping."""
    calls: list = []
    monkeypatch.setattr(
        activity_email,
        "send_activity_digest_v2_email",
        lambda recipient, sections, **_: calls.append(
            (recipient.id, [e["primary_html"] for s in sections for e in s["entries"]])
        ),
    )
    monkeypatch.setattr(activity_email, "send_push", lambda *a, **k: 0)

    bob = _make_user(session, "bob@example.com", "bob")
    a1 = _make_user(session, "a1@example.com", "a1")
    old = datetime.now(timezone.utc) - timedelta(minutes=5)
    reviewed = _notif(
        session, recipient=bob, actor=a1, kind="subscription_review", created_at=old
    )
    followed = _notif(
        session, recipient=bob, actor=a1, kind="new_follower", created_at=old
    )

    # Scope to the friend_reviews feature only.
    stats = activity_email.run_once(force=True, kinds=("subscription_review",))
    assert stats["digests"] == 1
    assert len(calls) == 1
    assert len(calls[0][1]) == 1  # only the review line

    session.refresh(reviewed)
    session.refresh(followed)
    assert reviewed.emailed_at is not None  # in-scope: stamped/sent
    assert followed.emailed_at is None  # out-of-scope: left pending


def test_activity_digest_emailed_at_is_idempotent(session, monkeypatch):
    calls: list = []
    monkeypatch.setattr(
        activity_email,
        "send_activity_digest_v2_email",
        lambda recipient, *a, **_: calls.append(recipient.id),
    )
    monkeypatch.setattr(activity_email, "send_push", lambda *a, **k: 0)

    bob = _make_user(session, "bob@example.com", "bob")
    a1 = _make_user(session, "a1@example.com", "a1")
    old = datetime.now(timezone.utc) - timedelta(minutes=5)
    _notif(session, recipient=bob, actor=a1, kind="new_follower", created_at=old)

    activity_email.run_once(force=True)
    # Re-run: the notification is now stamped (both channels), so nothing
    # to send.
    assert activity_email.run_once(force=True) == {"digests": 0, "pushed": 0}
    assert calls == [bob.id]


def test_activity_email_instant_mode_sends_without_schedule(session, monkeypatch):
    """When admin routes a feature to instant mode, its email is sent
    immediately (no schedule gate) and stamps ``instant_emailed_at``,
    independently of the digest ``emailed_at`` track."""
    calls: list = []
    monkeypatch.setattr(
        activity_email,
        "send_activity_digest_email",
        lambda recipient, lines, **_: calls.append(recipient.id) or True,
    )
    monkeypatch.setattr(activity_email, "send_push", lambda *a, **k: 0)

    # Route friends_going to instant-only (no digest).
    session.add(SiteSetting(key="friends_going_email_instant", value="true"))
    session.add(SiteSetting(key="friends_going_email_digest", value="false"))
    session.commit()

    bob = _make_user(session, "bob@example.com", "bob")
    a1 = _make_user(session, "a1@example.com", "a1")
    _make_event(session, "ev-going")
    old = datetime.now(timezone.utc) - timedelta(minutes=5)
    n = _notif(
        session,
        recipient=bob,
        actor=a1,
        kind="subscription_going",
        event_id="ev-going",
        created_at=old,
    )

    # force=False: instant path must NOT depend on the weekly slot.
    stats = activity_email.run_once(force=False)
    assert stats["instant_emails"] == 1
    assert calls == [bob.id]

    session.refresh(n)
    assert n.instant_emailed_at is not None
    # Digest track untouched (digest mode was off for this feature).
    assert n.emailed_at is None

    # Re-run: instant already stamped → no second send.
    stats2 = activity_email.run_once(force=False)
    assert stats2["instant_emails"] == 0


def test_instant_feature_never_also_digests(session, monkeypatch):
    """When a feature has BOTH instant and digest enabled, a notification is
    emailed on exactly one path — instant wins and the digest path is skipped
    for that row (no duplicate 'basic + enriched' email)."""
    digest_calls: list = []
    instant_calls: list = []
    monkeypatch.setattr(
        activity_email,
        "send_activity_digest_v2_email",
        lambda recipient, *a, **_: digest_calls.append(recipient.id) or True,
    )
    monkeypatch.setattr(
        activity_email,
        "send_activity_digest_email",
        lambda recipient, lines, **_: instant_calls.append(recipient.id) or True,
    )
    monkeypatch.setattr(activity_email, "send_push", lambda *a, **k: 0)

    # friends_going with instant AND digest both on.
    session.add(SiteSetting(key="friends_going_email_instant", value="true"))
    session.add(SiteSetting(key="friends_going_email_digest", value="true"))
    session.commit()

    bob = _make_user(session, "bob@example.com", "bob")
    a1 = _make_user(session, "a1@example.com", "a1")
    _make_event(session, "ev-going")
    old = datetime.now(timezone.utc) - timedelta(minutes=5)
    n = _notif(
        session,
        recipient=bob,
        actor=a1,
        kind="subscription_going",
        event_id="ev-going",
        created_at=old,
    )

    # force=True so the digest slot is not what gates delivery.
    stats = activity_email.run_once(force=True)

    # Exactly one email overall: the instant one. The digest path is skipped.
    assert stats["instant_emails"] == 1
    assert instant_calls == [bob.id]
    assert digest_calls == []

    session.refresh(n)
    assert n.instant_emailed_at is not None
    assert n.emailed_at is None


def test_activity_digest_optout_skips_email_but_stamps(session, monkeypatch):
    calls: list = []
    monkeypatch.setattr(
        activity_email,
        "send_activity_digest_v2_email",
        lambda recipient, *a, **_: calls.append(recipient.id),
    )
    monkeypatch.setattr(activity_email, "send_push", lambda *a, **k: 0)

    bob = _make_user(
        session, "bob@example.com", "bob", email_social_activity_enabled=False
    )
    a1 = _make_user(session, "a1@example.com", "a1")
    old = datetime.now(timezone.utc) - timedelta(minutes=5)
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
        created_at=datetime.now(timezone.utc) - timedelta(days=30),
    )

    assert activity_email.run_once(force=True) == {"digests": 0, "pushed": 0}


def test_activity_digest_gates_on_scheduled_slot(session, monkeypatch):
    """Without ``force``, email only delivers to users in their local slot,
    but push is NOT gated by the schedule — it fires on every tick
    regardless (see ``run_once`` docstring). Regression test for the bug
    where push silently waited on the email cadence."""
    calls: list = []
    push_calls: list = []
    monkeypatch.setattr(
        activity_email,
        "send_activity_digest_email",
        lambda recipient, lines, **_: calls.append(recipient.id),
    )
    monkeypatch.setattr(
        activity_email,
        "send_push",
        lambda recipient_id, **_: push_calls.append(recipient_id) or 1,
    )
    # Freeze the schedule so this test is TZ-independent.
    monkeypatch.setattr(
        "backend.services.activity_email.get_activity_digest_schedule",
        lambda: "tue,fri @ 09:00",
    )

    bob = _make_user(session, "bob@example.com", "bob", timezone="UTC")
    a1 = _make_user(session, "a1@example.com", "a1")
    old = datetime.now(timezone.utc) - timedelta(minutes=5)
    n = _notif(session, recipient=bob, actor=a1, kind="new_follower", created_at=old)

    class _FakeDateTime:
        """Freeze ``datetime.now`` to a Monday 09:00 UTC (off-schedule)."""

        @staticmethod
        def now(tz=None):
            return datetime(2026, 7, 6, 9, 0, tzinfo=tz)  # Monday

    monkeypatch.setattr("backend.services.activity_email.datetime", _FakeDateTime)

    stats = activity_email.run_once()
    assert stats.get("digests", 0) == 0
    assert stats.get("skipped_off_schedule", 0) == 1
    assert calls == []
    # Push is unaffected by the off-schedule email gate.
    assert stats.get("pushed", 0) == 1
    assert push_calls == [bob.id]
    session.refresh(n)
    # Off-schedule rows stay unstamped for EMAIL so they roll into the
    # next slot, but ARE stamped for push (already delivered).
    assert n.emailed_at is None
    assert n.pushed_at is not None


def _freeze_activity_now(monkeypatch, holder: dict) -> None:
    class _FakeDateTime:
        @staticmethod
        def now(tz=None):
            return holder["now"].astimezone(tz) if tz else holder["now"]

    monkeypatch.setattr("backend.services.activity_email.datetime", _FakeDateTime)


def _interest_notif(session: Session, user: User, event_id: str) -> Notification:
    n = _notif(
        session,
        recipient=user,
        actor=user,
        kind="interest_event",
        event_id=event_id,
        created_at=datetime.now(timezone.utc) - timedelta(minutes=5),
    )
    n.context = "Home"
    session.add(n)
    session.commit()
    return n


def test_interest_push_waits_for_schedule_slot_and_window(session, monkeypatch):
    push_calls: list = []
    monkeypatch.setattr(
        activity_email, "send_activity_digest_v2_email", lambda *a, **k: True
    )
    monkeypatch.setattr(
        activity_email,
        "send_push",
        lambda recipient_id, **kw: push_calls.append(kw) or 1,
    )
    monkeypatch.setattr(
        "backend.services.activity_email.get_interest_match_push_schedule",
        lambda: "tue,thu,sat @ 19:00",
    )
    holder = {"now": datetime(2026, 7, 6, 19, 30, tzinfo=timezone.utc)}  # Monday
    _freeze_activity_now(monkeypatch, holder)

    bob = _make_user(session, "bob@example.com", "bob", timezone="UTC")
    _make_event(session, "ev-1")
    n = _interest_notif(session, bob, "ev-1")

    stats = activity_email.run_once()
    assert stats["interest_push_deferred"] == 1
    assert push_calls == []
    session.refresh(n)
    assert n.pushed_at is None

    holder["now"] = datetime(2026, 7, 7, 19, 30, tzinfo=timezone.utc)  # Tuesday in slot
    stats = activity_email.run_once()
    assert stats["pushed"] == 1
    session.refresh(n)
    session.refresh(bob)
    assert n.pushed_at is not None
    assert bob.last_interest_push_at is not None

    # Already pushed today -> a later match waits for the next slot.
    _make_event(session, "ev-2")
    later = _interest_notif(session, bob, "ev-2")
    holder["now"] = datetime(2026, 7, 7, 20, 0, tzinfo=timezone.utc)
    assert activity_email.run_once()["interest_push_deferred"] == 1

    # Thursday but past the 3h window after 19:00 -> still deferred.
    holder["now"] = datetime(2026, 7, 9, 22, 30, tzinfo=timezone.utc)
    assert activity_email.run_once()["interest_push_deferred"] == 1
    session.refresh(later)
    assert later.pushed_at is None
    assert len(push_calls) == 1


def test_interest_push_force_bypasses_schedule(session, monkeypatch):
    push_calls: list = []
    monkeypatch.setattr(
        activity_email, "send_activity_digest_v2_email", lambda *a, **k: True
    )
    monkeypatch.setattr(
        activity_email,
        "send_push",
        lambda recipient_id, **kw: push_calls.append(kw) or 1,
    )
    monkeypatch.setattr(
        "backend.services.activity_email.get_interest_match_push_schedule",
        lambda: "sun @ 03:00",
    )
    bob = _make_user(session, "bob@example.com", "bob", timezone="UTC")
    _make_event(session, "ev-1")
    _interest_notif(session, bob, "ev-1")

    assert activity_email.run_once(force=True)["pushed"] == 1
    assert len(push_calls) == 1


def test_interest_push_combines_matches_and_names_soonest_event(session, monkeypatch):
    push_calls: list = []
    monkeypatch.setattr(
        activity_email, "send_activity_digest_v2_email", lambda *a, **k: True
    )
    monkeypatch.setattr(
        activity_email,
        "send_push",
        lambda recipient_id, **kw: push_calls.append(kw) or 1,
    )
    monkeypatch.setattr(
        "backend.services.activity_email.get_interest_match_push_schedule",
        lambda: "instant",
    )
    bob = _make_user(session, "bob@example.com", "bob")
    soon = datetime.now(timezone.utc) + timedelta(days=2)
    _make_event(
        session, "ev-late", title="Late Congress", start=soon + timedelta(days=30)
    )
    _make_event(session, "ev-soon", title="Soon Social", start=soon)
    _interest_notif(session, bob, "ev-late")
    _interest_notif(session, bob, "ev-soon")

    assert activity_email.run_once()["pushed"] == 1
    assert len(push_calls) == 1
    call = push_calls[0]
    assert call["title"] == "2 new events match your alerts"
    assert call["body"].startswith("Soon Social · ")
    assert call["body"].endswith(" +1 more")
    assert call["url"].startswith("/notifications?kind=interest_event&via=push&nid=")


def test_interest_push_single_match_links_to_event(session, monkeypatch):
    push_calls: list = []
    monkeypatch.setattr(
        activity_email, "send_activity_digest_v2_email", lambda *a, **k: True
    )
    monkeypatch.setattr(
        activity_email,
        "send_push",
        lambda recipient_id, **kw: push_calls.append(kw) or 1,
    )
    monkeypatch.setattr(
        "backend.services.activity_email.get_interest_match_push_schedule",
        lambda: "instant",
    )
    bob = _make_user(session, "bob@example.com", "bob")
    _make_event(session, "ev-1", title="Solo Social")
    _interest_notif(session, bob, "ev-1")

    activity_email.run_once()
    assert push_calls[0]["title"] == "New match: Home"
    assert push_calls[0]["body"].startswith("Solo Social · ")
    assert push_calls[0]["url"].startswith("/event/ev-1?via=push&nid=")


def test_notification_opened_push_marks_combined_push_siblings(client, session):
    bob = _make_user(session, "bob@example.com", "bob")
    pushed_at = datetime.now(timezone.utc) - timedelta(minutes=1)
    _make_event(session, "ev-1")
    _make_event(session, "ev-2")
    a = _interest_notif(session, bob, "ev-1")
    b = _interest_notif(session, bob, "ev-2")
    other = _notif(
        session, recipient=bob, actor=bob, kind="event_reminder", event_id="ev-1"
    )
    for n in (a, b, other):
        n.pushed_at = pushed_at
        session.add(n)
    session.commit()
    _login(client, "bob@example.com")

    r = client.post(f"/api/notifications/{a.id}/opened", json={"channel": "push"})

    assert r.status_code == 204
    for n in (a, b, other):
        session.refresh(n)
    assert a.push_opened_at is not None
    assert b.push_opened_at is not None
    assert other.push_opened_at is None


def test_notification_opened_email_is_first_touch_and_recipient_scoped(client, session):
    bob = _make_user(session, "bob@example.com", "bob")
    _make_user(session, "eve@example.com", "eve")
    _make_event(session, "ev-1")
    n = _interest_notif(session, bob, "ev-1")

    _login(client, "eve@example.com")
    assert (
        client.post(
            f"/api/notifications/{n.id}/opened", json={"channel": "email"}
        ).status_code
        == 404
    )

    _login(client, "bob@example.com")
    assert (
        client.post(
            f"/api/notifications/{n.id}/opened", json={"channel": "email"}
        ).status_code
        == 204
    )
    session.refresh(n)
    first = n.email_clicked_at
    assert first is not None
    client.post(f"/api/notifications/{n.id}/opened", json={"channel": "email"})
    session.refresh(n)
    assert n.email_clicked_at == first


def test_activity_digest_and_push_skip_anonymous_review(session, monkeypatch):
    email_calls: list = []
    push_calls: list = []
    monkeypatch.setattr(
        activity_email,
        "send_activity_digest_v2_email",
        lambda *args, **kwargs: email_calls.append((args, kwargs)) or True,
    )
    monkeypatch.setattr(
        activity_email,
        "send_push",
        lambda *args, **kwargs: push_calls.append((args, kwargs)) or 1,
    )
    bob = _make_user(session, "bob@example.com", "bob")
    alice = _make_user(session, "alice@example.com", "alice")
    _make_event(
        session,
        "ev-anon-review",
        start=datetime.now(timezone.utc) - timedelta(days=2),
    )
    _rate(session, alice, "ev-anon-review", is_anonymous=True)
    notification = _notif(
        session,
        recipient=bob,
        actor=alice,
        kind="subscription_review",
        event_id="ev-anon-review",
    )

    stats = activity_email.run_once(force=True)
    assert stats == {"digests": 0, "pushed": 0}
    assert email_calls == []
    assert push_calls == []
    session.refresh(notification)
    assert notification.emailed_at is None
    assert notification.pushed_at is None


def test_activity_digest_delivers_in_scheduled_slot(session, monkeypatch):
    """When ``now`` matches the user's local slot the digest ships."""
    calls: list = []
    monkeypatch.setattr(
        activity_email,
        "send_activity_digest_v2_email",
        lambda recipient, *a, **_: calls.append(recipient.id),
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
        created_at=datetime.now(timezone.utc) - timedelta(minutes=5),
    )

    class _FakeDateTime:
        """Freeze ``datetime.now`` to Tuesday 09:00 UTC."""

        @staticmethod
        def now(tz=None):
            return datetime(2026, 7, 7, 9, 0, tzinfo=tz)  # Tuesday

    monkeypatch.setattr("backend.services.activity_email.datetime", _FakeDateTime)

    stats = activity_email.run_once()
    assert stats["digests"] == 1
    assert calls == [bob.id]


def test_activity_digest_per_user_timezone(session, monkeypatch):
    """Two users on the same schedule ship in different UTC slots."""
    calls: list = []
    monkeypatch.setattr(
        activity_email,
        "send_activity_digest_v2_email",
        lambda recipient, *a, **_: calls.append(recipient.id),
    )
    monkeypatch.setattr(activity_email, "send_push", lambda *a, **k: 0)
    monkeypatch.setattr(
        "backend.services.activity_email.get_activity_digest_schedule",
        lambda: "tue @ 09:00",
    )

    paris = _make_user(session, "paris@example.com", "paris", timezone="Europe/Paris")
    tokyo = _make_user(session, "tokyo@example.com", "tokyo", timezone="Asia/Tokyo")
    a1 = _make_user(session, "a1@example.com", "a1")
    _notif(
        session,
        recipient=paris,
        actor=a1,
        kind="new_follower",
        created_at=datetime.now(timezone.utc) - timedelta(minutes=5),
    )
    _notif(
        session,
        recipient=tokyo,
        actor=a1,
        kind="new_follower",
        created_at=datetime.now(timezone.utc) - timedelta(minutes=5),
    )

    # Tuesday 07:00 UTC → 09:00 Europe/Paris (in slot), but 16:00 in Tokyo
    # (also past 09:00 slot for that day → in slot too). To isolate Paris,
    # freeze to Tue 08:00 UTC = 09:00 Paris (in slot) but 17:00 Tokyo
    # (past 09:00, in slot). Both fire.
    class _FakeDateTime:
        @staticmethod
        def now(tz=None):
            # Tuesday 00:15 UTC → 09:15 Tokyo (in slot), 01:15 Paris (before).
            return datetime(2026, 7, 7, 0, 15, tzinfo=tz)

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


def test_patch_review_prompt_flags_persists(client, session):
    """Review-prompt flags (Phase 3) PATCH through and round-trip in GET /me."""
    alice = _make_user(session, "alice@example.com", "alice")
    _login(client, "alice@example.com")

    r = client.patch(
        "/api/auth/notification-preferences",
        json={
            "email_review_prompt_enabled": False,
            "push_review_prompt_enabled": False,
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["email_review_prompt_enabled"] is False
    assert r.json()["push_review_prompt_enabled"] is False

    session.expire_all()
    refreshed = session.get(User, alice.id)
    assert refreshed.email_review_prompt_enabled is False
    assert refreshed.push_review_prompt_enabled is False

    me = client.get("/api/auth/me").json()
    assert me["email_review_prompt_enabled"] is False
    assert me["push_review_prompt_enabled"] is False


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


def test_unsubscribe_per_feature_category_flips_flag(client, session):
    """Each per-feature activity digest carries its own unsubscribe
    category. These were missing from UNSUBSCRIBE_CATEGORIES and crashed
    the digest footer with `ValueError: Unknown unsubscribe category`."""
    from backend.services.email_tokens import make_unsubscribe_token

    cases = [
        ("friends_going", "email_friends_going_enabled"),
        ("friend_reviews", "email_friend_reviews_enabled"),
        ("friend_milestones", "email_friend_milestones_enabled"),
    ]
    for i, (category, flag) in enumerate(cases):
        user = _make_user(session, f"u{i}@example.com", f"u{i}")
        # Should not raise for the new categories.
        token = make_unsubscribe_token(str(user.id), category)

        r = client.get(f"/api/auth/unsubscribe?token={token}")
        assert r.status_code == 200
        assert r.json()["status"] == "unsubscribed"

        session.expire_all()
        refreshed = session.get(User, user.id)
        assert getattr(refreshed, flag) is False
        # A sibling feature flag is untouched.
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
        def __init__(self, status, text=""):
            self.status_code = status
            self.text = text

    def fake_webpush(*, subscription_info, **kwargs):
        if "gone" in subscription_info["endpoint"]:
            raise FakeWebPushException("gone", response=_Resp(410))
        if "rekeyed" in subscription_info["endpoint"]:
            raise FakeWebPushException(
                "forbidden",
                response=_Resp(
                    403,
                    "the VAPID credentials in the authorization header do not "
                    "correspond to the credentials used to create the subscriptions.",
                ),
            )
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
    session.add(
        PushSubscription(
            user_id=alice.id, endpoint="https://push/rekeyed", p256dh="a", auth="b"
        )
    )
    session.commit()

    delivered = push_service.send_push(alice.id, "T", "B", url="/x")
    assert delivered == 1  # only the live endpoint
    # Stale (410) endpoint was pruned; live one remains.
    remaining = [s.endpoint for s in session.exec(select(PushSubscription)).all()]
    assert remaining == ["https://push/live"]


# --- Immediate delivery (post-request deliver job) ---------------------------


def _patch_digest_senders(monkeypatch) -> list:
    from backend.api.routes import social as social_module

    emails: list = []
    monkeypatch.setattr(
        activity_email,
        "send_activity_digest_email",
        lambda recipient, lines, **kw: (
            emails.append((recipient.id, kw.get("feature"))) or True
        ),
    )
    monkeypatch.setattr(
        activity_email,
        "send_activity_digest_v2_email",
        lambda recipient, *a, **k: emails.append((recipient.id, "digest_v2")) or True,
    )
    monkeypatch.setattr(
        social_module, "get_people_suggestions_for_email", lambda *a, **k: []
    )
    return emails


def _deliveries(session: Session, notification_id: int, channel: str) -> list:
    from backend.db.models import NotificationDelivery

    return session.exec(
        select(NotificationDelivery)
        .where(NotificationDelivery.notification_id == notification_id)
        .where(NotificationDelivery.channel == channel)
    ).all()


def test_deliver_immediate_sends_instant_email_once(session, monkeypatch):
    """Instant-mode features are emailed by the job, stamping
    ``instant_emailed_at`` (never the digest ``emailed_at``) and auditing the
    delivery as instant/job; a second run sends nothing."""
    emails = _patch_digest_senders(monkeypatch)
    monkeypatch.setattr(activity_email, "send_push", lambda *a, **k: 0)
    session.add(SiteSetting(key="friends_going_email_instant", value="true"))
    session.commit()
    bob = _make_user(session, "bob@example.com", "bob")
    a1 = _make_user(session, "a1@example.com", "a1")
    _make_event(session, "ev-going")
    n = _notif(
        session, recipient=bob, actor=a1, kind="subscription_going", event_id="ev-going"
    )

    stats = activity_email.deliver_immediate({bob.id})

    assert stats["instant_emails"] == 1
    assert emails == [(bob.id, "friends_going")]
    session.refresh(n)
    assert n.instant_emailed_at is not None
    assert n.emailed_at is None
    [delivery] = _deliveries(session, n.id, "email")
    assert (delivery.mode, delivery.source) == ("instant", "job")

    assert activity_email.deliver_immediate({bob.id}).get("instant_emails", 0) == 0
    assert len(emails) == 1


def test_deliver_immediate_never_sends_digest_email(session, monkeypatch):
    """Default digest mode: the job pushes but leaves the email for the
    digest slot, even when the recipient is due."""
    emails = _patch_digest_senders(monkeypatch)
    pushes: list = []
    monkeypatch.setattr(
        activity_email, "send_push", lambda rid, **k: pushes.append(rid) or 1
    )
    bob = _make_user(session, "bob@example.com", "bob")
    a1 = _make_user(session, "a1@example.com", "a1")
    n = _notif(session, recipient=bob, actor=a1, kind="new_follower")

    activity_email.deliver_immediate({bob.id})

    assert emails == []
    assert pushes == [bob.id]
    session.refresh(n)
    assert n.emailed_at is None and n.instant_emailed_at is None
    assert n.pushed_at is not None
    [delivery] = _deliveries(session, n.id, "push")
    assert (delivery.mode, delivery.source) == (None, "job")


def test_deliver_immediate_skips_withdrawn_anon_review(session, monkeypatch):
    emails = _patch_digest_senders(monkeypatch)
    monkeypatch.setattr(activity_email, "send_push", lambda *a, **k: 1)
    session.add(SiteSetting(key="friend_reviews_email_instant", value="true"))
    session.commit()
    bob = _make_user(session, "bob@example.com", "bob")
    alice = _make_user(session, "alice@example.com", "alice")
    _make_event(session, "ev-withdrawn-review")
    n = _notif(
        session,
        recipient=bob,
        actor=alice,
        kind="subscription_review",
        event_id="ev-withdrawn-review",
    )
    n.context = "anon"
    session.add(n)
    session.commit()

    activity_email.deliver_immediate({bob.id})

    assert emails == []
    session.refresh(n)
    assert n.instant_emailed_at is None


def test_deliver_immediate_ignores_scan_only_kinds(session, monkeypatch):
    """interest_event rows are scan-created and stay with the tick (and its
    interest push schedule) even when interest matches are instant."""
    emails = _patch_digest_senders(monkeypatch)
    pushes: list = []
    monkeypatch.setattr(
        activity_email, "send_push", lambda rid, **k: pushes.append(rid) or 1
    )
    session.add(SiteSetting(key="interest_matches_email_instant", value="true"))
    session.commit()
    bob = _make_user(session, "bob@example.com", "bob")
    _make_event(session, "ev-match")
    n = _notif(
        session, recipient=bob, actor=bob, kind="interest_event", event_id="ev-match"
    )

    stats = activity_email.deliver_immediate({bob.id})

    assert stats == {"digests": 0, "pushed": 0}
    assert emails == [] and pushes == []
    session.refresh(n)
    assert n.instant_emailed_at is None and n.pushed_at is None


def test_deliver_immediate_retries_transient_push_failure(session, monkeypatch):
    emails = _patch_digest_senders(monkeypatch)

    def failing_push(*a, raise_on_transient=False, **k):
        assert raise_on_transient
        raise push_service.PushTransientError("503")

    monkeypatch.setattr(activity_email, "send_push", failing_push)
    bob = _make_user(session, "bob@example.com", "bob")
    a1 = _make_user(session, "a1@example.com", "a1")
    n = _notif(session, recipient=bob, actor=a1, kind="new_follower")

    stats = activity_email.deliver_immediate({bob.id})
    assert stats["push_retry"] == 1
    session.refresh(n)
    assert n.pushed_at is None  # left pending for the retry / sweep

    monkeypatch.setattr(activity_email, "send_push", lambda *a, **k: 1)
    stats = activity_email.deliver_immediate({bob.id})
    assert stats["pushed"] == 1 and stats["push_retry"] == 0
    session.refresh(n)
    assert n.pushed_at is not None
    assert n.emailed_at is None and n.instant_emailed_at is None
    assert emails == []


def test_tick_after_job_sends_nothing_twice(session, monkeypatch):
    emails = _patch_digest_senders(monkeypatch)
    pushes: list = []
    monkeypatch.setattr(
        activity_email, "send_push", lambda rid, **k: pushes.append(rid) or 1
    )
    session.add(SiteSetting(key="social_activity_email_instant", value="true"))
    session.commit()
    bob = _make_user(session, "bob@example.com", "bob")
    a1 = _make_user(session, "a1@example.com", "a1")
    _notif(session, recipient=bob, actor=a1, kind="new_follower")

    activity_email.deliver_immediate({bob.id})
    activity_email.run_once()
    activity_email.run_once(force=True)

    assert pushes == [bob.id]
    assert emails == [(bob.id, "social_activity")]


def test_tick_sweeps_fresh_rows_the_job_missed(session, monkeypatch):
    """No age cutoff: a fresh row the job never handled (e.g. lost on
    restart) is delivered by the next tick and audited as tick."""
    _patch_digest_senders(monkeypatch)
    pushes: list = []
    monkeypatch.setattr(
        activity_email, "send_push", lambda rid, **k: pushes.append(rid) or 1
    )
    bob = _make_user(session, "bob@example.com", "bob")
    a1 = _make_user(session, "a1@example.com", "a1")
    n = _notif(session, recipient=bob, actor=a1, kind="new_follower")

    stats = activity_email.run_once()

    assert pushes == [bob.id]
    assert stats["fast_pushed"] == 1
    [delivery] = _deliveries(session, n.id, "push")
    assert delivery.source == "tick"


def test_pending_rows_are_claimed_with_skip_locked(session, monkeypatch):
    """Job and tick claim the rows they deliver, so concurrent runs on
    Postgres skip each other's rows instead of double-sending."""
    from sqlalchemy import event as sa_event
    from sqlalchemy.dialects import postgresql
    from sqlalchemy.orm import Session as OrmSession

    from backend.services import event_message_instant

    _patch_digest_senders(monkeypatch)
    monkeypatch.setattr(activity_email, "send_push", lambda *a, **k: 1)
    session.add(SiteSetting(key="event_messages_email_instant", value="true"))
    session.commit()
    bob = _make_user(session, "bob@example.com", "bob")
    a1 = _make_user(session, "a1@example.com", "a1")
    _notif(session, recipient=bob, actor=a1, kind="new_follower")

    captured: list = []

    def _on_execute(state):
        if getattr(state.statement, "_for_update_arg", None) is not None:
            captured.append(str(state.statement.compile(dialect=postgresql.dialect())))

    sa_event.listen(OrmSession, "do_orm_execute", _on_execute)
    try:
        activity_email.deliver_immediate({bob.id})
        event_message_instant.deliver_for_recipient(session, bob.id)
    finally:
        sa_event.remove(OrmSession, "do_orm_execute", _on_execute)

    assert len(captured) == 2
    assert all("FOR UPDATE OF notifications SKIP LOCKED" in sql for sql in captured)


# --- Post-request push jobs ---------------------------------------------------


def _fake_pywebpush(monkeypatch, status: int):
    import sys
    import types

    class FakeWebPushException(Exception):
        def __init__(self, msg, response=None):
            super().__init__(msg)
            self.response = response

    class _Resp:
        status_code = status

    def fake_webpush(**kwargs):
        raise FakeWebPushException("failed", response=_Resp())

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


@pytest.mark.parametrize("status,transient", [(503, True), (429, True), (410, False)])
def test_send_push_flags_only_transient_failures(
    session, monkeypatch, status, transient
):
    _fake_pywebpush(monkeypatch, status)
    alice = _make_user(session, "alice@example.com", "alice")
    session.add(
        PushSubscription(
            user_id=alice.id, endpoint="https://push/x", p256dh="a", auth="b"
        )
    )
    session.commit()

    if transient:
        with pytest.raises(push_service.PushTransientError):
            push_service.send_push(alice.id, "T", "B", raise_on_transient=True)
    else:
        assert push_service.send_push(alice.id, "T", "B", raise_on_transient=True) == 0


def _record_enqueues(monkeypatch) -> list:
    from backend.services import job_queue, push_jobs

    push_jobs.install()
    calls: list = []
    monkeypatch.setattr(job_queue, "enqueue", lambda *a: calls.append(a))
    return calls


def test_committed_request_notification_enqueues_debounced_deliver_job(
    session, monkeypatch
):
    from backend.services import push_jobs

    monkeypatch.setenv("NOTIFICATION_DEBOUNCE_SECONDS", "7")
    calls = _record_enqueues(monkeypatch)
    bob = _make_user(session, "bob@example.com", "bob")
    a1 = _make_user(session, "a1@example.com", "a1")

    _notif(session, recipient=bob, actor=a1, kind="interest_event")
    assert calls == []  # not a request-created kind
    _notif(session, recipient=bob, actor=a1, kind="new_follower")
    assert calls == [(push_jobs.DELIVER_JOB, str(bob.id), 7.0)]


def test_rolled_back_notification_enqueues_nothing(session, monkeypatch):
    calls = _record_enqueues(monkeypatch)
    bob = _make_user(session, "bob@example.com", "bob")
    a1 = _make_user(session, "a1@example.com", "a1")

    session.add(
        Notification(recipient_user_id=bob.id, actor_user_id=a1.id, kind="new_friend")
    )
    session.flush()
    session.rollback()
    session.add(SiteSetting(key="unrelated", value="1"))
    session.commit()

    assert calls == []


def test_realerted_notification_enqueues_but_read_does_not(session, monkeypatch):
    """Updated rows re-enter delivery only when pushed_at is reset (e.g. a
    plan re-alert), not on unrelated updates such as marking read."""
    calls = _record_enqueues(monkeypatch)
    bob = _make_user(session, "bob@example.com", "bob")
    a1 = _make_user(session, "a1@example.com", "a1")
    n = _notif(session, recipient=bob, actor=a1, kind="plan_session_added")
    n.pushed_at = datetime.now(timezone.utc)
    session.add(n)
    session.commit()
    calls.clear()

    n.read_at = datetime.now(timezone.utc)
    session.add(n)
    session.commit()
    assert calls == []

    n.pushed_at = None
    session.add(n)
    session.commit()
    assert [c[1] for c in calls] == [str(bob.id)]


_EM_EMPTY = {"emails": 0, "pushes": 0, "push_retry": 0}


def test_follow_route_queues_delivery_instead_of_sending_inline(
    client, session, monkeypatch
):
    """Request handlers never call email/push providers: following someone
    with social_activity in instant mode only queues the recipient's job."""
    from backend.services import push_jobs

    calls = _record_enqueues(monkeypatch)
    emails = _patch_digest_senders(monkeypatch)
    pushes: list = []
    monkeypatch.setattr(
        activity_email, "send_push", lambda rid, **k: pushes.append(rid) or 1
    )
    session.add(SiteSetting(key="social_activity_email_instant", value="true"))
    session.commit()
    bob = _make_user(session, "bob@example.com", "bob")
    _login(client, "alice@example.com")

    r = client.post("/api/social/users/bob/follow")

    assert r.status_code in (200, 201), r.text
    assert emails == [] and pushes == []
    assert (push_jobs.DELIVER_JOB, str(bob.id)) in [c[:2] for c in calls]

    push_jobs.deliver_for_recipient(str(bob.id))
    assert emails == [(bob.id, "social_activity")]
    assert pushes == [bob.id]


@pytest.mark.parametrize(
    "em_retry,activity_retry,raises,expected_order",
    [
        (0, 0, False, ["event_messages", "activity"]),
        (0, 1, True, ["event_messages", "activity"]),
        (1, 0, True, ["event_messages"]),
    ],
)
def test_deliver_job_order_and_retry(
    engine, monkeypatch, em_retry, activity_retry, raises, expected_order
):
    import uuid

    from backend.services import job_queue, push_jobs

    order: list = []
    monkeypatch.setattr(
        push_jobs.event_message_instant,
        "deliver_for_recipient",
        lambda session, rid: (
            order.append("event_messages") or {**_EM_EMPTY, "push_retry": em_retry}
        ),
    )
    monkeypatch.setattr(
        push_jobs.activity_email,
        "deliver_immediate",
        lambda user_ids, source: (
            order.append("activity") or {"push_retry": activity_retry, "source": source}
        ),
    )

    if raises:
        with pytest.raises(job_queue.RetryLater):
            push_jobs.deliver_for_recipient(str(uuid.uuid4()))
    else:
        push_jobs.deliver_for_recipient(str(uuid.uuid4()))
    assert order == expected_order


def _instant_event_message(session, monkeypatch):
    from backend.services import event_message_instant as em_instant

    session.add(SiteSetting(key="event_messages_email_instant", value="true"))
    session.commit()
    bob = _make_user(session, "bob@example.com", "bob")
    alice = _make_user(session, "alice@example.com", "alice")
    _make_event(session, "ev-board", title="Board Night")
    n = _notif(
        session, recipient=bob, actor=alice, kind="event_message", event_id="ev-board"
    )
    n.context = "question"
    session.add(n)
    session.commit()
    rich_emails: list = []
    monkeypatch.setattr(
        em_instant,
        "send_event_message_instant_email",
        lambda user, actor, *a, **k: rich_emails.append(user.id) or True,
    )
    monkeypatch.setattr(em_instant, "webpush_configured", lambda: True)
    return bob, n, rich_emails


def test_deliver_job_rich_event_message_not_duplicated_by_generic_pass(
    session, monkeypatch
):
    from backend.services import event_message_instant as em_instant
    from backend.services import push_jobs

    generic_emails = _patch_digest_senders(monkeypatch)
    generic_pushes: list = []
    monkeypatch.setattr(
        activity_email, "send_push", lambda rid, **k: generic_pushes.append(rid) or 1
    )
    bob, n, rich_emails = _instant_event_message(session, monkeypatch)
    rich_pushes: list = []
    monkeypatch.setattr(
        em_instant, "send_push", lambda rid, **k: rich_pushes.append(k) or 1
    )

    push_jobs.deliver_for_recipient(str(bob.id))

    assert rich_emails == [bob.id]
    assert len(rich_pushes) == 1
    assert rich_pushes[0]["title"] == "Alice asked a question about Board Night"
    assert rich_pushes[0]["url"] == f"/event/ev-board?via=push&nid={n.id}#messages"
    assert rich_pushes[0]["topic"] == "event-messages-ev-board"
    assert generic_emails == [] and generic_pushes == []
    session.refresh(n)
    assert n.instant_emailed_at is not None and n.pushed_at is not None


def test_deliver_job_retries_transient_rich_push_without_generic_fallback(
    session, monkeypatch
):
    from backend.services import event_message_instant as em_instant
    from backend.services import job_queue, push_jobs

    _patch_digest_senders(monkeypatch)
    generic_pushes: list = []
    monkeypatch.setattr(
        activity_email, "send_push", lambda rid, **k: generic_pushes.append(rid) or 1
    )
    bob, n, rich_emails = _instant_event_message(session, monkeypatch)

    def failing_push(*a, raise_on_transient=False, **k):
        assert raise_on_transient
        raise push_service.PushTransientError("503")

    monkeypatch.setattr(em_instant, "send_push", failing_push)

    with pytest.raises(job_queue.RetryLater):
        push_jobs.deliver_for_recipient(str(bob.id))

    assert rich_emails == [bob.id]  # email already delivered and stamped
    assert generic_pushes == []
    session.refresh(n)
    assert n.instant_emailed_at is not None
    assert n.pushed_at is None


def test_event_message_instant_noop_when_toggle_off_or_event_not_user_facing(
    session, monkeypatch
):
    import uuid

    from backend.services import event_message_instant as em_instant

    bob, n, rich_emails = _instant_event_message(session, monkeypatch)
    monkeypatch.setattr(em_instant, "send_push", lambda *a, **k: 1)

    event = session.get(CachedEvent, "ev-board")
    event.review_status = "pending"
    event.suggestion_id = uuid.uuid4()
    session.add(event)
    session.commit()
    assert em_instant.deliver_for_recipient(session, bob.id) == _EM_EMPTY

    event.review_status = "reviewed"
    session.add(event)
    session.get(SiteSetting, "event_messages_email_instant").value = "false"
    session.commit()
    assert em_instant.deliver_for_recipient(session, bob.id) == _EM_EMPTY
    assert rich_emails == []
    session.refresh(n)
    assert n.instant_emailed_at is None and n.pushed_at is None


@pytest.mark.asyncio
async def test_in_process_job_queue_coalesces_and_retries():
    import asyncio

    from backend.services import job_queue

    queue = job_queue.InProcessJobQueue()
    queue.retry_base_seconds = 0
    runs: list = []

    def handler(key):
        runs.append(key)
        if len(runs) == 1:
            raise job_queue.RetryLater()

    job_queue.register("test-job", handler)
    queue.start()
    queue.enqueue("test-job", "k", 0.05)
    queue.enqueue("test-job", "k", 0.05)  # coalesced with the first
    await asyncio.sleep(0.5)
    await queue.stop()

    assert runs == ["k", "k"]  # one run + one retry


@pytest.mark.asyncio
async def test_in_process_job_queue_waits_for_debounce_delay():
    import asyncio

    from backend.services import job_queue

    queue = job_queue.InProcessJobQueue()
    runs: list = []
    job_queue.register("test-delay", runs.append)
    queue.start()
    queue.enqueue("test-delay", "k", 0.3)
    await asyncio.sleep(0.1)
    assert runs == []
    await asyncio.sleep(0.4)
    assert runs == ["k"]
    # Released before running: a new enqueue gets its own pass.
    queue.enqueue("test-delay", "k", 0)
    await asyncio.sleep(0.1)
    await queue.stop()
    assert runs == ["k", "k"]


@pytest.mark.asyncio
async def test_in_process_job_queue_gives_up_after_max_attempts(caplog):
    import asyncio
    import logging

    from backend.services import job_queue

    queue = job_queue.InProcessJobQueue()
    queue.max_attempts = 3
    queue.retry_base_seconds = 0
    runs: list = []

    def handler(key):
        runs.append(key)
        raise job_queue.RetryLater()

    job_queue.register("test-giveup", handler)
    queue.start()
    with caplog.at_level(logging.INFO, logger="backend.services.job_queue"):
        queue.enqueue("test-giveup", "k", 0)
        await asyncio.sleep(0.3)
    await queue.stop()

    assert runs == ["k", "k", "k"]
    assert sum("asked to retry" in r.message for r in caplog.records) == 2
    assert any("gave up after 3 attempts" in r.message for r in caplog.records)


@pytest.mark.asyncio
async def test_in_process_job_queue_does_not_retry_unexpected_errors(caplog):
    import asyncio

    from backend.services import job_queue

    queue = job_queue.InProcessJobQueue()
    queue.retry_base_seconds = 0
    runs: list = []

    def handler(key):
        runs.append(key)
        raise ValueError("boom")

    job_queue.register("test-error", handler)
    queue.start()
    queue.enqueue("test-error", "k", 0)
    await asyncio.sleep(0.2)
    await queue.stop()

    assert runs == ["k"]
    assert any("Job test-error:k failed" in r.message for r in caplog.records)


@pytest.mark.asyncio
async def test_in_process_job_queue_stop_cancels_pending_and_inactive_is_noop():
    import asyncio

    from backend.services import job_queue

    queue = job_queue.InProcessJobQueue()
    runs: list = []
    job_queue.register("test-stop", runs.append)

    queue.enqueue("test-stop", "before-start", 0)  # not started: dropped
    queue.start()
    queue.enqueue("test-stop", "k", 10)
    await asyncio.sleep(0.05)
    await queue.stop()
    assert not queue.active
    queue.enqueue("test-stop", "after-stop", 0)
    await asyncio.sleep(0.05)

    assert runs == []
