"""Tests for the Phase C notification feed.

Covers:
  - subscription_going fan-out at the attendance write path
  - subscription_suggested fan-out on admin approval
  - dedupe (unique constraint) on re-trigger
  - visibility revoke at emit time (target tightens calendar visibility)
  - notify_new_events=false suppresses fan-out
  - GET /api/notifications listing + filters + pagination
  - mark single read, mark all, unread-count
  - 404 (not 403) for cross-user notification access
  - GET /api/social/me/subscribed-events aggregation + from_handle filter
"""

import os
from datetime import datetime, timedelta
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

os.environ.setdefault("SESSION_SECRET", "test-secret-notifs")
os.environ.setdefault("ADMIN_EMAIL", "admin@example.com")
os.environ["DEV_AUTH"] = "true"

from backend.api.main import app  # noqa: E402
from backend.api.routes import auth as auth_module  # noqa: E402
from backend.api.routes import social as social_module  # noqa: E402
from backend.api.routes import suggestions as suggestions_module  # noqa: E402
from backend.api.routes import tracking as tracking_module  # noqa: E402
from backend.db.database import get_session  # noqa: E402
from backend.db.models import (  # noqa: E402
    CachedEvent,
    CalendarSetting,
    CalendarSubscription,
    EventSuggestion,
    Notification,
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
    suggestions_module.limiter.reset()
    tracking_module.limiter.reset()
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


def _logout(client: TestClient) -> None:
    client.post("/api/auth/logout")


def _make_user(
    session: Session,
    email: str,
    handle: str,
    *,
    visibility_calendar: str = "public",
) -> User:
    # Maps the legacy ``visibility_calendar`` kwarg onto the single
    # post-refactor ``account_visibility`` field (``private`` → ``friends``).
    if visibility_calendar == "private":
        account_visibility = "friends"
    elif visibility_calendar in {"public", "friends"}:
        account_visibility = visibility_calendar
    else:
        account_visibility = "public"
    u = User(
        email=email,
        display_name=handle.title(),
        handle=handle,
        provider="google",
        provider_subject=f"mock|{email}",
        account_visibility=account_visibility,
    )
    session.add(u)
    session.commit()
    session.refresh(u)
    return u


def _make_calendar(session: Session, cal_id: str = "cal-test") -> CalendarSetting:
    c = CalendarSetting(calendar_id=cal_id, name="Test", color="#abc", enabled=True)
    session.add(c)
    session.commit()
    session.refresh(c)
    return c


def _make_event(
    session: Session,
    event_id: str,
    cal_id: str = "cal-test",
    title: str = "Salsa Night",
) -> CachedEvent:
    e = CachedEvent(
        event_id=event_id,
        calendar_id=cal_id,
        title=title,
        start=datetime.utcnow() + timedelta(days=1),
        end=datetime.utcnow() + timedelta(days=1, hours=2),
        all_day=False,
    )
    session.add(e)
    session.commit()
    session.refresh(e)
    return e


def _subscribe(
    session: Session,
    subscriber: User,
    target: User,
    *,
    notify: bool = True,
) -> CalendarSubscription:
    sub = CalendarSubscription(
        subscriber_id=subscriber.id,
        target_user_id=target.id,
        notify_new_events=notify,
    )
    session.add(sub)
    session.commit()
    session.refresh(sub)
    return sub


def _count_notifs(session: Session, recipient: User) -> int:
    return len(
        session.exec(
            select(Notification).where(Notification.recipient_user_id == recipient.id)
        ).all()
    )


# --- Going fan-out ----------------------------------------------------------


def test_going_with_share_publicly_fans_out_to_subscribers(client, session):
    _make_calendar(session)
    _make_event(session, "ev-1")
    alice = _make_user(session, "alice@example.com", "alice")
    bob = _make_user(session, "bob@example.com", "bob")
    _subscribe(session, bob, alice)

    _login(client, "alice@example.com")
    r = client.post(
        "/api/track/event-attendance",
        json={
            "event_id": "ev-1",
            "device_id": "dev-alice",
            "action": "going",
            "share_publicly": True,
        },
    )
    assert r.status_code == 201, r.text

    # Bob should have one notification.
    notifs = session.exec(
        select(Notification).where(Notification.recipient_user_id == bob.id)
    ).all()
    assert len(notifs) == 1
    assert notifs[0].kind == "subscription_going"
    assert notifs[0].event_id == "ev-1"
    assert notifs[0].actor_user_id == alice.id
    assert notifs[0].read_at is None


def test_going_without_share_publicly_does_not_fan_out(client, session):
    _make_calendar(session)
    _make_event(session, "ev-1")
    alice = _make_user(session, "alice@example.com", "alice")
    bob = _make_user(session, "bob@example.com", "bob")
    _subscribe(session, bob, alice)

    _login(client, "alice@example.com")
    r = client.post(
        "/api/track/event-attendance",
        json={
            "event_id": "ev-1",
            "device_id": "dev-alice",
            "action": "going",
            "share_publicly": False,
        },
    )
    assert r.status_code == 201
    assert _count_notifs(session, bob) == 0


def test_anonymous_going_does_not_fan_out(client, session):
    _make_calendar(session)
    _make_event(session, "ev-1")
    alice = _make_user(session, "alice@example.com", "alice")
    bob = _make_user(session, "bob@example.com", "bob")
    _subscribe(session, bob, alice)

    # No login. Anonymous Going can't tie to alice's subscribers.
    r = client.post(
        "/api/track/event-attendance",
        json={
            "event_id": "ev-1",
            "device_id": "anon-dev",
            "action": "going",
        },
    )
    assert r.status_code == 201
    assert _count_notifs(session, bob) == 0


def test_going_repeat_is_idempotent(client, session):
    _make_calendar(session)
    _make_event(session, "ev-1")
    alice = _make_user(session, "alice@example.com", "alice")
    bob = _make_user(session, "bob@example.com", "bob")
    _subscribe(session, bob, alice)

    _login(client, "alice@example.com")
    payload = {
        "event_id": "ev-1",
        "device_id": "dev-alice",
        "action": "going",
        "share_publicly": True,
    }
    client.post("/api/track/event-attendance", json=payload)
    # Flip off then on — only one notification should exist (dedupe).
    client.post(
        "/api/track/event-attendance",
        json={**payload, "share_publicly": False},
    )
    client.post("/api/track/event-attendance", json=payload)

    assert _count_notifs(session, bob) == 1


def test_notify_new_events_false_suppresses_fan_out(client, session):
    _make_calendar(session)
    _make_event(session, "ev-1")
    alice = _make_user(session, "alice@example.com", "alice")
    bob = _make_user(session, "bob@example.com", "bob")
    _subscribe(session, bob, alice, notify=False)

    _login(client, "alice@example.com")
    client.post(
        "/api/track/event-attendance",
        json={
            "event_id": "ev-1",
            "device_id": "dev-alice",
            "action": "going",
            "share_publicly": True,
        },
    )
    assert _count_notifs(session, bob) == 0


def test_revoked_visibility_blocks_fan_out_at_emit_time(client, session):
    _make_calendar(session)
    _make_event(session, "ev-1")
    # Alice subscribed-to while public, then tightens to friends without bob being a mutual.
    alice = _make_user(
        session, "alice@example.com", "alice", visibility_calendar="public"
    )
    bob = _make_user(session, "bob@example.com", "bob")
    _subscribe(session, bob, alice)
    alice.account_visibility = "friends"
    session.add(alice)
    session.commit()

    _login(client, "alice@example.com")
    client.post(
        "/api/track/event-attendance",
        json={
            "event_id": "ev-1",
            "device_id": "dev-alice",
            "action": "going",
            "share_publicly": True,
        },
    )
    assert _count_notifs(session, bob) == 0


# --- Suggested fan-out ------------------------------------------------------


def test_suggested_fan_out_on_admin_approval(client, session):
    _make_calendar(session)
    alice = _make_user(session, "alice@example.com", "alice")
    bob = _make_user(session, "bob@example.com", "bob")
    _subscribe(session, bob, alice)

    _login(client, "alice@example.com")
    submit = client.post(
        "/api/suggestions",
        json={
            "title": "Suggested Salsa",
            "start": (datetime.utcnow() + timedelta(days=2)).isoformat(),
            "end": (datetime.utcnow() + timedelta(days=2, hours=2)).isoformat(),
            "all_day": False,
        },
    )
    assert submit.status_code == 201, submit.text
    sug_id = submit.json()["id"]

    # Confirm submitter_user_id was captured.
    sug = session.exec(
        select(EventSuggestion).where(EventSuggestion.id == UUID(sug_id))
    ).one()
    assert sug.submitter_user_id == alice.id

    # No fan-out yet (still pending).
    assert _count_notifs(session, bob) == 0

    # Admin approves.
    _logout(client)
    _login(client, "admin@example.com")
    approve = client.post(
        f"/api/admin/suggestions/{sug_id}/approve",
        json={"calendar_id": "cal-test"},
    )
    assert approve.status_code == 200, approve.text
    created_event_id = approve.json()["created_event_id"]

    notifs = session.exec(
        select(Notification).where(Notification.recipient_user_id == bob.id)
    ).all()
    assert len(notifs) == 1
    assert notifs[0].kind == "subscription_suggested"
    assert notifs[0].event_id == created_event_id
    assert notifs[0].actor_user_id == alice.id


def test_anonymous_suggestion_no_fan_out(client, session):
    _make_calendar(session)
    alice = _make_user(session, "alice@example.com", "alice")
    bob = _make_user(session, "bob@example.com", "bob")
    _subscribe(session, bob, alice)

    # No login -> anonymous submission.
    submit = client.post(
        "/api/suggestions",
        json={
            "title": "Anon Salsa",
            "start": (datetime.utcnow() + timedelta(days=2)).isoformat(),
            "end": (datetime.utcnow() + timedelta(days=2, hours=2)).isoformat(),
            "all_day": False,
        },
    )
    assert submit.status_code == 201
    sug_id = submit.json()["id"]

    _login(client, "admin@example.com")
    client.post(
        f"/api/admin/suggestions/{sug_id}/approve",
        json={"calendar_id": "cal-test"},
    )
    assert _count_notifs(session, bob) == 0


# --- /api/notifications endpoints -------------------------------------------


def test_list_requires_auth(client, session):
    r = client.get("/api/notifications")
    assert r.status_code == 401


def _seed_one_notif(
    session: Session,
    recipient: User,
    actor: User,
    *,
    kind: str = "subscription_going",
    event_id: str = "ev-1",
) -> Notification:
    n = Notification(
        recipient_user_id=recipient.id,
        actor_user_id=actor.id,
        kind=kind,
        event_id=event_id,
    )
    session.add(n)
    session.commit()
    session.refresh(n)
    return n


def test_list_returns_only_own_notifications(client, session):
    _make_calendar(session)
    _make_event(session, "ev-1")
    alice = _make_user(session, "alice@example.com", "alice")
    bob = _make_user(session, "bob@example.com", "bob")
    carol = _make_user(session, "carol@example.com", "carol")
    _seed_one_notif(session, bob, alice)
    _seed_one_notif(session, carol, alice, event_id="ev-1")

    _login(client, "bob@example.com")
    r = client.get("/api/notifications")
    assert r.status_code == 200
    data = r.json()
    assert data["total"] == 1
    assert data["unread_count"] == 1
    assert len(data["items"]) == 1
    item = data["items"][0]
    assert item["kind"] == "subscription_going"
    assert item["actor"]["handle"] == "alice"
    assert item["event_title"] == "Salsa Night"
    assert item["created_at"].endswith("Z")


def test_filter_by_kind(client, session):
    _make_calendar(session)
    _make_event(session, "ev-1")
    _make_event(session, "ev-2", title="Other")
    alice = _make_user(session, "alice@example.com", "alice")
    bob = _make_user(session, "bob@example.com", "bob")
    _seed_one_notif(session, bob, alice, kind="subscription_going", event_id="ev-1")
    _seed_one_notif(session, bob, alice, kind="subscription_suggested", event_id="ev-2")

    _login(client, "bob@example.com")
    r = client.get("/api/notifications?kind=subscription_suggested")
    assert r.status_code == 200
    data = r.json()
    assert data["total"] == 1
    assert data["items"][0]["kind"] == "subscription_suggested"


def test_unread_count(client, session):
    _make_calendar(session)
    _make_event(session, "ev-1")
    alice = _make_user(session, "alice@example.com", "alice")
    bob = _make_user(session, "bob@example.com", "bob")
    n1 = _seed_one_notif(session, bob, alice, event_id="ev-1")
    n1.read_at = datetime.utcnow()
    session.add(n1)
    _seed_one_notif(session, bob, alice, kind="subscription_suggested", event_id="ev-1")
    session.commit()

    _login(client, "bob@example.com")
    r = client.get("/api/notifications/unread-count")
    assert r.status_code == 200
    assert r.json() == {"count": 1}


def test_mark_read_single(client, session):
    _make_calendar(session)
    _make_event(session, "ev-1")
    alice = _make_user(session, "alice@example.com", "alice")
    bob = _make_user(session, "bob@example.com", "bob")
    n = _seed_one_notif(session, bob, alice)

    _login(client, "bob@example.com")
    r = client.post(f"/api/notifications/{n.id}/read")
    assert r.status_code == 200
    assert r.json()["read_at"] is not None
    assert r.json()["read_at"].endswith("Z")

    session.expire_all()
    refreshed = session.get(Notification, n.id)
    assert refreshed.read_at is not None


def test_mark_read_other_users_returns_404(client, session):
    _make_calendar(session)
    _make_event(session, "ev-1")
    alice = _make_user(session, "alice@example.com", "alice")
    bob = _make_user(session, "bob@example.com", "bob")
    carol = _make_user(session, "carol@example.com", "carol")
    n = _seed_one_notif(session, bob, alice)  # bob's notif

    _login(client, "carol@example.com")
    r = client.post(f"/api/notifications/{n.id}/read")
    assert r.status_code == 404


def test_mark_all_read(client, session):
    _make_calendar(session)
    _make_event(session, "ev-1")
    alice = _make_user(session, "alice@example.com", "alice")
    bob = _make_user(session, "bob@example.com", "bob")
    _seed_one_notif(session, bob, alice, event_id="ev-1")
    _seed_one_notif(session, bob, alice, kind="subscription_suggested", event_id="ev-1")

    _login(client, "bob@example.com")
    r = client.post("/api/notifications/read-all")
    assert r.status_code == 200
    assert r.json()["count"] == 0

    remaining_unread = session.exec(
        select(Notification)
        .where(Notification.recipient_user_id == bob.id)
        .where(Notification.read_at.is_(None))
    ).all()
    assert remaining_unread == []


# --- /api/social/me/subscribed-events ---------------------------------------


def test_subscribed_events_aggregation(client, session):
    _make_calendar(session)
    _make_event(session, "ev-1", title="Going Event")
    _make_event(session, "ev-2", title="Suggested Event")
    alice = _make_user(session, "alice@example.com", "alice")
    bob = _make_user(session, "bob@example.com", "bob")
    _subscribe(session, bob, alice)

    # Going via Alice
    session.add(
        UserEventAttendance(
            device_id="d-alice",
            event_id="ev-1",
            user_id=alice.id,
            share_publicly=True,
        )
    )
    # Suggested by Alice (approved)
    session.add(
        EventSuggestion(
            title="Suggested Event",
            start=datetime.utcnow() + timedelta(days=3),
            end=datetime.utcnow() + timedelta(days=3, hours=2),
            submitter_user_id=alice.id,
            status="approved",
            created_event_id="ev-2",
        )
    )
    session.commit()

    _login(client, "bob@example.com")
    r = client.get("/api/social/me/subscribed-events")
    assert r.status_code == 200
    data = r.json()
    assert data["total"] == 2
    by_id = {item["event_id"]: item for item in data["items"]}
    assert "ev-1" in by_id and "ev-2" in by_id
    assert by_id["ev-1"]["via"][0]["kind"] == "subscription_going"
    assert by_id["ev-1"]["via"][0]["actor"]["handle"] == "alice"
    assert by_id["ev-2"]["via"][0]["kind"] == "subscription_suggested"


def test_subscribed_events_from_handle_filter(client, session):
    _make_calendar(session)
    _make_event(session, "ev-1")
    _make_event(session, "ev-2")
    alice = _make_user(session, "alice@example.com", "alice")
    carol = _make_user(session, "carol@example.com", "carol")
    bob = _make_user(session, "bob@example.com", "bob")
    _subscribe(session, bob, alice)
    _subscribe(session, bob, carol)

    session.add(
        UserEventAttendance(
            device_id="da", event_id="ev-1", user_id=alice.id, share_publicly=True
        )
    )
    session.add(
        UserEventAttendance(
            device_id="dc", event_id="ev-2", user_id=carol.id, share_publicly=True
        )
    )
    session.commit()

    _login(client, "bob@example.com")
    r = client.get("/api/social/me/subscribed-events?from_handle=alice")
    assert r.status_code == 200
    items = r.json()["items"]
    assert len(items) == 1
    assert items[0]["event_id"] == "ev-1"


def test_subscribed_events_multi_handle_kind_and_upcoming_filters(client, session):
    _make_calendar(session)
    _make_event(session, "ev-going", title="Going Event")
    _make_event(session, "ev-saved", title="Saved Event")
    past = _make_event(session, "ev-past", title="Past Event")
    past.start = datetime.utcnow() - timedelta(days=2)
    past.end = datetime.utcnow() - timedelta(days=1)
    session.add(past)

    alice = _make_user(session, "alice@example.com", "alice")
    carol = _make_user(session, "carol@example.com", "carol")
    bob = _make_user(session, "bob@example.com", "bob")
    _subscribe(session, bob, alice)
    _subscribe(session, bob, carol)

    session.add(
        UserEventAttendance(
            device_id="da-going",
            event_id="ev-going",
            user_id=alice.id,
            share_audience="public",
            share_publicly=True,
        )
    )
    session.add(
        UserEventAttendance(
            device_id="da-past",
            event_id="ev-past",
            user_id=alice.id,
            share_audience="public",
            share_publicly=True,
        )
    )
    session.add(
        UserSavedEvent(
            device_id="dc-saved",
            event_id="ev-saved",
            user_id=carol.id,
            audience="public",
        )
    )
    session.commit()

    _login(client, "bob@example.com")
    r = client.get(
        "/api/social/me/subscribed-events?from_handles=alice,carol&kind=saved"
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["total"] == 1
    assert data["items"][0]["event_id"] == "ev-saved"
    assert data["items"][0]["via"][0]["kind"] == "subscription_saved"
    assert "tags" in data["items"][0]
    assert "view_count" in data["items"][0]

    r = client.get("/api/social/me/subscribed-events?from_handles=alice&kind=going")
    assert r.status_code == 200, r.text
    event_ids = [item["event_id"] for item in r.json()["items"]]
    assert event_ids == ["ev-going"]
    assert "ev-past" not in event_ids


def test_subscribed_events_unknown_handle_returns_empty(client, session):
    _make_calendar(session)
    alice = _make_user(session, "alice@example.com", "alice")
    bob = _make_user(session, "bob@example.com", "bob")
    _subscribe(session, bob, alice)

    _login(client, "bob@example.com")
    r = client.get("/api/social/me/subscribed-events?from_handle=nobody")
    assert r.status_code == 200
    assert r.json()["total"] == 0


def test_subscribed_events_empty_when_no_subscriptions(client, session):
    _make_user(session, "bob@example.com", "bob")
    _login(client, "bob@example.com")
    r = client.get("/api/social/me/subscribed-events")
    assert r.status_code == 200
    assert r.json() == {"items": [], "total": 0, "limit": 50, "offset": 0}


# --- Follow / friend notifications ------------------------------------------


def test_follow_creates_new_follower_notification(client, session):
    """Following a user generates a new_follower notification for the followee."""
    _make_user(session, "alice@example.com", "alice")
    _make_user(session, "bob@example.com", "bob")

    _login(client, "bob@example.com")
    r = client.post("/api/social/users/alice/follow")
    assert r.status_code == 201

    _logout(client)
    _login(client, "alice@example.com")
    r = client.get("/api/notifications")
    assert r.status_code == 200
    items = r.json()["items"]
    kinds = [n["kind"] for n in items]
    assert "new_follower" in kinds
    follower_notif = next(n for n in items if n["kind"] == "new_follower")
    assert follower_notif["actor"]["handle"] == "bob"
    assert follower_notif["event_id"] is None


def test_mutual_follow_creates_new_friend_notifications(client, session):
    """A mutual follow generates new_friend notifications for both users."""
    _make_user(session, "alice@example.com", "alice")
    _make_user(session, "bob@example.com", "bob")

    # Alice follows Bob first.
    _login(client, "alice@example.com")
    r = client.post("/api/social/users/bob/follow")
    assert r.status_code == 201
    _logout(client)

    # Bob follows Alice back — completes mutual follow.
    _login(client, "bob@example.com")
    r = client.post("/api/social/users/alice/follow")
    assert r.status_code == 201
    _logout(client)

    # Both users should have a new_friend notification.
    for email, handle in [("alice@example.com", "bob"), ("bob@example.com", "alice")]:
        _login(client, email)
        r = client.get("/api/notifications")
        assert r.status_code == 200
        items = r.json()["items"]
        kinds = [n["kind"] for n in items]
        assert "new_friend" in kinds, f"{email} missing new_friend notification"
        friend_notif = next(n for n in items if n["kind"] == "new_friend")
        assert friend_notif["actor"]["handle"] == handle
        assert friend_notif["event_id"] is None
        _logout(client)


def test_refollow_does_not_duplicate_notifications(client, session):
    """Calling follow twice in the same session (no unfollow in between,
    follow row already exists) must not double-notify."""
    _make_user(session, "alice@example.com", "alice")
    _make_user(session, "bob@example.com", "bob")

    _login(client, "bob@example.com")
    r = client.post("/api/social/users/alice/follow")
    assert r.status_code == 201
    # Second call to follow (idempotent — follow row already exists).
    r = client.post("/api/social/users/alice/follow")
    assert r.status_code == 201

    _logout(client)
    _login(client, "alice@example.com")
    r = client.get("/api/notifications")
    assert r.status_code == 200
    items = r.json()["items"]
    follower_notifs = [n for n in items if n["kind"] == "new_follower"]
    assert len(follower_notifs) == 1, (
        "idempotent re-follow must not duplicate notification"
    )


def test_unfollow_then_refollow_sends_a_new_notification(client, session):
    """BUG (staging, July 2026): unfollowing then following again produced
    NO new ``new_follower`` notification — ``notify_new_follower``'s dedup
    check found the stale row from the first follow (never cleaned up by
    unfollow) and silently no-opped forever. Fixed by having
    ``unfollow_user`` discard the stale row so a later re-follow notifies
    again."""
    _make_user(session, "alice@example.com", "alice")
    _make_user(session, "bob@example.com", "bob")

    _login(client, "bob@example.com")
    r = client.post("/api/social/users/alice/follow")
    assert r.status_code == 201
    r = client.delete("/api/social/users/alice/follow")
    assert r.status_code == 200
    r = client.post("/api/social/users/alice/follow")
    assert r.status_code == 201
    _logout(client)

    _login(client, "alice@example.com")
    r = client.get("/api/notifications")
    assert r.status_code == 200
    items = r.json()["items"]
    follower_notifs = [n for n in items if n["kind"] == "new_follower"]
    assert len(follower_notifs) == 1, (
        "re-follow after unfollow must produce a fresh notification"
    )


def test_unfollow_then_refriend_sends_new_friend_notifications_again(client, session):
    """Same bug class as above but for mutual friendship: breaking and
    re-forming a mutual follow must renotify both sides."""
    _make_user(session, "alice@example.com", "alice")
    _make_user(session, "bob@example.com", "bob")

    _login(client, "alice@example.com")
    r = client.post("/api/social/users/bob/follow")
    assert r.status_code == 201
    _logout(client)
    _login(client, "bob@example.com")
    r = client.post("/api/social/users/alice/follow")
    assert r.status_code == 201
    # Bob breaks the friendship by unfollowing alice, then re-follows.
    r = client.delete("/api/social/users/alice/follow")
    assert r.status_code == 200
    r = client.post("/api/social/users/alice/follow")
    assert r.status_code == 201
    _logout(client)

    for email in ("alice@example.com", "bob@example.com"):
        _login(client, email)
        r = client.get("/api/notifications")
        assert r.status_code == 200
        friend_notifs = [n for n in r.json()["items"] if n["kind"] == "new_friend"]
        assert len(friend_notifs) == 1, (
            f"{email} must receive a fresh new_friend notification on re-friending"
        )
        _logout(client)


# --- E8: friend-request notification correctness ----------------------------


def _make_friends_user(session: Session, email: str, handle: str) -> User:
    """Create a friends-visibility account."""
    u = User(
        email=email,
        display_name=handle.title(),
        handle=handle,
        provider="google",
        provider_subject=f"mock|{email}",
        account_visibility="friends",
    )
    session.add(u)
    session.commit()
    session.refresh(u)
    return u


def test_e8_approve_request_notifies_requester_not_approver(client, session):
    """Approving a follow-request must send follow_request_approved to the
    requester (bob), NOT new_follower to the approver (alice).

    Bug: the old code called notify_new_follower(followee=alice, follower=bob)
    which incorrectly sent Alice a "Bob started following you – Follow back?"
    notification. Post-fix, Alice should get NO notification (she just
    approved), and Bob should get follow_request_approved.
    """
    import os

    os.environ["FEATURE_FRIEND_REQUESTS"] = "true"

    _make_friends_user(session, "alice@example.com", "alice")
    _make_user(session, "bob@example.com", "bob")

    # Bob sends follow-request to alice (friends-only account).
    _login(client, "bob@example.com")
    r = client.post("/api/social/users/alice/follow")
    assert r.status_code == 201, r.text
    assert r.json()["follow_status"] == "pending"
    _logout(client)

    # Alice approves the request.
    _login(client, "alice@example.com")
    r = client.post("/api/social/me/follow-requests/bob/approve")
    assert r.status_code == 200, r.text

    # Alice must NOT have a new_follower notification.
    r = client.get("/api/notifications")
    alice_kinds = [n["kind"] for n in r.json()["items"]]
    assert "new_follower" not in alice_kinds, (
        "alice (approver) must not receive new_follower"
    )
    # Alice's inbox: follow_request row must be gone.
    assert "follow_request" not in alice_kinds
    _logout(client)

    # Bob must receive follow_request_approved with alice as actor.
    _login(client, "bob@example.com")
    r = client.get("/api/notifications")
    assert r.status_code == 200
    items = r.json()["items"]
    kinds = [n["kind"] for n in items]
    assert "follow_request_approved" in kinds, (
        "requester (bob) must receive follow_request_approved"
    )
    approved_notif = next(n for n in items if n["kind"] == "follow_request_approved")
    assert approved_notif["actor"]["handle"] == "alice"


def test_e8_pending_follow_public_event_appears_in_subscribed_feed(client, session):
    """A pending-follow target's public-audience going-event should appear
    in the viewer's subscribed-events feed even before approval."""
    import os

    os.environ["FEATURE_FRIEND_REQUESTS"] = "true"

    _make_calendar(session)
    _make_event(session, "ev-pending-public")

    alice = _make_friends_user(session, "alice@example.com", "alice")
    _make_user(session, "bob@example.com", "bob")

    # Alice marks going with public audience.
    session.add(
        UserEventAttendance(
            device_id="dev-alice",
            event_id="ev-pending-public",
            user_id=alice.id,
            share_audience="public",
            share_publicly=True,
        )
    )
    session.commit()

    # Bob requests to follow alice (pending).
    _login(client, "bob@example.com")
    r = client.post("/api/social/users/alice/follow")
    assert r.json()["follow_status"] == "pending"

    # Bob's subscribed-events feed should include alice's event.
    r = client.get("/api/social/me/subscribed-events")
    assert r.status_code == 200, r.text
    event_ids = [item["event_id"] for item in r.json()["items"]]
    assert "ev-pending-public" in event_ids, (
        "pending-follow target's public event must appear in subscribed feed"
    )


def test_e8_pending_follow_friends_event_does_not_appear_in_subscribed_feed(
    client, session
):
    """A pending-follow target's friends-audience event must NOT appear
    in the viewer's subscribed-events feed."""
    import os

    os.environ["FEATURE_FRIEND_REQUESTS"] = "true"

    _make_calendar(session)
    _make_event(session, "ev-pending-friends")

    alice = _make_friends_user(session, "alice@example.com", "alice")
    _make_user(session, "bob@example.com", "bob")

    # Alice marks going with friends-only audience.
    session.add(
        UserEventAttendance(
            device_id="dev-alice-f",
            event_id="ev-pending-friends",
            user_id=alice.id,
            share_audience="friends",
            share_publicly=False,
        )
    )
    session.commit()

    # Bob requests to follow alice (pending).
    _login(client, "bob@example.com")
    r = client.post("/api/social/users/alice/follow")
    assert r.json()["follow_status"] == "pending"

    # Bob's subscribed-events feed must NOT include alice's friends-only event.
    r = client.get("/api/social/me/subscribed-events")
    assert r.status_code == 200
    event_ids = [item["event_id"] for item in r.json()["items"]]
    assert "ev-pending-friends" not in event_ids, (
        "pending-follow target's friends-audience event must NOT appear in feed"
    )
