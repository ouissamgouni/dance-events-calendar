"""Tests for ``GET /api/events/popular-cities`` (onboarding local-area pills).

The endpoint aggregates upcoming, non-deleted, non-hidden ``CachedEvent``
rows by ``(city, country)`` ordered by event count, returning an averaged
lat/lng pin per city. Rows missing a city name or coordinates, plus past
and hidden events, are excluded so a pill can never resolve to an empty map.
"""

import os
from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

os.environ.setdefault("SESSION_SECRET", "test-secret-popular-cities")
os.environ.setdefault("ADMIN_EMAIL", "admin@example.com")
os.environ["DEV_AUTH"] = "true"

from backend.api.main import app  # noqa: E402
from backend.api.routes import events as events_module  # noqa: E402
from backend.db.database import get_session  # noqa: E402
from backend.db.models import CachedEvent  # noqa: E402


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
    events_module.limiter.reset()
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def _event(
    session: Session,
    event_id: str,
    *,
    start: datetime,
    city=None,
    country=None,
    latitude=None,
    longitude=None,
    is_hidden: bool = False,
    deleted_at=None,
) -> None:
    session.add(
        CachedEvent(
            event_id=event_id,
            calendar_id="cal-1",
            title=event_id,
            description="",
            location="",
            start=start,
            end=start + timedelta(hours=2),
            all_day=False,
            city=city,
            country=country,
            latitude=latitude,
            longitude=longitude,
            is_hidden=is_hidden,
            deleted_at=deleted_at,
        )
    )
    session.commit()


def test_popular_cities_ranks_by_upcoming_count(client, session):
    future = datetime.utcnow() + timedelta(days=5)
    # Paris: two upcoming events -> should rank first, pin = averaged coords.
    _event(
        session,
        "p1",
        start=future,
        city="Paris",
        country="FR",
        latitude=48.8,
        longitude=2.3,
    )
    _event(
        session,
        "p2",
        start=future + timedelta(days=1),
        city="Paris",
        country="FR",
        latitude=48.9,
        longitude=2.5,
    )
    # London: one upcoming event.
    _event(
        session,
        "l1",
        start=future,
        city="London",
        country="GB",
        latitude=51.5,
        longitude=-0.1,
    )

    r = client.get("/api/events/popular-cities")
    assert r.status_code == 200, r.text
    body = r.json()
    assert [c["city"] for c in body] == ["Paris", "London"]

    paris = body[0]
    assert paris["country"] == "FR"
    assert paris["count"] == 2
    assert paris["lat"] == pytest.approx(48.85)
    assert paris["lng"] == pytest.approx(2.4)


def test_popular_cities_excludes_past_hidden_and_incomplete(client, session):
    future = datetime.utcnow() + timedelta(days=5)
    past = datetime.utcnow() - timedelta(days=5)
    # Excluded: past, hidden, soft-deleted, missing city, missing coords.
    _event(
        session,
        "past",
        start=past,
        city="Berlin",
        country="DE",
        latitude=52.5,
        longitude=13.4,
    )
    _event(
        session,
        "hidden",
        start=future,
        city="Berlin",
        country="DE",
        latitude=52.5,
        longitude=13.4,
        is_hidden=True,
    )
    _event(
        session,
        "deleted",
        start=future,
        city="Berlin",
        country="DE",
        latitude=52.5,
        longitude=13.4,
        deleted_at=datetime.utcnow(),
    )
    _event(
        session,
        "nocity",
        start=future,
        city=None,
        country="DE",
        latitude=52.5,
        longitude=13.4,
    )
    _event(
        session,
        "nocoords",
        start=future,
        city="Berlin",
        country="DE",
        latitude=None,
        longitude=None,
    )
    # Included: a single valid upcoming Madrid event.
    _event(
        session,
        "ok",
        start=future,
        city="Madrid",
        country="ES",
        latitude=40.4,
        longitude=-3.7,
    )

    r = client.get("/api/events/popular-cities")
    assert r.status_code == 200, r.text
    body = r.json()
    assert [c["city"] for c in body] == ["Madrid"]


def test_popular_cities_respects_limit(client, session):
    future = datetime.utcnow() + timedelta(days=5)
    for i, name in enumerate(("A", "B", "C")):
        _event(
            session,
            f"e{i}",
            start=future,
            city=name,
            country="XX",
            latitude=1.0 + i,
            longitude=1.0 + i,
        )

    r = client.get("/api/events/popular-cities?limit=2")
    assert r.status_code == 200, r.text
    assert len(r.json()) == 2
