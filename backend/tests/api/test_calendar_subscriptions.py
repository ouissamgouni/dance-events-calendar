"""Tests for the calendar-subscription routes (Phase B1).

Covers the subscribe/unsubscribe lifecycle, idempotency, the
``can_view`` gate at write time, the privacy-preserving 404 contract,
self-subscription rejection, the ``can_view_calendar`` recompute on
listing, and the cascade-on-delete behavior of the underlying FK.
"""

import os

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

os.environ.setdefault("SESSION_SECRET", "test-secret-subs")
os.environ.setdefault("ADMIN_EMAIL", "admin@example.com")
os.environ["DEV_AUTH"] = "true"

from backend.api.main import app  # noqa: E402
from backend.api.routes import auth as auth_module  # noqa: E402
from backend.api.routes import social as social_module  # noqa: E402
from backend.db.database import get_session  # noqa: E402
from backend.db.models import (  # noqa: E402
    CalendarSubscription,
    User,
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


def _login(client: TestClient, email: str) -> None:
    r = client.post(
        "/api/auth/google",
        json={"credential": "ignored", "mock_email": email},
    )
    assert r.status_code == 200, r.text


def _make_user(
    session: Session,
    email: str,
    handle: str,
    *,
    visibility_calendar: str = "friends",
) -> User:
    # ``visibility_calendar`` retained as the helper's kwarg name for
    # call-site compatibility with the pre-refactor tests; values map
    # to the new single ``account_visibility`` field (``private`` is no
    # longer a valid value — it collapses to ``friends``).
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


def _follow(session: Session, follower: User, followee: User) -> None:
    session.add(UserFollow(follower_id=follower.id, followee_id=followee.id))
    session.commit()


def _count_subs(session: Session) -> int:
    return len(session.exec(select(CalendarSubscription)).all())


# --- Auth gate --------------------------------------------------------------


def test_subscribe_requires_auth(client, session):
    alice = _make_user(
        session, "alice@example.com", "alice", visibility_calendar="public"
    )
    r = client.post(
        f"/api/social/users/{alice.handle}/subscribe",
        json={"notify_new_events": True},
    )
    assert r.status_code == 401


# --- can_view gate at write time --------------------------------------------


def test_subscribe_to_public_calendar_succeeds_without_friendship(client, session):
    alice = _make_user(
        session, "alice@example.com", "alice", visibility_calendar="public"
    )
    _make_user(session, "bob@example.com", "bob")
    _login(client, "bob@example.com")
    r = client.post(
        f"/api/social/users/{alice.handle}/subscribe",
        json={"notify_new_events": True},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body == {
        "handle": "alice",
        "is_subscribed": True,
        "notify_new_events": True,
    }
    assert _count_subs(session) == 1


def test_subscribe_to_friends_only_calendar_requires_mutual_follow(client, session):
    alice = _make_user(session, "alice@example.com", "alice")  # default friends
    bob = _make_user(session, "bob@example.com", "bob")
    _login(client, "bob@example.com")
    # Bob is a stranger — must 404 (privacy chokepoint, never 403).
    r = client.post(
        f"/api/social/users/{alice.handle}/subscribe",
        json={"notify_new_events": True},
    )
    assert r.status_code == 404
    assert _count_subs(session) == 0
    # Make them mutual followers, then it should succeed.
    _follow(session, alice, bob)
    _follow(session, bob, alice)
    r = client.post(
        f"/api/social/users/{alice.handle}/subscribe",
        json={"notify_new_events": True},
    )
    assert r.status_code == 200, r.text
    assert _count_subs(session) == 1


def test_subscribe_to_private_calendar_returns_404(client, session):
    # Post-refactor, ``private`` is no longer a valid ``account_visibility``;
    # ``friends`` is the tightest. Non-friend viewers are blocked
    # (404, the privacy chokepoint's "leak-proof" denial code).
    alice = _make_user(
        session, "alice@example.com", "alice", visibility_calendar="friends"
    )
    _make_user(session, "bob@example.com", "bob")
    # Bob is a stranger (no follow either way) and so cannot subscribe.
    _login(client, "bob@example.com")
    r = client.post(
        f"/api/social/users/{alice.handle}/subscribe",
        json={"notify_new_events": True},
    )
    assert r.status_code == 404


# --- Self-subscription ------------------------------------------------------


def test_subscribe_to_self_rejected(client, session):
    alice = _make_user(session, "alice@example.com", "alice")
    _login(client, "alice@example.com")
    r = client.post(
        f"/api/social/users/{alice.handle}/subscribe",
        json={"notify_new_events": True},
    )
    assert r.status_code == 400


# --- Idempotency / notify toggle --------------------------------------------


def test_resubscribe_updates_notify_flag(client, session):
    alice = _make_user(
        session, "alice@example.com", "alice", visibility_calendar="public"
    )
    _make_user(session, "bob@example.com", "bob")
    _login(client, "bob@example.com")
    r1 = client.post(
        f"/api/social/users/{alice.handle}/subscribe",
        json={"notify_new_events": True},
    )
    assert r1.status_code == 200
    assert r1.json()["notify_new_events"] is True
    r2 = client.post(
        f"/api/social/users/{alice.handle}/subscribe",
        json={"notify_new_events": False},
    )
    assert r2.status_code == 200
    assert r2.json()["notify_new_events"] is False
    assert _count_subs(session) == 1, "second POST must update, not insert"


# --- Unsubscribe ------------------------------------------------------------


def test_unsubscribe_is_idempotent(client, session):
    alice = _make_user(
        session, "alice@example.com", "alice", visibility_calendar="public"
    )
    _make_user(session, "bob@example.com", "bob")
    _login(client, "bob@example.com")
    # Unsubscribe with no existing row → 200 (toggle semantics).
    r = client.delete(f"/api/social/users/{alice.handle}/subscribe")
    assert r.status_code == 200
    assert r.json()["is_subscribed"] is False
    # Subscribe, then unsubscribe.
    client.post(
        f"/api/social/users/{alice.handle}/subscribe",
        json={"notify_new_events": True},
    )
    assert _count_subs(session) == 1
    r = client.delete(f"/api/social/users/{alice.handle}/subscribe")
    assert r.status_code == 200
    assert r.json() == {
        "handle": "alice",
        "is_subscribed": False,
        "notify_new_events": False,
    }
    assert _count_subs(session) == 0


# --- Listing ----------------------------------------------------------------


def test_my_subscriptions_lists_targets_with_can_view_recompute(client, session):
    alice = _make_user(
        session, "alice@example.com", "alice", visibility_calendar="public"
    )
    carol = _make_user(
        session, "carol@example.com", "carol", visibility_calendar="public"
    )
    bob = _make_user(session, "bob@example.com", "bob")
    _login(client, "bob@example.com")
    client.post(
        f"/api/social/users/{alice.handle}/subscribe",
        json={"notify_new_events": True},
    )
    client.post(
        f"/api/social/users/{carol.handle}/subscribe",
        json={"notify_new_events": False},
    )
    # Alice tightens calendar visibility AFTER bob has subscribed; bob's row
    # is preserved but ``can_view_calendar`` should now be False.
    alice.account_visibility = "friends"
    session.add(alice)
    session.commit()

    r = client.get("/api/social/me/subscriptions")
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 2
    by_handle = {item["handle"]: item for item in body["items"]}
    assert by_handle["alice"]["can_view_calendar"] is False
    assert by_handle["alice"]["notify_new_events"] is True
    assert by_handle["carol"]["can_view_calendar"] is True
    assert by_handle["carol"]["notify_new_events"] is False


def test_my_subscriptions_requires_auth(client, session):
    r = client.get("/api/social/me/subscriptions")
    assert r.status_code == 401


# --- FK cascade on user delete ---------------------------------------------
#
# We deliberately do NOT exercise raw ``DELETE FROM users`` here: the users
# table is referenced by many tables (share_token, ratings, etc.) whose FKs
# do not all use ON DELETE CASCADE, so a hard delete would fail for unrelated
# reasons in this in-memory SQLite harness. The cascade behavior of the new
# subscriptions FK is asserted at the migration level
# (see ``aa10b2c3d4e6_add_social_foundation`` for the matching follow-graph
# pattern); end-to-end account-deletion behavior is covered by the existing
# GDPR test suite which goes through the regular soft-delete service path.


# --- Subscribers (owner-side listing) --------------------------------------


def test_my_subscribers_requires_auth(client, session):
    r = client.get("/api/social/me/subscribers")
    assert r.status_code == 401


def test_my_subscribers_lists_inverse_of_subscriptions(client, session):
    alice = _make_user(
        session, "alice@example.com", "alice", visibility_calendar="public"
    )
    _make_user(session, "bob@example.com", "bob")
    _make_user(session, "carol@example.com", "carol")

    # Bob and Carol both subscribe to Alice.
    _login(client, "bob@example.com")
    r = client.post(
        f"/api/social/users/{alice.handle}/subscribe",
        json={"notify_new_events": False},
    )
    assert r.status_code == 200, r.text
    _login(client, "carol@example.com")
    r = client.post(
        f"/api/social/users/{alice.handle}/subscribe",
        json={"notify_new_events": True},
    )
    assert r.status_code == 200, r.text

    # Alice now sees both of them.
    _login(client, "alice@example.com")
    r = client.get("/api/social/me/subscribers")
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 2
    handles = {item["handle"] for item in body["items"]}
    assert handles == {"bob", "carol"}
    # Schema only exposes identity + when, not subscriber-side fields.
    sample = body["items"][0]
    assert set(sample.keys()) == {
        "handle",
        "display_name",
        "avatar_url",
        "is_verified_organizer",
        "subscribed_at",
    }


def test_my_subscribers_pagination(client, session):
    alice = _make_user(
        session, "alice@example.com", "alice", visibility_calendar="public"
    )
    for i in range(3):
        _make_user(session, f"u{i}@example.com", f"u{i}")
        _login(client, f"u{i}@example.com")
        r = client.post(
            f"/api/social/users/{alice.handle}/subscribe",
            json={"notify_new_events": False},
        )
        assert r.status_code == 200, r.text

    _login(client, "alice@example.com")
    r = client.get("/api/social/me/subscribers?limit=2&offset=0")
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 3
    assert len(body["items"]) == 2

    r = client.get("/api/social/me/subscribers?limit=2&offset=2")
    body = r.json()
    assert body["total"] == 3
    assert len(body["items"]) == 1


def test_my_subscribers_visibility_tightening_keeps_existing(client, session):
    """Owner tightening visibility AFTER someone subscribed must NOT hide
    that subscriber from the owner's own list. The owner needs to see who
    is following along so they can decide whether to remove them."""
    alice = _make_user(
        session, "alice@example.com", "alice", visibility_calendar="public"
    )
    _make_user(session, "bob@example.com", "bob")
    _login(client, "bob@example.com")
    r = client.post(
        f"/api/social/users/{alice.handle}/subscribe",
        json={"notify_new_events": False},
    )
    assert r.status_code == 200, r.text

    alice.account_visibility = "friends"
    session.add(alice)
    session.commit()

    _login(client, "alice@example.com")
    r = client.get("/api/social/me/subscribers")
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 1
    assert body["items"][0]["handle"] == "bob"
