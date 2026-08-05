"""Scenario integration test — seeds the dance-passport scenario and asserts
the passport aggregation matches the documented expected outcomes.

This ties the scenario data to the passport service so the E2E numbers in
scenarios/dance-passport/test_plan.yaml stay honest.
"""

import pytest
from sqlmodel import Session, SQLModel, create_engine, select

from backend.db import seed as seed_module
from backend.db.models import User, UserEventAttendance
from backend.db.seed import SCENARIOS_DIR, DatabaseSeeder
from backend.services import passport as passport_service


@pytest.fixture()
def seeded_session(monkeypatch):
    # Force the mock-calendar branch so db-events.yaml is the source of truth.
    monkeypatch.setattr(
        "backend.config.loader.get_calendar_service_type", lambda: "mock"
    )
    engine = create_engine("sqlite://")
    SQLModel.metadata.create_all(engine)
    with Session(engine) as session:
        DatabaseSeeder(session).seed(SCENARIOS_DIR / "dance-passport")
        yield session


def _user(session, email):
    return session.exec(select(User).where(User.email == email)).one()


@pytest.mark.unit
class TestDancePassportScenario:
    def test_scenario_dir_exists(self):
        scenario = SCENARIOS_DIR / "dance-passport"
        assert scenario.exists()
        for f in (
            "config.env",
            "calendars.yaml",
            "mock-users.yaml",
            "db-events.yaml",
            "db-attendances.yaml",
            "test_plan.yaml",
        ):
            assert (scenario / f).exists(), f"missing {f}"

    def test_alba_rich_journey(self, seeded_session):
        alba = _user(seeded_session, "alba@example.com")
        ctx = passport_service.build_stats_context(seeded_session, alba)

        assert ctx["total_events"] == 13  # 12 geo + 1 null-geo
        assert len(ctx["cities"]) == 11  # Paris de-duplicated
        assert len(ctx["countries"]) == 7
        assert ctx["reviews"] == 10  # rejected review excluded
        assert len(ctx["styles"]) == 4  # salsa, bachata, kizomba, zouk
        assert ctx["has_international"] is True

        cols = passport_service.collections(ctx["events"])
        paris = next(c for c in cols["cities"] if c["city"] == "Paris")
        assert paris["count"] == 2
        assert all(c["city"] != "Nice" for c in cols["cities"])  # anon excluded

    def test_borderline_boundary(self, seeded_session):
        bram = _user(seeded_session, "borderline@example.com")
        ctx = passport_service.build_stats_context(seeded_session, bram)

        assert ctx["total_events"] == 10
        assert len(ctx["cities"]) == 9
        assert len(ctx["countries"]) == 5
        assert ctx["reviews"] == 10

    def test_novice_minimal(self, seeded_session):
        nadia = _user(seeded_session, "novice@example.com")
        ctx = passport_service.build_stats_context(seeded_session, nadia)

        assert ctx["total_events"] == 1
        assert ctx["reviews"] == 0

    def test_future_only_and_bystander_empty(self, seeded_session):
        for email in ("future-only@example.com", "bystander@example.com"):
            user = _user(seeded_session, email)
            ctx = passport_service.build_stats_context(seeded_session, user)
            assert ctx["total_events"] == 0
            assert ctx["cities"] == set()

    def test_alba_unlocks_core_and_extra_milestones(self, seeded_session):
        alba = _user(seeded_session, "alba@example.com")
        newly = passport_service.evaluate_and_persist(seeded_session, alba)

        # Rich journey unlocks event, city, country, review and international
        # milestones on the first evaluation.
        for key in (
            "first_event",
            "events_10",
            "cities_5",
            "cities_10",
            "countries_3",
            "countries_5",
            "first_international",
            "first_review",
            "reviews_10",
        ):
            assert key in newly, f"expected {key} unlocked for alba"

        # A second evaluation is a no-op.
        assert passport_service.evaluate_and_persist(seeded_session, alba) == []

    def test_novice_unlocks_only_first_event(self, seeded_session):
        nadia = _user(seeded_session, "novice@example.com")
        newly = passport_service.evaluate_and_persist(seeded_session, nadia)

        assert newly == ["first_event"]

    def test_cusp_dedicated_unlocks_on_25th_event(self, seeded_session):
        dana = _user(seeded_session, "cusp-dedicated@example.com")
        ctx = passport_service.build_stats_context(seeded_session, dana)
        # Sits at exactly 24 attended events — one short of Dedicated (25).
        assert ctx["total_events"] == 24
        assert "events_25" not in passport_service.satisfied_keys(ctx)

        # Attend the spare 25th event, then re-evaluate: Dedicated unlocks.
        seeded_session.add(
            UserEventAttendance(
                device_id="test-dana-vol13",
                event_id="evt-vol-13",
                user_id=dana.id,
            )
        )
        seeded_session.commit()

        newly = passport_service.evaluate_and_persist(seeded_session, dana)
        assert "events_25" in newly

    def test_city_collection_carries_coordinates(self, seeded_session):
        alba = _user(seeded_session, "alba@example.com")
        ctx = passport_service.build_stats_context(seeded_session, alba)
        cols = passport_service.collections(ctx["events"])
        paris = next(c for c in cols["cities"] if c["city"] == "Paris")
        assert paris["latitude"] == 48.8566
        assert paris["longitude"] == 2.3522
