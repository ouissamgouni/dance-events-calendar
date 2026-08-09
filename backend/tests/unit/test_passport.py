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
    UserEventAttendance,
)
from backend.services import passport as passport_service

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


def _review(session, user_id, event_id, *, status="approved"):
    session.add(
        EventRating(
            event_id=event_id,
            user_id=user_id,
            stars=4,
            status=status,
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
        assert ctx["longest_streak"] == 0
        assert ctx["first_event_date"] is None


@pytest.mark.unit
class TestMonthStreak:
    def test_consecutive_months(self):
        events = [
            CachedEvent(
                event_id="a",
                calendar_id="c",
                title="a",
                start=datetime(2025, 1, 15),
                end=datetime(2025, 1, 15),
            ),
            CachedEvent(
                event_id="b",
                calendar_id="c",
                title="b",
                start=datetime(2025, 2, 3),
                end=datetime(2025, 2, 3),
            ),
            CachedEvent(
                event_id="c",
                calendar_id="c",
                title="c",
                start=datetime(2025, 3, 20),
                end=datetime(2025, 3, 20),
            ),
        ]
        assert passport_service.longest_month_streak(events) == 3

    def test_gap_resets_streak(self):
        events = [
            CachedEvent(
                event_id="a",
                calendar_id="c",
                title="a",
                start=datetime(2025, 1, 15),
                end=datetime(2025, 1, 15),
            ),
            CachedEvent(
                event_id="b",
                calendar_id="c",
                title="b",
                start=datetime(2025, 2, 3),
                end=datetime(2025, 2, 3),
            ),
            # Gap in March.
            CachedEvent(
                event_id="c",
                calendar_id="c",
                title="c",
                start=datetime(2025, 4, 20),
                end=datetime(2025, 4, 20),
            ),
        ]
        assert passport_service.longest_month_streak(events) == 2

    def test_year_boundary(self):
        events = [
            CachedEvent(
                event_id="a",
                calendar_id="c",
                title="a",
                start=datetime(2024, 12, 15),
                end=datetime(2024, 12, 15),
            ),
            CachedEvent(
                event_id="b",
                calendar_id="c",
                title="b",
                start=datetime(2025, 1, 3),
                end=datetime(2025, 1, 3),
            ),
        ]
        assert passport_service.longest_month_streak(events) == 2

    def test_empty(self):
        assert passport_service.longest_month_streak([]) == 0


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


@pytest.mark.unit
class TestInternationalReach:
    def test_detects_international_tag(self, session):
        user = User(email="a@example.com")
        session.add(user)
        group = TagGroup(slug="reach", label="Reach")
        session.add(group)
        session.commit()
        tag = Tag(group_id=group.id, slug="international", label="International")
        session.add(tag)
        session.commit()
        _event(session, "e1", _past(10), city="Paris", country="France")
        session.add(EventTag(event_id="e1", tag_id=tag.id))
        _going(session, user.id, "e1")
        session.commit()

        assert passport_service.has_international_reach(session, ["e1"]) is True

    def test_no_tag_returns_false(self, session):
        assert passport_service.has_international_reach(session, ["e1"]) is False


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
        assert "events_10" not in newly

    def test_events_10_threshold(self, session):
        user = User(email="a@example.com")
        session.add(user)
        _attend_n(session, user.id, 10)
        session.commit()

        newly = passport_service.evaluate_and_persist(session, user)

        assert "first_event" in newly
        assert "events_10" in newly
        assert "events_25" not in newly
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

    def test_international_milestone(self, session):
        user = User(email="a@example.com")
        session.add(user)
        group = TagGroup(slug="reach", label="Reach")
        session.add(group)
        session.commit()
        tag = Tag(group_id=group.id, slug="international", label="International")
        session.add(tag)
        session.commit()
        _event(session, "e1", _past(10), city="Berlin", country="Germany")
        session.add(EventTag(event_id="e1", tag_id=tag.id))
        _going(session, user.id, "e1")
        session.commit()

        newly = passport_service.evaluate_and_persist(session, user)

        assert "first_international" in newly

    def test_streak_milestone(self, session):
        user = User(email="a@example.com")
        session.add(user)
        # Three events in three consecutive months.
        months = [datetime(2025, 1, 15), datetime(2025, 2, 15), datetime(2025, 3, 15)]
        for i, start in enumerate(months):
            eid = f"ev-{i}"
            evt = CachedEvent(
                event_id=eid,
                calendar_id="c",
                title=eid,
                start=start,
                end=start + timedelta(hours=2),
                city=f"City-{i}",
                country="France",
            )
            session.add(evt)
            _going(session, user.id, eid)
        session.commit()

        ctx = passport_service.build_stats_context(session, user)
        keys = passport_service.satisfied_keys(ctx)

        assert "streak_3_months" in keys
        assert "streak_6_months" not in keys

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
        events_10 = next(m for m in view if m["key"] == "events_10")
        assert events_10["unlocked"] is False
        assert events_10["progress"] == 3
        assert events_10["threshold"] == 10


@pytest.mark.unit
class TestCatalog:
    def test_globetrotter_is_ten_countries(self):
        m = passport_service.MILESTONES_BY_KEY["countries_10"]
        assert m.name == "Globetrotter"
        assert m.category == "countries"
        assert m.threshold == 10

    def test_cities_ten_renamed_from_globetrotter(self):
        m = passport_service.MILESTONES_BY_KEY["cities_10"]
        assert m.name == "City Hopper"
        assert m.category == "cities"

    def test_year_long_streak_milestone_exists(self):
        m = passport_service.MILESTONES_BY_KEY["streak_12_months"]
        assert m.category == "streak"
        assert m.threshold == 12
        assert m.unit == "months"

    def test_every_milestone_has_prestige(self):
        for m in passport_service.MILESTONES:
            assert isinstance(m.prestige, int)
            assert 1 <= m.prestige <= 100

    def test_capstone_milestones_outrank_first_steps(self):
        first = passport_service.MILESTONES_BY_KEY["first_event"].prestige
        assert passport_service.MILESTONES_BY_KEY["events_100"].prestige > first
        assert passport_service.MILESTONES_BY_KEY["countries_10"].prestige > first
        assert passport_service.MILESTONES_BY_KEY["streak_12_months"].prestige > first


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
        markers = passport_service.timeline_milestone_markers(events, set())
        by_key = {m["key"]: m for m in markers}

        assert "first_event" in by_key
        assert "events_10" in by_key
        assert "cities_10" in by_key
        # first_event fires on the earliest attended event.
        earliest = min(e.start for e in events)
        assert by_key["first_event"]["date"] == earliest
        # Review milestones are not event-anchored, so never appear here.
        assert "first_review" not in by_key

    def test_international_marker_uses_provided_ids(self, session):
        user = User(email="a@example.com")
        session.add(user)
        _event(session, "e1", _past(10), city="Berlin", country="Germany")
        _going(session, user.id, "e1")
        session.commit()

        events = passport_service.attended_events(session, user.id)
        markers = passport_service.timeline_milestone_markers(events, {"e1"})
        keys = {m["key"] for m in markers}

        assert "first_international" in keys
