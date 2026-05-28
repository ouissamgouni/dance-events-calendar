"""Tests for the explorer interest filter (Phase: interest-filter-following).

Exercises the ``interest_source``, ``interest_kind``, and
``interest_user_handle`` query params on ``GET /api/events`` plus the
privacy contract: a candidate's per-row audience MUST gate visibility,
the broader ``interest_source=follows`` set MUST include one-way
followees' ``public`` activity but never their ``friends``-audience
activity to non-mutual followers, and the endpoint must never 403.
"""

import os
from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

os.environ.setdefault("SESSION_SECRET", "test-secret-interest-filter")
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
    account_visibility: str = "public",
) -> User:
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
    """Events, calendar, three users with a defined follow graph.

    - alice <-> bob: mutual friends.
    - carol -> alice: one-way (carol follows alice; alice does NOT
      follow carol back).
    """
    session.add(SiteSetting(key="cutoff_date", value="2020-01-01"))
    session.add(CalendarSetting(calendar_id="cal-1", name="Salsa", enabled=True))
    base = datetime(2030, 1, 1, 20, 0, 0)
    for eid, offset in (
        ("evt-going", 0),
        ("evt-saved", 1),
        ("evt-orphan", 2),
        ("evt-alice-public", 3),
        ("evt-alice-friends", 4),
    ):
        session.add(
            CachedEvent(
                event_id=eid,
                calendar_id="cal-1",
                title=eid,
                description="",
                location="",
                start=base + timedelta(days=offset),
                end=base + timedelta(days=offset, hours=2),
                all_day=False,
            )
        )
    session.commit()

    alice = _make_user(session, "alice@example.com", "alice")
    bob = _make_user(session, "bob@example.com", "bob")
    carol = _make_user(session, "carol@example.com", "carol")
    _follow(session, alice, bob)
    _follow(session, bob, alice)
    _follow(session, carol, alice)

    # Bob (alice's friend) going to evt-going, saved evt-saved.
    session.add(
        UserEventAttendance(
            user_id=bob.id,
            event_id="evt-going",
            share_audience="friends",
            share_publicly=True,
            device_id="seed-bob",
        )
    )
    session.add(
        UserSavedEvent(
            user_id=bob.id,
            event_id="evt-saved",
            audience="friends",
            device_id="seed-bob",
        )
    )
    # Carol also going to evt-going (public audience).
    session.add(
        UserEventAttendance(
            user_id=carol.id,
            event_id="evt-going",
            share_audience="public",
            share_publicly=True,
            device_id="seed-carol",
        )
    )
    # Alice's activity in two audiences.
    session.add(
        UserEventAttendance(
            user_id=alice.id,
            event_id="evt-alice-public",
            share_audience="public",
            share_publicly=True,
            device_id="seed-alice-pub",
        )
    )
    session.add(
        UserSavedEvent(
            user_id=alice.id,
            event_id="evt-alice-friends",
            audience="friends",
            device_id="seed-alice-friends",
        )
    )
    session.commit()
    return {"alice": alice, "bob": bob, "carol": carol}


# --- Anonymous viewer -------------------------------------------------------


def test_anonymous_viewer_interest_returns_empty(client, world):
    r = client.get(
        "/api/events", params={"interest_source": "follows", "interest_kind": "any"}
    )
    assert r.status_code == 200
    assert r.json() == []


# --- interest_source=friends (mutual) --------------------------------------


def test_friends_going_returns_only_friend_attendance(client, world):
    _login(client, "alice@example.com")
    r = client.get(
        "/api/events",
        params={"interest_source": "friends", "interest_kind": "going"},
    )
    assert r.status_code == 200
    ids = {e["event_id"] for e in r.json()}
    assert ids == {"evt-going"}


def test_friends_saved_returns_only_friend_saves(client, world):
    _login(client, "alice@example.com")
    r = client.get(
        "/api/events",
        params={"interest_source": "friends", "interest_kind": "saved"},
    )
    assert r.status_code == 200
    ids = {e["event_id"] for e in r.json()}
    assert ids == {"evt-saved"}


