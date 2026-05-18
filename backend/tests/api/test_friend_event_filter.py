"""Tests for the explorer friend filter (Phase B3).

Exercises the ``friends_going``, ``friends_saved``, and ``friend_handle``
query params on ``GET /api/events`` plus the privacy contract: a friend
whose visibility for the requested scope is private/non-friends MUST NOT
have their attendance/saved leak via the filter, and the endpoint must
never 403.
"""

import os
from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

os.environ.setdefault("SESSION_SECRET", "test-secret-friend-filter")
os.environ.setdefault("ADMIN_EMAIL", "admin@example.com")
os.environ["DEV_AUTH"] = "true"

from backend.api.main import app  # noqa: E402
from backend.api.routes import auth as auth_module  # noqa: E402
from backend.api.routes import events as events_module  # noqa: E402
from backend.api.routes import social as social_module  # noqa: E402
from backend.db.database import get_session  # noqa: E402
from backend.db.models import (  # noqa: E402
    CachedEvent,
    CalendarSetting,
    SiteSetting,
    User,
    UserEventAttendance,
    UserFollow,
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
    events_module.limiter.reset()
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
    account_visibility: str = "friends",
    visibility_attendance: str | None = None,
    visibility_saved: str | None = None,
) -> User:
    _ = (visibility_attendance, visibility_saved)  # back-compat no-op
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


@pytest.fixture
def world(session):
    """Two events, one calendar, three users with a defined friend graph."""
    # Required: a since-date setting used by ``_get_since_date``.
    session.add(SiteSetting(key="cutoff_date", value="2020-01-01"))
    # Single enabled calendar.
    session.add(CalendarSetting(calendar_id="cal-1", name="Salsa", enabled=True))
    base = datetime(2030, 1, 1, 20, 0, 0)
    session.add(
        CachedEvent(
            event_id="evt-going",
            calendar_id="cal-1",
            title="Friend going event",
            description="",
            location="",
            start=base,
            end=base + timedelta(hours=2),
            all_day=False,
        )
    )
    session.add(
        CachedEvent(
            event_id="evt-saved",
            calendar_id="cal-1",
            title="Friend saved event",
            description="",
            location="",
            start=base + timedelta(days=1),
            end=base + timedelta(days=1, hours=2),
            all_day=False,
        )
    )
    session.add(
        CachedEvent(
            event_id="evt-orphan",
            calendar_id="cal-1",
            title="Nobody's event",
            description="",
            location="",
            start=base + timedelta(days=2),
            end=base + timedelta(days=2, hours=2),
            all_day=False,
        )
    )
    session.commit()

    alice = _make_user(session, "alice@example.com", "alice")
    bob = _make_user(session, "bob@example.com", "bob")
    carol = _make_user(session, "carol@example.com", "carol")
    # alice <-> bob mutual; carol -> alice one-way (carol is NOT alice's friend)
    _follow(session, alice, bob)
    _follow(session, bob, alice)
    _follow(session, carol, alice)

    # Bob is going to evt-going and has saved evt-saved.
    session.add(
        UserEventAttendance(
            user_id=bob.id,
            event_id="evt-going",
            share_publicly=True,
            device_id="seed-bob",
        )
    )
    session.add(
        UserSavedEvent(user_id=bob.id, event_id="evt-saved", device_id="seed-bob")
    )
    # Carol is going to evt-going too but is not alice's friend.
    session.add(
        UserEventAttendance(
            user_id=carol.id,
            event_id="evt-going",
            share_publicly=True,
            device_id="seed-carol",
        )
    )
    session.commit()
    return {"alice": alice, "bob": bob, "carol": carol}


# --- Anonymous viewer -------------------------------------------------------


def test_anonymous_viewer_friends_going_returns_empty(client, world):
    r = client.get("/api/events", params={"friends_going": "true"})
    assert r.status_code == 200
    assert r.json() == []


