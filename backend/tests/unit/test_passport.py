"""Unit tests for the Dance Passport stats aggregation service."""

from datetime import datetime, timedelta

import pytest
from sqlmodel import Session, SQLModel, create_engine

from backend.db.models import (
    CachedEvent,
    EventRating,
    EventTag,
    Tag,
    TagGroup,
    User,
    UserConsistencyAchievement,
    UserEventAttendance,
)
from backend.services import passport as passport_service
from sqlmodel import select

NOW = datetime.utcnow()


def _past(days: int) -> datetime:
    return NOW - timedelta(days=days)


def _future(days: int) -> datetime:
    return NOW + timedelta(days=days)


@pytest.fixture()
def session():
    engine = create_engine("sqlite://")
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        yield s


def _event(session, event_id, start, *, city=None, country=None):
    evt = CachedEvent(
        event_id=event_id,
        calendar_id="cal-1",
        title=f"Event {event_id}",
        start=start,
        end=start + timedelta(hours=3),
        city=city,
        country=country,
    )
    session.add(evt)
    return evt


def _going(session, user_id, event_id, *, device_id=None):
    session.add(
        UserEventAttendance(
            device_id=device_id or f"dev-{user_id}-{event_id}",
            event_id=event_id,
            user_id=user_id,
        )
    )


def _review(session, user_id, event_id, *, status="approved", created_at=None):
    session.add(
        EventRating(
            event_id=event_id,
            user_id=user_id,
            stars=4,
            status=status,
            created_at=created_at or datetime.utcnow(),
        )
    )


@pytest.mark.unit
class TestAttendedEvents:
    def test_only_past_going_events_count(self, session):
        user = User(email="a@example.com")
        session.add(user)
        _event(session, "past-1", _past(10))
        _event(session, "future-1", _future(10))
        _going(session, user.id, "past-1")
        _going(session, user.id, "future-1")
        session.commit()

        events = passport_service.attended_events(session, user.id)

        assert [e.event_id for e in events] == ["past-1"]

    def test_not_going_events_excluded(self, session):
        user = User(email="a@example.com")
        session.add(user)
        _event(session, "past-1", _past(10))
        # No attendance row -> not going -> excluded.
        session.commit()

        events = passport_service.attended_events(session, user.id)

        assert events == []

    def test_anonymous_device_attendance_excluded(self, session):
        user = User(email="a@example.com")
        session.add(user)
        _event(session, "past-1", _past(10))
        # Anonymous attendance has user_id=None.
        session.add(
            UserEventAttendance(device_id="anon-dev", event_id="past-1", user_id=None)
        )
        session.commit()

        events = passport_service.attended_events(session, user.id)

        assert events == []

    def test_ordered_newest_first(self, session):
        user = User(email="a@example.com")
        session.add(user)
        _event(session, "older", _past(30))
        _event(session, "newer", _past(2))
        _going(session, user.id, "older")
        _going(session, user.id, "newer")
        session.commit()

        events = passport_service.attended_events(session, user.id)

        assert [e.event_id for e in events] == ["newer", "older"]


@pytest.mark.unit
class TestStatsContext:
    def test_distinct_cities_and_countries(self, session):
        user = User(email="a@example.com")
        session.add(user)
        # Two events in the same city dedupe to one city.
        _event(session, "e1", _past(30), city="Paris", country="France")
        _event(session, "e2", _past(20), city="Paris", country="France")
        _event(session, "e3", _past(10), city="Berlin", country="Germany")
        for eid in ("e1", "e2", "e3"):
            _going(session, user.id, eid)
        session.commit()

        ctx = passport_service.build_stats_context(session, user)

        assert ctx["total_events"] == 3
        assert len(ctx["cities"]) == 2
        assert len(ctx["countries"]) == 2

    def test_null_geo_event_counts_as_event_not_place(self, session):
        user = User(email="a@example.com")
        session.add(user)
        _event(session, "e1", _past(30), city="Paris", country="France")
        _event(session, "e2", _past(10))  # null city/country
        _going(session, user.id, "e1")
        _going(session, user.id, "e2")
        session.commit()

        ctx = passport_service.build_stats_context(session, user)

        assert ctx["total_events"] == 2
        assert len(ctx["cities"]) == 1
        assert len(ctx["countries"]) == 1

    def test_reviews_count_excludes_rejected(self, session):
        user = User(email="a@example.com")
        session.add(user)
        _event(session, "e1", _past(30))
        _event(session, "e2", _past(20))
        _going(session, user.id, "e1")
        _going(session, user.id, "e2")
        _review(session, user.id, "e1", status="approved")
        _review(session, user.id, "e2", status="rejected")
        session.commit()

        ctx = passport_service.build_stats_context(session, user)

        assert ctx["reviews"] == 1

    def test_empty_passport_has_zero_stats(self, session):
        user = User(email="a@example.com")
        session.add(user)
        session.commit()

        ctx = passport_service.build_stats_context(session, user)

        assert ctx["total_events"] == 0
        assert ctx["cities"] == set()
        assert ctx["countries"] == set()
        assert ctx["reviews"] == 0
        assert ctx["active_months_last_12"] == 0
        assert ctx["active_months_this_year"] == 0
        assert ctx["first_event_date"] is None


