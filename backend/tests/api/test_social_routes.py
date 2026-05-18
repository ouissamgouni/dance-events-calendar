"""Tests for the social/friends graph routes (Phase A foundation).

Covers:
- Public profile shape & email-not-leaked invariant.
- Follow / unfollow / mutual-friend derivation.
- ``can_view`` matrix via the followers/following list endpoints
  (visibility × relationship × scope) with the 404-not-403 contract.
- Visibility & social-link account updates.
"""

import os

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

os.environ.setdefault("SESSION_SECRET", "test-secret-social")
os.environ.setdefault("ADMIN_EMAIL", "admin@example.com")
os.environ["DEV_AUTH"] = "true"

from backend.api.main import app  # noqa: E402
from backend.api.routes import auth as auth_module  # noqa: E402
from backend.api.routes import social as social_module  # noqa: E402
from backend.db.database import get_session  # noqa: E402
from backend.db.models import User, UserFollow  # noqa: E402


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


def _logout(client: TestClient) -> None:
    client.cookies.clear()


def _make_user(
    session: Session,
    email: str,
    handle: str,
    *,
    account_visibility: str = "friends",
    visibility_calendar: str | None = None,
    visibility_attendance: str | None = None,
    visibility_saved: str | None = None,
) -> User:
    # Back-compat for callers passing the legacy per-scope kwargs:
    # any non-"public" collapses to ``friends``; explicit
    # ``account_visibility`` always wins.
    legacy = [
        v for v in (visibility_calendar, visibility_attendance, visibility_saved) if v
    ]
    if legacy and account_visibility == "friends":
        if all(v == "public" for v in legacy):
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


# --- Public profile ---------------------------------------------------------


