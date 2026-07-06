"""Tests for ``GET /api/events?profiles=me`` (union across user profiles).

Verifies that events are returned when they match ANY of the viewer's
UserInterestProfile rows on all three axes: bbox, dance_tag_ids
(when non-empty), and reach_tag_ids (when non-empty).
"""

import os
from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

os.environ.setdefault("SESSION_SECRET", "test-secret-profiles-filter")
os.environ.setdefault("ADMIN_EMAIL", "admin@example.com")
os.environ["DEV_AUTH"] = "true"

from backend.api.main import app  # noqa: E402
from backend.api.routes import auth as auth_module  # noqa: E402
from backend.api.routes import events as events_module  # noqa: E402
from backend.db.database import get_session  # noqa: E402
from backend.db.models import (  # noqa: E402
    CachedEvent,
    CalendarSetting,
    EventTag,
    SiteSetting,
    Tag,
    TagGroup,
    User,
    UserInterestProfile,
    UserInterestProfileTag,
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
    events_module.limiter.reset()
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def _login(client: TestClient, email: str) -> None:
    r = client.post(
        "/api/auth/google", json={"credential": "ignored", "mock_email": email}
    )
    assert r.status_code == 200, r.text


@pytest.fixture
def world(session):
    """Seeded tags, events, and a signed-in user with two profiles.

    Profile A: Paris bbox, dance=[salsa], reach=[local].
    Profile B: Madrid bbox, dance=[], reach=[international] (no dance
    filter = matches any dance for the bbox).

    Events:
      - evt-paris-salsa-local: matches profile A only
      - evt-madrid-any-intl:   matches profile B only
      - evt-berlin-salsa-intl: matches NEITHER (outside both bboxes)
      - evt-paris-bachata-local: OUTSIDE profile A (dance mismatch),
        outside profile B (bbox mismatch) — not returned
      - evt-nogeo:             excluded (no lat/lng)
    """
    session.add(SiteSetting(key="cutoff_date", value="2020-01-01"))
    session.add(CalendarSetting(calendar_id="cal-1", name="Salsa", enabled=True))

    dance_grp = TagGroup(slug="dance", label="Dance", ordinal=0, allow_multiple=True)
    reach_grp = TagGroup(slug="reach", label="Reach", ordinal=1, allow_multiple=True)
    session.add(dance_grp)
    session.add(reach_grp)
    session.commit()
    session.refresh(dance_grp)
    session.refresh(reach_grp)

    salsa = Tag(group_id=dance_grp.id, slug="salsa", label="Salsa", enabled=True)
    bachata = Tag(group_id=dance_grp.id, slug="bachata", label="Bachata", enabled=True)
    local = Tag(group_id=reach_grp.id, slug="local", label="Local", enabled=True)
    intl = Tag(
        group_id=reach_grp.id, slug="international", label="International", enabled=True
    )
    for t in (salsa, bachata, local, intl):
        session.add(t)
    session.commit()
    for t in (salsa, bachata, local, intl):
        session.refresh(t)

    base = datetime(2030, 1, 1, 20, 0, 0)

    def _add_event(eid: str, lat: float | None, lng: float | None, tags: list[Tag]):
        session.add(
            CachedEvent(
                event_id=eid,
                calendar_id="cal-1",
                title=eid,
                description="",
                location="",
                start=base,
                end=base + timedelta(hours=2),
                all_day=False,
                latitude=lat,
                longitude=lng,
            )
        )
        session.commit()
        for t in tags:
            session.add(EventTag(event_id=eid, tag_id=t.id))
        session.commit()

    _add_event("evt-paris-salsa-local", 48.85, 2.35, [salsa, local])
    _add_event("evt-madrid-any-intl", 40.42, -3.70, [bachata, intl])
    _add_event("evt-berlin-salsa-intl", 52.52, 13.40, [salsa, intl])
    _add_event("evt-paris-bachata-local", 48.85, 2.35, [bachata, local])
    _add_event("evt-nogeo", None, None, [salsa, intl])

    # Create the user directly (bypassing the signup route so we skip
    # the default-profile side-effect and can seed profiles exactly).
    user = User(
        email="nora@example.com",
        display_name="Nora",
        handle="nora",
        provider="google",
        provider_subject="mock|nora@example.com",
    )
    session.add(user)
    session.commit()
    session.refresh(user)

    profile_a = UserInterestProfile(
        user_id=user.id,
        label="Paris salsa local",
        min_lat=48.0,
        min_lng=2.0,
        max_lat=49.0,
        max_lng=3.0,
        matches_enabled=True,
        is_active=True,
    )
    profile_b = UserInterestProfile(
        user_id=user.id,
        label="Madrid intl",
        min_lat=40.0,
        min_lng=-4.0,
        max_lat=41.0,
        max_lng=-3.0,
        matches_enabled=True,
        is_active=False,
    )
    session.add(profile_a)
    session.add(profile_b)
    session.commit()
    session.refresh(profile_a)
    session.refresh(profile_b)

    session.add(UserInterestProfileTag(profile_id=profile_a.id, tag_id=salsa.id))
    session.add(UserInterestProfileTag(profile_id=profile_a.id, tag_id=local.id))
    session.add(UserInterestProfileTag(profile_id=profile_b.id, tag_id=intl.id))
    session.commit()

    return {"user": user, "profile_a": profile_a, "profile_b": profile_b}


def test_profiles_me_returns_union_across_profiles(client, world):
    _login(client, "nora@example.com")
    r = client.get("/api/events", params={"profiles": "me"})
    assert r.status_code == 200, r.text
    returned = {e["event_id"] for e in r.json()}
    assert returned == {"evt-paris-salsa-local", "evt-madrid-any-intl"}


def test_profiles_me_anonymous_returns_empty(client, world):
    r = client.get("/api/events", params={"profiles": "me"})
    assert r.status_code == 200
    assert r.json() == []


def test_profiles_invalid_value_returns_400(client, world):
    _login(client, "nora@example.com")
    r = client.get("/api/events", params={"profiles": "other"})
    assert r.status_code == 400


def test_profiles_me_with_no_profiles_returns_empty(client, session):
    """A user who somehow has zero profiles gets an empty result."""
    session.add(SiteSetting(key="cutoff_date", value="2020-01-01"))
    session.add(CalendarSetting(calendar_id="cal-1", name="Salsa", enabled=True))
    session.commit()
    _login(client, "empty@example.com")
    # Drop the auto-seeded default.
    listing = client.get("/api/interest-profiles").json()
    for row in listing:
        client.delete(f"/api/interest-profiles/{row['id']}")
    r = client.get("/api/events", params={"profiles": "me"})
    assert r.status_code == 200
    assert r.json() == []