@pytest.mark.unit
class TestConsistency:
    """Recurring consistency achievements (rolling 12-month active months).

    A month is "active" when it has >=1 attended event; a period opens when the
    rolling active-month count first reaches 3 and closes when it drops below 3.
    Every level recurs across distinct periods.
    """

    @staticmethod
    def _month_dt(rel: int) -> datetime:
        """Datetime in the middle of relative month ``rel`` (0 = 2024-01)."""
        year = 2024 + rel // 12
        month = rel % 12 + 1
        return datetime(year, month, 15)

    def _ev(self, rel: int) -> CachedEvent:
        dt = self._month_dt(rel)
        return CachedEvent(
            event_id=f"e{rel}",
            calendar_id="c",
            title="e",
            start=dt,
            end=dt,
        )

    def test_active_month_indices_and_rolling_count(self):
        events = [self._ev(0), self._ev(0), self._ev(2), self._ev(5)]
        months = passport_service.active_month_indices(events)
        # Duplicate month collapses to a single active month.
        assert len(months) == 3
        at = passport_service._month_index(self._month_dt(5))
        assert passport_service.rolling_active_count(months, at) == 3

    def test_monthly_activity_counts_events_per_month(self):
        # rel 0 = 2024-01 (x2), rel 2 = 2024-03 (x1), rel 5 = 2024-06 (x1).
        events = [self._ev(0), self._ev(0), self._ev(2), self._ev(5)]
        assert passport_service.monthly_activity(events) == [
            {"month": "2024-01", "count": 2},
            {"month": "2024-03", "count": 1},
            {"month": "2024-06", "count": 1},
        ]

    def test_monthly_activity_empty(self):
        assert passport_service.monthly_activity([]) == []

    def test_first_consistent_opens_period(self):
        events = [self._ev(0), self._ev(1), self._ev(2)]
        ctx = passport_service.consistency_context(events, now=self._month_dt(2))
        assert ctx["active"] is True
        assert ctx["active_months"] == 3
        # One earned card, Consistent, labelled with its contributing period.
        assert [c["level_key"] for c in ctx["earned"]] == ["consistency_3"]
        card = ctx["earned"][0]
        assert card["period_start"] == "2024-01"
        assert card["reached"] == "2024-03"
        assert card["is_current"] is True
        # Remaining levels are locked, progressing from the current count.
        assert [c["key"] for c in ctx["locked"]] == [
            "consistency_5",
            "consistency_8",
            "consistency_10",
            "consistency_12",
        ]
        assert ctx["locked"][0]["active_months"] == 3
        # Consistent reached exactly once so far.
        top = ctx["top"]
        assert top["key"] == "consistency_3"
        assert top["threshold"] == 3
        assert top["times"] == 1

    def test_committed_level(self):
        events = [self._ev(i) for i in range(5)]
        ctx = passport_service.consistency_context(events, now=self._month_dt(4))
        assert ctx["active_months"] == 5
        assert [c["level_key"] for c in ctx["earned"]] == [
            "consistency_3",
            "consistency_5",
        ]
        assert ctx["top"]["key"] == "consistency_5"
        assert ctx["top"]["threshold"] == 5

    def test_year_rounder_level(self):
        events = [self._ev(i) for i in range(8)]
        ctx = passport_service.consistency_context(events, now=self._month_dt(7))
        assert ctx["active_months"] == 8
        assert [c["level_key"] for c in ctx["earned"]] == [
            "consistency_3",
            "consistency_5",
            "consistency_8",
        ]
        assert [c["key"] for c in ctx["locked"]] == [
            "consistency_10",
            "consistency_12",
        ]
        assert ctx["top"]["key"] == "consistency_8"

    def test_below_entry_shows_locked_progress(self):
        events = [self._ev(0), self._ev(1)]
        ctx = passport_service.consistency_context(events, now=self._month_dt(1))
        assert ctx["active"] is False
        assert ctx["earned"] == []
        # Every level is locked, progressing from the current count of 2.
        assert [c["key"] for c in ctx["locked"]] == [
            "consistency_3",
            "consistency_5",
            "consistency_8",
            "consistency_10",
            "consistency_12",
        ]
        assert ctx["locked"][0]["active_months"] == 2
        assert ctx["top"] is None

    def test_decrease_keeps_earned_cards(self):
        # Five active months early, then a dry spell so the rolling count falls
        # back to 3 (but never below) — the period stays open and the cards
        # already earned up to the peak persist.
        events = [self._ev(i) for i in range(5)]
        ctx = passport_service.consistency_context(events, now=self._month_dt(13))
        assert ctx["active"] is True
        assert ctx["active_months"] == 3
        assert [c["level_key"] for c in ctx["earned"]] == [
            "consistency_3",
            "consistency_5",
        ]
        # Locked levels progress from the (lower) current count.
        assert [c["key"] for c in ctx["locked"]] == [
            "consistency_8",
            "consistency_10",
            "consistency_12",
        ]
        assert ctx["locked"][0]["active_months"] == 3
        # All-time highlight keeps the strongest level ever reached.
        assert ctx["top"]["key"] == "consistency_5"

    def test_comeback_recurs_as_two_cards(self):
        # Period 1 (months 0-2) reaches Consistent, then a long gap closes it;
        # Period 2 (months 30-32) reaches Consistent again.
        events = [self._ev(i) for i in (0, 1, 2, 30, 31, 32)]
        ctx = passport_service.consistency_context(events, now=self._month_dt(32))
        consistent_cards = [
            c for c in ctx["earned"] if c["level_key"] == "consistency_3"
        ]
        # Two separate permanent cards — never collapsed into one "×2" card.
        assert len(consistent_cards) == 2
        assert consistent_cards[0]["reached"] != consistent_cards[1]["reached"]
        assert ctx["top"]["key"] == "consistency_3"
        assert ctx["top"]["times"] == 2

    def test_by_year_classifies_each_calendar_year_independently(self):
        # 3 active months in 2024, 5 in 2025.
        events = [self._ev(i) for i in (0, 1, 2, 12, 13, 14, 15, 16)]
        ctx = passport_service.consistency_context(events, now=self._month_dt(16))
        by_year = {y["year"]: y for y in ctx["by_year"]}
        assert by_year[2024]["active_months"] == 3
        assert by_year[2024]["key"] == "consistency_3"
        assert by_year[2025]["active_months"] == 5
        assert by_year[2025]["key"] == "consistency_5"

    def test_timeline_markers_recur_per_period(self):
        events = [self._ev(i) for i in (0, 1, 2, 30, 31, 32)]
        markers = passport_service.consistency_timeline_markers(
            events, now=self._month_dt(32)
        )
        keys = [m["key"] for m in markers]
        # One Consistent reach per period, each carrying its period start.
        consistent_markers = [k for k in keys if k.startswith("consistency_3:")]
        assert len(consistent_markers) == 2

    def test_cancelled_attendance_prunes_earned_achievement(self, session):
        user = User(email="dip@example.com")
        session.add(user)
        for rel in (0, 1, 2):
            _event(session, f"cd{rel}", self._month_dt(rel))
            _going(session, user.id, f"cd{rel}")
        session.commit()
        now = self._month_dt(2)
        passport_service.evaluate_and_persist_consistency(session, user, now=now)
        rows = session.exec(
            select(UserConsistencyAchievement).where(
                UserConsistencyAchievement.user_id == user.id
            )
        ).all()
        assert {r.level_key for r in rows} == {"consistency_3"}

        # Cancel one month → only 2 active months remain → the period no longer
        # exists, so its earned achievement is pruned (data-correction policy).
        att = session.exec(
            select(UserEventAttendance).where(UserEventAttendance.event_id == "cd2")
        ).first()
        session.delete(att)
        session.commit()
        passport_service.evaluate_and_persist_consistency(session, user, now=now)
        rows = session.exec(
            select(UserConsistencyAchievement).where(
                UserConsistencyAchievement.user_id == user.id
            )
        ).all()
        assert rows == []

    def test_empty_has_no_period(self):
        ctx = passport_service.consistency_context([], now=self._month_dt(0))
        assert ctx["active"] is False
        assert ctx["active_months"] == 0
        assert ctx["earned"] == []
        assert ctx["top"] is None