def test_public_profile_returns_handle_and_no_email(client, session):
    alice = _make_user(session, "alice@example.com", "alice")
    r = client.get(f"/api/social/users/{alice.handle}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["handle"] == "alice"
    assert body["display_name"] == "Alice"
    assert body["is_self"] is False
    assert body["is_following"] is False
    assert body["is_friend"] is False
    assert body["followers_count"] == 0
    assert body["following_count"] == 0
    assert "email" not in body
    assert "share_code" not in body
    assert "provider" not in body


def test_public_profile_unknown_handle_returns_404(client):
    r = client.get("/api/social/users/nobody")
    assert r.status_code == 404


def test_public_profile_handle_lookup_is_case_insensitive(client, session):
    _make_user(session, "alice@example.com", "alice")
    r = client.get("/api/social/users/ALICE")
    assert r.status_code == 200
    assert r.json()["handle"] == "alice"


# --- Follow / unfollow / mutual ---------------------------------------------


def test_follow_then_mutual_becomes_friend(client, session):
    _make_user(session, "alice@example.com", "alice")
    _make_user(session, "bob@example.com", "bob")

    _login(client, "alice@example.com")
    r = client.post("/api/social/users/bob/follow")
    assert r.status_code == 201, r.text
    assert r.json()["is_following"] is True
    assert r.json()["is_friend"] is False
    assert r.json()["followers_count"] == 1

    # Bob follows back → mutual → friend.
    _logout(client)
    _login(client, "bob@example.com")
    r = client.post("/api/social/users/alice/follow")
    assert r.status_code == 201
    assert r.json()["is_friend"] is True

    # Alice's view of Bob now shows is_friend=True.
    _logout(client)
    _login(client, "alice@example.com")
    body = client.get("/api/social/users/bob").json()
    assert body["is_following"] is True
    assert body["follows_you"] is True
    assert body["is_friend"] is True


def test_follow_self_is_rejected(client, session):
    _make_user(session, "alice@example.com", "alice")
    _login(client, "alice@example.com")
    r = client.post("/api/social/users/alice/follow")
    assert r.status_code == 400


def test_follow_is_idempotent(client, session):
    _make_user(session, "alice@example.com", "alice")
    _make_user(session, "bob@example.com", "bob")
    _login(client, "alice@example.com")
    r1 = client.post("/api/social/users/bob/follow")
    r2 = client.post("/api/social/users/bob/follow")
    assert r1.status_code == 201
    assert r2.status_code == 201
    # Only one row in the DB.
    rows = session.exec(select(UserFollow)).all()
    assert len(rows) == 1


def test_unfollow_removes_friendship(client, session):
    _make_user(session, "alice@example.com", "alice")
    bob = _make_user(session, "bob@example.com", "bob")
    alice = session.exec(select(User).where(User.email == "alice@example.com")).first()
    _follow(session, alice, bob)
    _follow(session, bob, alice)

    _login(client, "alice@example.com")
    r = client.delete("/api/social/users/bob/follow")
    assert r.status_code == 200
    assert r.json()["is_following"] is False
    assert r.json()["is_friend"] is False


def test_follow_requires_authentication(client, session):
    _make_user(session, "alice@example.com", "alice")
    r = client.post("/api/social/users/alice/follow")
    assert r.status_code == 401


# --- can_view matrix via list endpoints -------------------------------------


def _seed_relationship(session: Session, *, mutual: bool, follower_only: bool):
    """Create alice + bob with the requested relationship from bob → alice."""
    alice = _make_user(session, "alice@example.com", "alice")
    bob = _make_user(session, "bob@example.com", "bob")
    if mutual:
        _follow(session, alice, bob)
        _follow(session, bob, alice)
    elif follower_only:
        # Bob follows Alice but Alice does not follow back → not mutual.
        _follow(session, bob, alice)
    return alice, bob


@pytest.mark.parametrize(
    "visibility,viewer,expected",
    [
        # PUBLIC — anyone.
        ("public", "anon", 200),
        ("public", "stranger", 200),
        ("public", "follower_only", 200),
        ("public", "friend", 200),
        ("public", "self", 200),
        # FRIENDS — only mutual + self.
        ("friends", "anon", 404),
        ("friends", "stranger", 404),
        ("friends", "follower_only", 404),
        ("friends", "friend", 200),
        ("friends", "self", 200),
        # ``private`` was removed from the model in the visibility
        # simplification refactor — ``friends`` is now the tightest.
    ],
)
def test_can_view_matrix_via_followers_endpoint(
    client, session, visibility, viewer, expected
):
    """Pin the can_view (visibility × relationship) matrix end-to-end via the
    followers list endpoint, which uses the calendar-scope chokepoint.
    Privacy contract: denial returns 404, never 403.
    """
    if viewer == "friend":
        alice, _bob = _seed_relationship(session, mutual=True, follower_only=False)
    elif viewer == "follower_only":
        alice, _bob = _seed_relationship(session, mutual=False, follower_only=True)
    else:
        alice = _make_user(session, "alice@example.com", "alice")
        if viewer in ("stranger", "self"):
            _make_user(session, "bob@example.com", "bob")

    # Set Alice's account visibility (single gate post-refactor).
    alice.account_visibility = visibility
    session.add(alice)
    session.commit()

    if viewer == "self":
        _login(client, "alice@example.com")
    elif viewer != "anon":
        _login(client, "bob@example.com")

    r = client.get("/api/social/users/alice/followers")
    assert r.status_code == expected, (
        f"visibility={visibility} viewer={viewer} → got {r.status_code}, body={r.text}"
    )


# --- Visibility update ------------------------------------------------------


def test_update_visibility_persists_and_returns_profile(client, session):
    _make_user(session, "alice@example.com", "alice")
    _login(client, "alice@example.com")
    r = client.patch(
        "/api/social/me/visibility",
        json={"account_visibility": "friends"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["account_visibility"] == "friends"


def test_update_visibility_rejects_unknown_value(client, session):
    _make_user(session, "alice@example.com", "alice")
    _login(client, "alice@example.com")
    r = client.patch(
        "/api/social/me/visibility",
        json={"account_visibility": "world-readable"},
    )
    assert r.status_code == 422


# --- Social links -----------------------------------------------------------


def test_update_social_links_normalizes_and_validates_host(client, session):
    _make_user(session, "alice@example.com", "alice")
    _login(client, "alice@example.com")

    r = client.patch(
        "/api/social/me/social-links",
        json={"instagram_url": "instagram.com/alice"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["instagram_url"] == "https://instagram.com/alice"

    r = client.patch(
        "/api/social/me/social-links",
        json={"instagram_url": "https://evil.example.com/alice"},
    )
    assert r.status_code == 400


def test_update_social_links_empty_string_clears(client, session):
    alice = _make_user(session, "alice@example.com", "alice")
    alice.facebook_url = "https://facebook.com/alice"
    session.add(alice)
    session.commit()
    _login(client, "alice@example.com")
    r = client.patch("/api/social/me/social-links", json={"facebook_url": ""})
    assert r.status_code == 200
    assert r.json()["facebook_url"] is None


# --- Friends list -----------------------------------------------------------


def test_my_friends_only_returns_mutuals(client, session):
    alice = _make_user(session, "alice@example.com", "alice")
    bob = _make_user(session, "bob@example.com", "bob")
    carol = _make_user(session, "carol@example.com", "carol")
    # Alice<->Bob mutual, Alice→Carol one-way only.
    _follow(session, alice, bob)
    _follow(session, bob, alice)
    _follow(session, alice, carol)

    _login(client, "alice@example.com")
    r = client.get("/api/social/me/friends")
    assert r.status_code == 200
    body = r.json()
    handles = {item["handle"] for item in body["items"]}
    assert handles == {"bob"}
    assert body["total"] == 1