# --- Friend filter (mutual followers) --------------------------------------


def test_friends_going_returns_only_friend_attendance(client, world):
    _login(client, "alice@example.com")
    r = client.get("/api/events", params={"friends_going": "true"})
    assert r.status_code == 200
    body = r.json()
    ids = {e["event_id"] for e in body}
    # Bob is alice's friend and is going to evt-going. Carol is also going,
    # but she is NOT alice's friend, so her attendance must NOT pull
    # evt-going in via her — the same event is included only because Bob is.
    assert ids == {"evt-going"}


def test_friends_saved_returns_only_friend_saves(client, world):
    _login(client, "alice@example.com")
    r = client.get("/api/events", params={"friends_saved": "true"})
    assert r.status_code == 200
    ids = {e["event_id"] for e in r.json()}
    assert ids == {"evt-saved"}


def test_friends_going_and_saved_union(client, world):
    _login(client, "alice@example.com")
    r = client.get(
        "/api/events",
        params={"friends_going": "true", "friends_saved": "true"},
    )
    assert r.status_code == 200
    ids = {e["event_id"] for e in r.json()}
    assert ids == {"evt-going", "evt-saved"}


def test_friends_filter_with_no_friends_returns_empty(client, session, world):
    # Carol has no mutual followers (only one-way carol->alice). Filter must
    # be empty without leaking alice's activity.
    _login(client, "carol@example.com")
    r = client.get(
        "/api/events",
        params={"friends_going": "true", "friends_saved": "true"},
    )
    assert r.status_code == 200
    assert r.json() == []


# --- Visibility gate per-friend --------------------------------------------


def test_friend_with_private_attendance_is_excluded(client, session, world):
    # After the visibility simplification (single ``account_visibility``
    # gate), per-scope attendance privacy is enforced via the per-row
    # ``UserEventAttendance.share_audience`` field, not a user-level flag.
    # Tighten Bob's *going* row for evt-going to ``private``; alice (his
    # friend) must no longer see it via the friend-going filter, but
    # bob's saved row remains friends-visible.
    from backend.db.models import UserEventAttendance

    bob = world["bob"]
    going_row = session.exec(
        select(UserEventAttendance).where(
            (UserEventAttendance.user_id == bob.id)
            & (UserEventAttendance.event_id == "evt-going")
        )
    ).first()
    assert going_row is not None
    going_row.share_audience = "private"
    going_row.share_publicly = False
    session.add(going_row)
    session.commit()

    _login(client, "alice@example.com")
    r = client.get(
        "/api/events",
        params={"friends_going": "true", "friends_saved": "true"},
    )
    assert r.status_code == 200
    ids = {e["event_id"] for e in r.json()}
    assert ids == {"evt-saved"}, "private attendance must not leak via friend filter"


# --- Specific friend handle ------------------------------------------------


def test_friend_handle_filters_to_named_user_activity(client, world):
    _login(client, "alice@example.com")
    r = client.get("/api/events", params={"friend_handle": "bob"})
    assert r.status_code == 200
    ids = {e["event_id"] for e in r.json()}
    # Default: friend_handle alone enables both scopes (going OR saved).
    assert ids == {"evt-going", "evt-saved"}


def test_friend_handle_unknown_returns_empty_not_404(client, world):
    _login(client, "alice@example.com")
    r = client.get("/api/events", params={"friend_handle": "ghost"})
    assert r.status_code == 200, "unknown handle must not surface as 404"
    assert r.json() == []


def test_friend_handle_respects_visibility(client, session, world):
    # Carol (not alice's friend) tries to filter by alice. Alice's defaults
    # are friends-only; both attendance & saved scopes must be denied so
    # the result is empty (no leak), and HTTP stays 200.
    _login(client, "carol@example.com")
    r = client.get("/api/events", params={"friend_handle": "alice"})
    assert r.status_code == 200
    assert r.json() == []