@pytest.mark.unit
class TestConsistencyPersistence:
    """DB-backed dedupe of consistency reaches for toast/notification."""

    @staticmethod
    def _month_dt(rel: int) -> datetime:
        year = 2024 + rel // 12
        month = rel % 12 + 1
        return datetime(year, month, 15)

    def _attend(self, session, user, rel: int) -> None:
        dt = self._month_dt(rel)
        event = CachedEvent(
            event_id=f"e{rel}",
            calendar_id="c",
            title="e",
            start=dt,
            end=dt,
        )
        session.add(event)
        session.add(
            UserEventAttendance(
                device_id=f"dev-{user.id}-{rel}",
                user_id=user.id,
                event_id=event.event_id,
            )
        )
        session.commit()

    def test_persist_is_idempotent_and_view_flags_new(self, session):
        user = User(email="c@example.com")
        session.add(user)
        session.commit()
        for rel in range(3):
            self._attend(session, user, rel)

        newly = passport_service.evaluate_and_persist_consistency(
            session, user, now=self._month_dt(2)
        )
        assert any(r["key"] == "consistency_3" for r in newly)

        # Second pass records nothing new.
        again = passport_service.evaluate_and_persist_consistency(
            session, user, now=self._month_dt(2)
        )
        assert again == []

        view = passport_service.consistency_view(session, user, now=self._month_dt(2))
        assert any(n["key"] == "consistency_3" for n in view["new"])

        # Acknowledging clears the unseen reach.
        idents = [f"{n['key']}:{n['period_start']}" for n in view["new"]]
        marked = passport_service.acknowledge_consistency(session, user, idents)
        assert marked == len(idents)
        view2 = passport_service.consistency_view(session, user, now=self._month_dt(2))
        assert view2["new"] == []


