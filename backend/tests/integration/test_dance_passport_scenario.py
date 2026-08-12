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

from datetime import date


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

        # Rich journey unlocks event, city, country and review milestones on the
        # first evaluation.
        for key in (
            "first_event",
            "events_5",
            "cities_5",
            "cities_10",
            "countries_3",
            "countries_5",
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

    def test_cusp_dedicated_unlocks_on_15th_event(self, seeded_session):
        dana = _user(seeded_session, "cusp-dedicated@example.com")
        ctx = passport_service.build_stats_context(seeded_session, dana)
        # Sits at exactly 14 attended events — one short of Dedicated (15).
        assert ctx["total_events"] == 14
        assert "events_15" not in passport_service.satisfied_keys(ctx)

        # Attend the spare 15th event, then re-evaluate: Dedicated unlocks.
        seeded_session.add(
            UserEventAttendance(
                device_id="test-dana-vol13",
                event_id="evt-vol-13",
                user_id=dana.id,
            )
        )
        seeded_session.commit()

        newly = passport_service.evaluate_and_persist(seeded_session, dana)
        assert "events_15" in newly

    def test_city_collection_carries_coordinates(self, seeded_session):
        alba = _user(seeded_session, "alba@example.com")
        ctx = passport_service.build_stats_context(seeded_session, alba)
        cols = passport_service.collections(ctx["events"])
        paris = next(c for c in cols["cities"] if c["city"] == "Paris")
        assert paris["latitude"] == 48.8566
        assert paris["longitude"] == 2.3522

    def test_alba_top_style_is_salsa(self, seeded_session):
        # Salsa is tagged on the most of Alba's attended events, so it is the
        # all-time "Top style" surfaced on the share card.
        alba = _user(seeded_session, "alba@example.com")
        ctx = passport_service.build_stats_context(seeded_session, alba)
        assert ctx["top_style"] == "Salsa"

    def test_alba_dancing_since_seeded(self, seeded_session):
        # The opt-in "Dancing since" origin is seeded from mock-users.yaml.
        alba = _user(seeded_session, "alba@example.com")
        assert alba.dancing_since == date(2018, 3, 15)

    def test_milestones_carry_prestige(self, seeded_session):
        alba = _user(seeded_session, "alba@example.com")
        passport_service.evaluate_and_persist(seeded_session, alba)
        ctx = passport_service.build_stats_context(seeded_session, alba)
        view = passport_service.milestone_view(seeded_session, alba, ctx)
        assert view, "expected milestones for alba"
        assert all(isinstance(m["prestige"], int) for m in view)
        # Prestige lets the card rank the most impressive badges first.
        events_100 = next(m for m in view if m["key"] == "events_100")
        first_event = next(m for m in view if m["key"] == "first_event")
        assert events_100["prestige"] > first_event["prestige"]

    def test_yara_multi_year_journey(self, seeded_session):
        # Yara's all-time journey spans a prior year + the current year, so her
        # totals exceed any single-year slice used by the year card.
        yara = _user(seeded_session, "yara@example.com")
        ctx = passport_service.build_stats_context(seeded_session, yara)
        assert ctx["total_events"] == 7
        assert len(ctx["cities"]) == 6  # Prague de-duplicated
        assert len(ctx["countries"]) == 4  # FR, CH, AT, CZ
        assert ctx["top_style"] == "Salsa"

    def _consistency(self, session, email):
        user = _user(session, email)
        ctx = passport_service.build_stats_context(session, user)
        return passport_service.consistency_context(ctx["events"])

    def test_consistent_user_reaches_first_level(self, seeded_session):
        # Cara: 3 active months -> Consistent, an open period, one earned card.
        c = self._consistency(seeded_session, "consistent@example.com")
        assert c["active"] is True
        assert c["active_months"] == 3
        assert [card["level_key"] for card in c["earned"]] == ["consistency_3"]
        assert c["top"]["key"] == "consistency_3"
        assert c["top"]["times"] == 1

    def test_committed_user_reaches_second_level(self, seeded_session):
        # Cole: 5 active months -> Committed (two earned cards).
        c = self._consistency(seeded_session, "committed@example.com")
        assert c["active_months"] == 5
        assert [card["level_key"] for card in c["earned"]] == [
            "consistency_3",
            "consistency_5",
        ]
        assert c["top"]["key"] == "consistency_5"

    def test_year_rounder_reaches_third_level(self, seeded_session):
        # Yuki: 8 active months -> Year-Rounder (three earned cards).
        c = self._consistency(seeded_session, "yearround@example.com")
        assert c["active_months"] == 8
        assert [card["level_key"] for card in c["earned"]] == [
            "consistency_3",
            "consistency_5",
            "consistency_8",
        ]
        assert c["top"]["key"] == "consistency_8"

    def test_below_entry_has_no_period(self, seeded_session):
        # Bo: 2 active months -> no period, only locked progress shown.
        c = self._consistency(seeded_session, "belowentry@example.com")
        assert c["active"] is False
        assert c["active_months"] == 2
        assert c["earned"] == []
        assert c["locked"][0]["key"] == "consistency_3"
        assert c["locked"][0]["active_months"] == 2

    def test_comeback_user_recurs_consistent(self, seeded_session):
        # Mira: an old lapsed 3-month period + a fresh Consistent reach ->
        # Consistent earned twice as two separate permanent cards.
        c = self._consistency(seeded_session, "comeback@example.com")
        assert c["active"] is True
        consistent_cards = [
            card for card in c["earned"] if card["level_key"] == "consistency_3"
        ]
        assert len(consistent_cards) == 2
        assert consistent_cards[0]["reached"] != consistent_cards[1]["reached"]
        assert c["top"]["key"] == "consistency_3"
        assert c["top"]["times"] == 2

    def test_dip_user_keeps_earned_after_cooling(self, seeded_session):
        # Nia: peaked at Year-Rounder (8) in one long period, then the two
        # oldest months aged out so the current rolling count cooled below the
        # peak. The earned cards persist and the all-time highlight stays put.
        c = self._consistency(seeded_session, "dip@example.com")
        assert c["active"] is True
        earned_keys = [card["level_key"] for card in c["earned"]]
        assert "consistency_8" in earned_keys  # Year-Rounder card persists
        assert c["active_months"] < 8  # current count has cooled below the peak
        assert c["top"]["key"] == "consistency_8"
        # Locked levels progress from the (lower) current count, not from 8.
        assert c["locked"][0]["active_months"] == c["active_months"]

    def test_consistency_persist_is_idempotent(self, seeded_session):
        # Recording a user's reaches is stable and re-runs are no-ops.
        cole = _user(seeded_session, "committed@example.com")
        first = passport_service.evaluate_and_persist_consistency(seeded_session, cole)
        keys = {r["key"] for r in first}
        assert "consistency_3" in keys and "consistency_5" in keys
        assert (
            passport_service.evaluate_and_persist_consistency(seeded_session, cole)
            == []
        )
