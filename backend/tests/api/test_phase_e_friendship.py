"""Phase E (friendship adoption) — Batch 1 tests.

Covers:
- E1: NotificationActor.is_following is true on the recipient's view of
  ``new_follower`` rows when the recipient already follows the actor.
- E2: /api/auth/me returns the viewer's own friend_count.
- E10: PublicProfileResponse.mutual_friends_who_follow surfaces only on
  verified-organizer profiles for authenticated viewers.
- E9: GET /api/social/me/friends/leaderboard ranks friends by Going
  count over a window with handle ASC tiebreak; private RSVPs excluded.
"""

import os
from datetime import datetime, timedelta
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

os.environ.setdefault("SESSION_SECRET", "test-secret-phase-e")
os.environ.setdefault("ADMIN_EMAIL", "admin@example.com")
os.environ["DEV_AUTH"] = "true"

from backend.api.main import app  # noqa: E402
from backend.api.routes import auth as auth_module  # noqa: E402
from backend.api.routes import social as social_module  # noqa: E402
from backend.db.database import get_session  # noqa: E402
from backend.db.models import (  # noqa: E402
    CachedEvent,
    CalendarSetting,
    Notification,
    User,
    UserEventAttendance,
    UserFollow,
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


# --- helpers ----------------------------------------------------------------


def _login(client: TestClient, email: str) -> None:
    r = client.post(
        "/api/auth/google",
        json={"credential": "ignored", "mock_email": email},
    )
    assert r.status_code == 200, r.text


def _logout(client: TestClient) -> None:
    client.cookies.clear()


def _make_user(
    session: Session,
    email: str,
    handle: str,
    *,
    account_visibility: str = "public",
    is_verified_organizer: bool = False,
) -> User:
    u = User(
        email=email,
        display_name=handle.title(),
        handle=handle,
        provider="google",
        provider_subject=f"mock|{email}",
        account_visibility=account_visibility,
        is_verified_organizer=is_verified_organizer,
    )
    session.add(u)
    session.commit()
    session.refresh(u)
    return u


def _follow(session: Session, follower: User, followee: User) -> None:
    session.add(UserFollow(follower_id=follower.id, followee_id=followee.id))
    session.commit()


def _mutual(session: Session, a: User, b: User) -> None:
    _follow(session, a, b)
    _follow(session, b, a)


def _make_calendar(session: Session, cal_id: str = "cal-e") -> CalendarSetting:
    c = CalendarSetting(calendar_id=cal_id, name="Test", color="#abc", enabled=True)
    session.add(c)
    session.commit()
    session.refresh(c)
    return c


def _make_event(
    session: Session,
    *,
    days_offset: int,
    cal_id: str = "cal-e",
    event_id: str | None = None,
) -> CachedEvent:
    e = CachedEvent(
        event_id=event_id or f"evt-{uuid4().hex[:8]}",
        calendar_id=cal_id,
        title="Salsa Night",
        start=datetime.utcnow() + timedelta(days=days_offset),
        end=datetime.utcnow() + timedelta(days=days_offset, hours=2),
        all_day=False,
    )
    session.add(e)
    session.commit()
    session.refresh(e)
    return e


def _attend(
    session: Session,
    user: User,
    event: CachedEvent,
    *,
    audience: str = "public",
) -> None:
    session.add(
        UserEventAttendance(
            user_id=user.id,
            event_id=event.event_id,
            device_id=f"dev-{user.handle}-{event.event_id}",
            share_publicly=(audience == "public"),
            share_audience=audience,
        )
    )
    session.commit()


# --- E1 ---------------------------------------------------------------------


def test_e1_new_follower_actor_is_following_reflects_recipient_state(client, session):
    """When Alice already follows Bob and Bob then follows Alice, the
    new_follower notification on Alice's feed reports actor.is_following=True.
    The mirror case (Alice does NOT follow Bob) reports False so the
    Follow-back button can render."""
    alice = _make_user(session, "alice@example.com", "alice")
    bob = _make_user(session, "bob@example.com", "bob")

    # Case A: Alice does NOT follow Bob yet — Bob follows Alice.
    _login(client, "bob@example.com")
    r = client.post(f"/api/social/users/{alice.handle}/follow")
    assert r.status_code == 201
    _logout(client)

    _login(client, "alice@example.com")
    body = client.get("/api/notifications?kind=new_follower").json()
    assert body["total"] == 1
    actor = body["items"][0]["actor"]
    assert actor["handle"] == "bob"
    assert actor["is_following"] is False, "Alice does not follow Bob yet"

    # Now Alice follows Bob back. The same notification row should now
    # report is_following=True (recomputed at read time, no row mutation).
    r = client.post(f"/api/social/users/{bob.handle}/follow")
    assert r.status_code == 201

    body = client.get("/api/notifications?kind=new_follower").json()
    assert body["total"] == 1
    assert body["items"][0]["actor"]["is_following"] is True


def test_e1_other_users_notifications_do_not_leak_following_state(client, session):
    """is_following is computed against the *recipient*, not the actor.
    A snoop fetching their own notifications never sees other users'
    edges — defense in depth around the per-row visibility guarantee.
    """
    alice = _make_user(session, "alice@example.com", "alice")
    bob = _make_user(session, "bob@example.com", "bob")
    carol = _make_user(session, "carol@example.com", "carol")

    # Bob follows Alice (creates a new_follower notif for Alice).
    _login(client, "bob@example.com")
    client.post(f"/api/social/users/{alice.handle}/follow")
    _logout(client)

    # Carol follows nobody and has no notifications.
    _login(client, "carol@example.com")
    body = client.get("/api/notifications").json()
    assert body["total"] == 0
    # Sanity: alice's notifs not exposed.
    notif_count = session.exec(
        # noqa
        __import__("sqlmodel")
        .select(Notification)
        .where(Notification.recipient_user_id == alice.id)
    ).all()
    assert len(notif_count) == 1


# --- E2 ---------------------------------------------------------------------


def test_e2_auth_me_includes_friend_count_zero_for_no_mutuals(client, session):
    _make_user(session, "alice@example.com", "alice")
    _login(client, "alice@example.com")
    body = client.get("/api/auth/me").json()
    assert body["friend_count"] == 0


def test_e2_auth_me_friend_count_counts_only_mutuals(client, session):
    alice = _make_user(session, "alice@example.com", "alice")
    bob = _make_user(session, "bob@example.com", "bob")
    carol = _make_user(session, "carol@example.com", "carol")
    dave = _make_user(session, "dave@example.com", "dave")

    _mutual(session, alice, bob)
    _mutual(session, alice, carol)
    # One-way edge — not a friend.
    _follow(session, dave, alice)

    _login(client, "alice@example.com")
    body = client.get("/api/auth/me").json()
    assert body["friend_count"] == 2


def test_e2_auth_me_requires_auth(client, session):
    r = client.get("/api/auth/me")
    assert r.status_code == 401


# --- E10 --------------------------------------------------------------------


def test_e10_mutual_friends_who_follow_only_for_verified_organizer(client, session):
    """Pill data is suppressed (0) for non-verified targets even when the
    viewer has friends who follow them."""
    viewer = _make_user(session, "viewer@example.com", "viewer")
    friend1 = _make_user(session, "friend1@example.com", "friend1")
    friend2 = _make_user(session, "friend2@example.com", "friend2")
    target = _make_user(
        session, "target@example.com", "target", is_verified_organizer=False
    )

    _mutual(session, viewer, friend1)
    _mutual(session, viewer, friend2)
    _follow(session, friend1, target)
    _follow(session, friend2, target)

    _login(client, "viewer@example.com")
    body = client.get(f"/api/social/users/{target.handle}").json()
    assert body["mutual_friends_who_follow"] == 0


def test_e10_mutual_friends_who_follow_counts_viewer_friends_following_organizer(
    client, session
):
    viewer = _make_user(session, "viewer@example.com", "viewer")
    f1 = _make_user(session, "f1@example.com", "f1")
    f2 = _make_user(session, "f2@example.com", "f2")
    f3 = _make_user(session, "f3@example.com", "f3")
    organizer = _make_user(
        session, "org@example.com", "org", is_verified_organizer=True
    )

    _mutual(session, viewer, f1)
    _mutual(session, viewer, f2)
    _mutual(session, viewer, f3)
    # Two of the viewer's friends follow the organizer; one does not.
    _follow(session, f1, organizer)
    _follow(session, f2, organizer)

    _login(client, "viewer@example.com")
    body = client.get(f"/api/social/users/{organizer.handle}").json()
    assert body["is_verified_organizer"] is True
    assert body["mutual_friends_who_follow"] == 2


def test_e10_mutual_friends_who_follow_zero_for_anonymous(client, session):
    organizer = _make_user(
        session, "org@example.com", "org", is_verified_organizer=True
    )
    body = client.get(f"/api/social/users/{organizer.handle}").json()
    assert body["mutual_friends_who_follow"] == 0


# --- E9 ---------------------------------------------------------------------


def test_e9_leaderboard_requires_auth(client, session):
    r = client.get("/api/social/me/friends/leaderboard")
    assert r.status_code == 401


def test_e9_leaderboard_rejects_invalid_period(client, session):
    _make_user(session, "alice@example.com", "alice")
    _login(client, "alice@example.com")
    r = client.get("/api/social/me/friends/leaderboard?period=1y")
    assert r.status_code == 400


def test_e9_leaderboard_ranks_friends_by_going_with_handle_tiebreak(client, session):
    viewer = _make_user(session, "viewer@example.com", "viewer")
    # Friends: alpha (2 going), beta (1 going), gamma (0 going), delta (1 going).
    # Tied at 1 → handle ASC: beta before delta.
    alpha = _make_user(session, "alpha@example.com", "alpha")
    beta = _make_user(session, "beta@example.com", "beta")
    gamma = _make_user(session, "gamma@example.com", "gamma")
    delta = _make_user(session, "delta@example.com", "delta")
    # Stranger (not a friend) — must NOT appear regardless of activity.
    stranger = _make_user(session, "stranger@example.com", "stranger")

    for u in (alpha, beta, gamma, delta, stranger):
        _mutual(session, viewer, u) if u is not stranger else None

    _make_calendar(session)
    e1 = _make_event(session, days_offset=1, event_id="e1")
    e2 = _make_event(session, days_offset=2, event_id="e2")
    e3 = _make_event(session, days_offset=3, event_id="e3")
    e4 = _make_event(session, days_offset=4, event_id="e4")
    e5 = _make_event(session, days_offset=5, event_id="e5")

    _attend(session, alpha, e1, audience="public")
    _attend(session, alpha, e2, audience="friends")
    _attend(session, beta, e3, audience="public")
    _attend(session, delta, e4, audience="friends")
    # Private RSVPs are invisible — must not bump the count.
    _attend(session, gamma, e5, audience="private")
    # Stranger has 5 going but isn't a friend.
    _attend(session, stranger, e1, audience="public")

    _login(client, "viewer@example.com")
    body = client.get("/api/social/me/friends/leaderboard?period=30d").json()
    assert body["period"] == "30d"
    items = body["items"]
    handles = [it["handle"] for it in items]
    # Stranger absent; gamma absent (private only).
    assert "stranger" not in handles
    assert "gamma" not in handles
    # alpha (2) > beta (1) > delta (1) by handle tiebreak.
    assert handles[:3] == ["alpha", "beta", "delta"]
    assert items[0]["going_count"] == 2
    assert items[1]["going_count"] == 1
    assert items[2]["going_count"] == 1
    # Ranks are 1-based and contiguous.
    assert [it["rank"] for it in items[:3]] == [1, 2, 3]


def test_e9_leaderboard_period_filters_by_window(client, session):
    viewer = _make_user(session, "viewer@example.com", "viewer")
    friend = _make_user(session, "friend@example.com", "friend")
    _mutual(session, viewer, friend)

    _make_calendar(session)
    # One event inside 7d window, one outside.
    inside = CachedEvent(
        event_id="inside",
        calendar_id="cal-e",
        title="Inside",
        start=datetime.utcnow() + timedelta(days=2),
        end=datetime.utcnow() + timedelta(days=2, hours=2),
        all_day=False,
    )
    outside = CachedEvent(
        event_id="outside",
        calendar_id="cal-e",
        title="Outside",
        start=datetime.utcnow() - timedelta(days=20),
        end=datetime.utcnow() - timedelta(days=20, hours=-2),
        all_day=False,
    )
    session.add(inside)
    session.add(outside)
    session.commit()
    _attend(session, friend, inside, audience="public")
    _attend(session, friend, outside, audience="public")

    _login(client, "viewer@example.com")
    body_7 = client.get("/api/social/me/friends/leaderboard?period=7d").json()
    body_30 = client.get("/api/social/me/friends/leaderboard?period=30d").json()
    assert body_7["items"][0]["going_count"] == 1
    assert body_30["items"][0]["going_count"] == 2