@pytest.mark.unit
class TestCollections:
    def test_grouped_counts_sorted(self):
        events = [
            CachedEvent(
                event_id="a",
                calendar_id="c",
                title="a",
                city="Paris",
                country="France",
                latitude=48.85,
                longitude=2.35,
                start=NOW,
                end=NOW,
            ),
            CachedEvent(
                event_id="b",
                calendar_id="c",
                title="b",
                city="Paris",
                country="France",
                start=NOW,
                end=NOW,
            ),
            CachedEvent(
                event_id="c",
                calendar_id="c",
                title="c",
                city="Berlin",
                country="Germany",
                start=NOW,
                end=NOW,
            ),
        ]
        result = passport_service.collections(events)

        assert result["cities"][0] == {
            "city": "Paris",
            "country": "France",
            "count": 2,
            "latitude": 48.85,
            "longitude": 2.35,
        }
        assert result["countries"][0] == {"country": "France", "count": 2}

    def test_city_without_coords_has_none(self):
        events = [
            CachedEvent(
                event_id="a",
                calendar_id="c",
                title="a",
                city="Nowhere",
                country="Nowhereland",
                start=NOW,
                end=NOW,
            ),
        ]
        result = passport_service.collections(events)

        assert result["cities"][0]["latitude"] is None
        assert result["cities"][0]["longitude"] is None


def _attend_n(session, user_id, n, *, city_prefix="City", country="France"):
    """Attend N distinct past events, each in a distinct city."""
    for i in range(n):
        eid = f"ev-{i}"
        _event(
            session, eid, _past(n - i + 1), city=f"{city_prefix}-{i}", country=country
        )
        _going(session, user_id, eid)


