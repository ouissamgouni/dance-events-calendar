"""Unit tests for the reverse-geocoding backfill script (Phase E)."""

import os

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

os.environ.setdefault("SESSION_SECRET", "test-secret-backfill-geo")

from backend.db import database as database_module  # noqa: E402
from backend.db.models import CachedEvent  # noqa: E402
from backend.scripts import backfill_geo  # noqa: E402


@pytest.fixture
def engine():
    eng = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(eng)
    prev = database_module._engine
    database_module._engine = eng
    yield eng
    database_module._engine = prev
    SQLModel.metadata.drop_all(eng)


def _event(engine, event_id, *, latitude, longitude, country=None):
    from datetime import datetime, timedelta

    start = datetime(2026, 1, 1, 20, 0)
    with Session(engine) as s:
        s.add(
            CachedEvent(
                event_id=event_id,
                calendar_id="cal-1",
                title=event_id,
                location="Somewhere",
                start=start,
                end=start + timedelta(hours=2),
                latitude=latitude,
                longitude=longitude,
                country=country,
            )
        )
        s.commit()


@pytest.mark.unit
class TestBackfillGeo:
    def test_commit_fills_place_for_events_missing_country(self, engine, monkeypatch):
        _event(engine, "evt-fill", latitude=48.86, longitude=2.35)
        _event(
            engine, "evt-has-country", latitude=52.52, longitude=13.4, country="Germany"
        )
        _event(engine, "evt-no-coords", latitude=None, longitude=None)

        monkeypatch.setattr(
            backfill_geo, "reverse_geocode", lambda lat, lng: ("Paris", "France", "FR")
        )
        monkeypatch.setattr("sys.argv", ["backfill_geo", "--commit"])

        backfill_geo.main()

        with Session(engine) as s:
            filled = s.get(CachedEvent, "evt-fill")
            assert filled.city == "Paris"
            assert filled.country == "France"
            assert filled.country_code == "FR"
            # Already-resolved and coordinate-less events are untouched.
            assert s.get(CachedEvent, "evt-has-country").country == "Germany"
            assert s.get(CachedEvent, "evt-no-coords").country is None

    def test_dry_run_writes_nothing(self, engine, monkeypatch):
        _event(engine, "evt-dry", latitude=41.9, longitude=12.5)

        monkeypatch.setattr(
            backfill_geo, "reverse_geocode", lambda lat, lng: ("Rome", "Italy", "IT")
        )
        monkeypatch.setattr("sys.argv", ["backfill_geo", "--dry-run"])

        backfill_geo.main()

        with Session(engine) as s:
            assert s.get(CachedEvent, "evt-dry").country is None

    def test_unresolved_event_is_left_untouched(self, engine, monkeypatch):
        _event(engine, "evt-unresolved", latitude=0.0, longitude=0.0)

        monkeypatch.setattr(backfill_geo, "reverse_geocode", lambda lat, lng: None)
        monkeypatch.setattr("sys.argv", ["backfill_geo", "--commit"])

        backfill_geo.main()

        with Session(engine) as s:
            row = s.get(CachedEvent, "evt-unresolved")
            assert row.city is None
            assert row.country is None

    def test_refresh_overwrites_events_that_already_have_country(
        self, engine, monkeypatch
    ):
        _event(engine, "evt-stale", latitude=52.52, longitude=13.4, country="Germany")
        _event(engine, "evt-no-coords", latitude=None, longitude=None)

        monkeypatch.setattr(
            backfill_geo,
            "reverse_geocode",
            lambda lat, lng: ("Berlin", "Germany", "DE"),
        )
        monkeypatch.setattr("sys.argv", ["backfill_geo", "--commit", "--refresh"])

        backfill_geo.main()

        with Session(engine) as s:
            stale = s.get(CachedEvent, "evt-stale")
            assert stale.city == "Berlin"
            assert stale.country_code == "DE"
            # Coordinate-less events are still skipped even with --refresh.
            assert s.get(CachedEvent, "evt-no-coords").country is None