def test_friends_any_unions_going_and_saved(client, world):
    _login(client, "alice@example.com")
    r = client.get(
        "/api/events",
        params={"interest_source": "friends", "interest_kind": "any"},
    )
    assert r.status_code == 200
    assert r.headers["cache-control"] == "private, max-age=0"
    assert r.headers["vary"] == "Cookie"
    ids = {e["event_id"] for e in r.json()}
    assert ids == {"evt-going", "evt-saved"}


def test_friends_filter_with_no_friends_returns_empty(client, world):
    _login(client, "carol@example.com")
    r = client.get(
        "/api/events",
        params={"interest_source": "friends", "interest_kind": "any"},
    )
    assert r.status_code == 200
    assert r.json() == []


# --- interest_source=follows (one-way OK) ----------------------------------


def test_follows_includes_one_way_followee_public_activity(client, world):
    _login(client, "carol@example.com")
    r = client.get(
        "/api/events",
        params={"interest_source": "follows", "interest_kind": "any"},
    )
    assert r.status_code == 200
    ids = {e["event_id"] for e in r.json()}
    # Carol follows alice one-way: she sees alice's public attendance
    # but NOT alice's friends-audience saved event.
    assert ids == {"evt-alice-public"}


def test_follows_friends_audience_hidden_from_one_way_follower(client, world):
    _login(client, "carol@example.com")
    r = client.get(
        "/api/events",
        params={"interest_source": "follows", "interest_kind": "saved"},
    )
    assert r.status_code == 200
    assert {e["event_id"] for e in r.json()} == set()


def test_follows_superset_of_friends_for_mutual(client, world):
    _login(client, "alice@example.com")
    r = client.get(
        "/api/events",
        params={"interest_source": "follows", "interest_kind": "any"},
    )
    assert r.status_code == 200
    ids = {e["event_id"] for e in r.json()}
    # Alice follows bob (mutual): sees bob's friends-audience activity.
    assert ids == {"evt-going", "evt-saved"}


# --- Visibility gate per-row -----------------------------------------------


def test_friend_with_private_attendance_is_excluded(client, session, world):
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
        params={"interest_source": "friends", "interest_kind": "any"},
    )
    assert r.status_code == 200
    ids = {e["event_id"] for e in r.json()}
    assert ids == {"evt-saved"}, "private attendance must not leak via interest filter"


def test_friends_only_account_hides_everything_from_one_way_follower(
    client, session, world
):
    alice = world["alice"]
    alice.account_visibility = "friends"
    session.add(alice)
    session.commit()
    _login(client, "carol@example.com")
    r = client.get(
        "/api/events",
        params={"interest_source": "follows", "interest_kind": "any"},
    )
    assert r.status_code == 200
    assert r.json() == []


# --- interest_user_handle (specific person) --------------------------------


def test_interest_user_handle_filters_to_named_user(client, world):
    _login(client, "alice@example.com")
    r = client.get(
        "/api/events",
        params={"interest_user_handle": "bob", "interest_kind": "any"},
    )
    assert r.status_code == 200
    ids = {e["event_id"] for e in r.json()}
    assert ids == {"evt-going", "evt-saved"}


def test_interest_user_handle_unknown_returns_empty_not_404(client, world):
    _login(client, "alice@example.com")
    r = client.get(
        "/api/events",
        params={"interest_user_handle": "ghost", "interest_kind": "any"},
    )
    assert r.status_code == 200, "unknown handle must not surface as 404"
    assert r.json() == []


def test_interest_user_handle_respects_visibility(client, session, world):
    alice = world["alice"]
    alice.account_visibility = "friends"
    session.add(alice)
    session.commit()
    _login(client, "carol@example.com")
    r = client.get(
        "/api/events",
        params={"interest_user_handle": "alice", "interest_kind": "any"},
    )
    assert r.status_code == 200
    assert r.json() == []


# --- Validation ------------------------------------------------------------


def test_invalid_interest_source_returns_400(client, world):
    _login(client, "alice@example.com")
    r = client.get(
        "/api/events",
        params={"interest_source": "bogus", "interest_kind": "any"},
    )
    assert r.status_code == 400


def test_invalid_interest_kind_returns_400(client, world):
    _login(client, "alice@example.com")
    r = client.get(
        "/api/events",
        params={"interest_source": "friends", "interest_kind": "bogus"},
    )
    assert r.status_code == 400