@pytest.mark.unit
class TestMilestones:
    def test_first_event_unlocks(self, session):
        user = User(email="a@example.com")
        session.add(user)
        _event(session, "e1", _past(10), city="Paris", country="France")
        _going(session, user.id, "e1")
        session.commit()

        newly = passport_service.evaluate_and_persist(session, user)

        assert "first_event" in newly
        assert "events_5" not in newly

    def test_events_5_threshold(self, session):
        user = User(email="a@example.com")
        session.add(user)
        _attend_n(session, user.id, 10)
        session.commit()

        newly = passport_service.evaluate_and_persist(session, user)

        assert "first_event" in newly
        assert "events_5" in newly
        assert "events_15" not in newly
        assert "cities_5" in newly  # 10 distinct cities
        assert "cities_10" in newly

    def test_evaluate_is_idempotent(self, session):
        user = User(email="a@example.com")
        session.add(user)
        _attend_n(session, user.id, 3)
        session.commit()

        first = passport_service.evaluate_and_persist(session, user)
        second = passport_service.evaluate_and_persist(session, user)

        assert "first_event" in first
        assert second == []  # nothing new the second time

    def test_milestone_view_is_new_then_acked(self, session):
        user = User(email="a@example.com")
        session.add(user)
        _event(session, "e1", _past(10), city="Paris", country="France")
        _going(session, user.id, "e1")
        session.commit()

        passport_service.evaluate_and_persist(session, user)
        ctx = passport_service.build_stats_context(session, user)
        view = passport_service.milestone_view(session, user, ctx)
        first = next(m for m in view if m["key"] == "first_event")
        assert first["unlocked"] is True
        assert first["is_new"] is True
        assert first["unit"] == "events"
        assert (
            first["prestige"]
            == passport_service.MILESTONES_BY_KEY["first_event"].prestige
        )

        acked = passport_service.acknowledge_milestones(session, user, ["first_event"])
        assert acked == 1
        # Second ack is a no-op.
        assert (
            passport_service.acknowledge_milestones(session, user, ["first_event"]) == 0
        )

        view2 = passport_service.milestone_view(session, user, ctx)
        first2 = next(m for m in view2 if m["key"] == "first_event")
        assert first2["is_new"] is False

    def test_locked_milestone_reports_progress(self, session):
        user = User(email="a@example.com")
        session.add(user)
        _attend_n(session, user.id, 3)
        session.commit()

        ctx = passport_service.build_stats_context(session, user)
        view = passport_service.milestone_view(session, user, ctx)
        events_5 = next(m for m in view if m["key"] == "events_5")
        assert events_5["unlocked"] is False
        assert events_5["progress"] == 3
        assert events_5["threshold"] == 5


@pytest.mark.unit
class TestCatalog:
    def test_globetrotter_is_ten_countries(self):
        m = passport_service.MILESTONES_BY_KEY["countries_10"]
        assert m.name == "Globetrotter"
        assert m.category == "countries"
        assert m.threshold == 10

    def test_cities_ten_is_city_explorer(self):
        m = passport_service.MILESTONES_BY_KEY["cities_10"]
        assert m.name == "City Explorer"
        assert m.category == "cities"

    def test_every_milestone_has_prestige(self):
        for m in passport_service.MILESTONES:
            assert isinstance(m.prestige, int)
            assert 1 <= m.prestige <= 100

    def test_every_milestone_has_achieved_description(self):
        for m in passport_service.MILESTONES:
            assert isinstance(m.achieved_description, str)
            assert m.achieved_description

    def test_capstone_milestones_outrank_first_steps(self):
        first = passport_service.MILESTONES_BY_KEY["first_event"].prestige
        assert passport_service.MILESTONES_BY_KEY["events_100"].prestige > first
        assert passport_service.MILESTONES_BY_KEY["countries_10"].prestige > first


def _style_tag(session, group, slug, label, *, ordinal=0):
    tag = Tag(group_id=group.id, slug=slug, label=label, ordinal=ordinal)
    session.add(tag)
    session.commit()
    return tag


@pytest.mark.unit
class TestTopStyle:
    def test_returns_most_attended_style_label(self, session):
        user = User(email="a@example.com")
        session.add(user)
        group = TagGroup(slug="dance-style", label="Dance style")
        session.add(group)
        session.commit()
        salsa = _style_tag(session, group, "salsa", "Salsa", ordinal=0)
        bachata = _style_tag(session, group, "bachata", "Bachata", ordinal=1)
        for i in range(3):
            eid = f"salsa-{i}"
            _event(session, eid, _past(30 - i))
            session.add(EventTag(event_id=eid, tag_id=salsa.id))
            _going(session, user.id, eid)
        _event(session, "bachata-0", _past(5))
        session.add(EventTag(event_id="bachata-0", tag_id=bachata.id))
        _going(session, user.id, "bachata-0")
        session.commit()

        ctx = passport_service.build_stats_context(session, user)

        assert ctx["top_style"] == "Salsa"

    def test_none_when_no_style_tags(self, session):
        user = User(email="a@example.com")
        session.add(user)
        _event(session, "e1", _past(10))
        _going(session, user.id, "e1")
        session.commit()

        ctx = passport_service.build_stats_context(session, user)

        assert ctx["top_style"] is None


@pytest.mark.unit
class TestFrequencyStats:
    def test_events_last_30_days_counts_recent_only(self, session):
        user = User(email="a@example.com")
        session.add(user)
        _event(session, "recent", _past(5), city="Paris", country="France")
        _going(session, user.id, "recent")
        _event(session, "old", _past(90), city="Berlin", country="Germany")
        _going(session, user.id, "old")
        session.commit()

        ctx = passport_service.build_stats_context(session, user)

        assert ctx["events_last_30d"] == 1

    def test_average_gap_days(self, session):
        user = User(email="a@example.com")
        session.add(user)
        # Events at 30, 20 and 0 days ago -> gaps of 10 and 20 days -> avg 15.
        for i, d in enumerate((30, 20, 0)):
            eid = f"g-{i}"
            _event(session, eid, _past(d), city=f"City-{i}", country="France")
            _going(session, user.id, eid)
        session.commit()

        ctx = passport_service.build_stats_context(session, user)

        assert ctx["avg_gap_days"] == 15.0

    def test_average_gap_none_for_single_event(self, session):
        user = User(email="a@example.com")
        session.add(user)
        _event(session, "solo", _past(3), city="Paris", country="France")
        _going(session, user.id, "solo")
        session.commit()

        ctx = passport_service.build_stats_context(session, user)

        assert ctx["avg_gap_days"] is None


@pytest.mark.unit
class TestTimelineMarkers:
    def test_markers_anchored_to_triggering_event(self, session):
        user = User(email="a@example.com")
        session.add(user)
        _attend_n(session, user.id, 10)
        session.commit()

        events = passport_service.attended_events(session, user.id)
        markers = passport_service.timeline_milestone_markers(events)
        by_key = {m["key"]: m for m in markers}

        assert "first_event" in by_key
        assert "events_5" in by_key
        assert "cities_10" in by_key
        # first_event fires on the earliest attended event.
        earliest = min(e.start for e in events)
        assert by_key["first_event"]["date"] == earliest
        earliest_event = min(events, key=lambda event: event.start)
        assert by_key["first_event"]["event_id"] == earliest_event.event_id
        assert by_key["first_event"]["description"] == "Attend your first event"
        # Review milestones are not event-anchored, so never appear here.
        assert "first_review" not in by_key

    def test_review_markers_use_threshold_review_date(self, session):
        user = User(email="reviewer@example.com")
        session.add(user)
        dates = [_past(30), _past(20), _past(10)]
        for index, created_at in enumerate(dates):
            event_id = f"reviewed-{index}"
            _event(session, event_id, _past(40 - index))
            _review(session, user.id, event_id, created_at=created_at)
        session.commit()

        markers = passport_service.review_timeline_markers(session, user.id)
        by_key = {marker["key"]: marker for marker in markers}

        assert by_key["first_review"]["date"] == dates[0]
        assert by_key["reviews_3"]["date"] == dates[2]
        assert by_key["first_review"]["event_id"] is None
        assert by_key["first_review"]["description"] == "Leave your first review"
        assert "reviews_10" not in by_key
