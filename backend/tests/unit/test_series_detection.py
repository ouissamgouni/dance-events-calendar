"""Unit tests for the event-series (recurring occurrence) detection service.

Covers:
- candidate matching: same-calendar + date-window + title-similarity
  threshold + occurrence-separation floor (skips near-duplicate pairs)
- location similarity as an additional signal when both events have one
- group creation/merging (a new match joins an existing pending series)
- sticky pairs: resolved/dismissed pairs are never regrouped
- approve_series: resolves without hiding/blocking any member
- dismiss_series: marks dismissed, leaves the pair recorded
- split_member: removes one event from a series without touching the event
- manual grouping: always creates a new series, ignoring prior decisions
- run_full_scan: dedups pairs across the whole active/upcoming set
- maybe_detect_series_for_event: no-op unless the feature flag is on
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

os.environ.setdefault("SESSION_SECRET", "test-secret-series-detection")

from backend.db.models import (  # noqa: E402
    CachedEvent,
    EventSeries,
    EventSeriesMember,
    EventSeriesScanLog,
    SiteSetting,
)
from backend.services.series_detection import (  # noqa: E402
    SeriesMembershipConflict,
    add_events_to_series,
    approve_series,
    canonical_series_title,
    create_manual_series,
    detect_series_for_event,
    dismiss_series,
    find_candidate_matches,
    get_series_for_event,
    load_config,
    maybe_detect_series_for_event,
    rename_series,
    run_full_scan,
    save_config,
    split_member,
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


def _make_event(
    session: Session,
    event_id: str,
    title: str,
    start: datetime,
    *,
    calendar_id: str = "cal-1",
    hours: int = 2,
    location: str | None = None,
    latitude: float | None = None,
    longitude: float | None = None,
    city: str | None = None,
    country_code: str | None = None,
) -> CachedEvent:
    event = CachedEvent(
        event_id=event_id,
        calendar_id=calendar_id,
        title=title,
        start=start,
        end=start + timedelta(hours=hours),
        location=location,
        latitude=latitude,
        longitude=longitude,
        city=city,
        country_code=country_code,
    )
    session.add(event)
    session.commit()
    session.refresh(event)
    return event


@pytest.mark.unit
class TestFindCandidateMatches:
    def test_matches_similar_title_in_same_calendar_different_week(self, session):
        start = datetime.now(timezone.utc) + timedelta(days=3)
        a = _make_event(session, "evt-a", "Weekly Salsa Social", start)
        _make_event(
            session,
            "evt-b",
            "Weekly Salsa Social",
            start + timedelta(days=7),
        )
        matches = find_candidate_matches(session, a)
        assert {m.event_id for m in matches} == {"evt-b"}

    def test_ignores_dissimilar_title(self, session):
        start = datetime.now(timezone.utc) + timedelta(days=3)
        a = _make_event(session, "evt-a", "Weekly Salsa Social", start)
        _make_event(session, "evt-b", "Bachata Workshop", start + timedelta(days=7))
        matches = find_candidate_matches(session, a)
        assert matches == []

    def test_ignores_different_calendar_without_location(self, session):
        start = datetime.now(timezone.utc) + timedelta(days=3)
        a = _make_event(
            session, "evt-a", "Weekly Salsa Social", start, calendar_id="cal-1"
        )
        _make_event(
            session,
            "evt-b",
            "Weekly Salsa Social",
            start + timedelta(days=7),
            calendar_id="cal-2",
        )
        matches = find_candidate_matches(session, a)
        assert matches == []

    def test_ignores_near_duplicate_same_occurrence(self, session):
        """Two events an hour apart are the SAME occurrence — that's
        duplicate-detection territory, not a different series occurrence."""
        start = datetime.now(timezone.utc) + timedelta(days=3)
        a = _make_event(session, "evt-a", "Weekly Salsa Social", start)
        _make_event(session, "evt-b", "Weekly Salsa Social", start + timedelta(hours=1))
        matches = find_candidate_matches(session, a)
        assert matches == []

    def test_ignores_events_outside_window(self, session):
        start = datetime.now(timezone.utc) + timedelta(days=3)
        a = _make_event(session, "evt-a", "Weekly Salsa Social", start)
        _make_event(
            session, "evt-b", "Weekly Salsa Social", start + timedelta(days=400)
        )
        matches = find_candidate_matches(session, a)
        assert matches == []

    def test_location_mismatch_excludes_when_both_set(self, session):
        start = datetime.now(timezone.utc) + timedelta(days=3)
        a = _make_event(
            session, "evt-a", "Weekly Salsa Social", start, location="The Warehouse"
        )
        _make_event(
            session,
            "evt-b",
            "Weekly Salsa Social",
            start + timedelta(days=7),
            location="Completely Different Venue Ave",
        )
        matches = find_candidate_matches(session, a)
        assert matches == []

    def test_location_similarity_included_when_similar(self, session):
        start = datetime.now(timezone.utc) + timedelta(days=3)
        a = _make_event(
            session,
            "evt-a",
            "Weekly Salsa Social",
            start,
            location="The Warehouse, 123 Main St",
        )
        _make_event(
            session,
            "evt-b",
            "Weekly Salsa Social",
            start + timedelta(days=7),
            location="The Warehouse 123 Main St",
        )
        matches = find_candidate_matches(session, a)
        assert {m.event_id for m in matches} == {"evt-b"}


@pytest.mark.unit
class TestDetectSeriesForEvent:
    def test_creates_series_and_logs_scan(self, session):
        start = datetime.now(timezone.utc) + timedelta(days=3)
        _make_event(session, "evt-a", "Weekly Salsa Social", start)
        _make_event(session, "evt-b", "Weekly Salsa Social", start + timedelta(days=7))

        log = detect_series_for_event(session, "evt-a")

        assert log.status == "completed"
        assert log.candidates_found == 1
        assert log.groups_created == 1

        series_rows = session.exec(select(EventSeries)).all()
        assert len(series_rows) == 1
        assert series_rows[0].status == "pending"
        assert series_rows[0].source == "auto"
        assert series_rows[0].canonical_title == "Weekly Salsa Social"

        members = session.exec(select(EventSeriesMember)).all()
        assert {m.event_id for m in members} == {"evt-a", "evt-b"}

    def test_logs_scan_even_when_no_match_found(self, session):
        start = datetime.now(timezone.utc) + timedelta(days=3)
        _make_event(session, "evt-a", "Weekly Salsa Social", start)

        log = detect_series_for_event(session, "evt-a")

        assert log.status == "completed"
        assert log.candidates_found == 0
        assert log.groups_created == 0
        assert session.exec(select(EventSeries)).all() == []

    def test_third_occurrence_joins_existing_pending_series(self, session):
        start = datetime.now(timezone.utc) + timedelta(days=3)
        _make_event(session, "evt-a", "Weekly Salsa Social", start)
        _make_event(session, "evt-b", "Weekly Salsa Social", start + timedelta(days=7))
        _make_event(session, "evt-c", "Weekly Salsa Social", start + timedelta(days=14))

        detect_series_for_event(session, "evt-a")
        detect_series_for_event(session, "evt-c")

        series_rows = session.exec(select(EventSeries)).all()
        assert len(series_rows) == 1
        members = session.exec(select(EventSeriesMember)).all()
        assert {m.event_id for m in members} == {"evt-a", "evt-b", "evt-c"}

    def test_does_not_recreate_series_for_resolved_pair(self, session):
        start = datetime.now(timezone.utc) + timedelta(days=3)
        _make_event(session, "evt-a", "Weekly Salsa Social", start)
        _make_event(session, "evt-b", "Weekly Salsa Social", start + timedelta(days=7))

        detect_series_for_event(session, "evt-a")
        series = session.exec(select(EventSeries)).one()
        approve_series(session, series.id)

        detect_series_for_event(session, "evt-a")
        series_rows = session.exec(select(EventSeries)).all()
        assert len(series_rows) == 1

    def test_does_not_recreate_series_for_dismissed_pair(self, session):
        start = datetime.now(timezone.utc) + timedelta(days=3)
        _make_event(session, "evt-a", "Weekly Salsa Social", start)
        _make_event(session, "evt-b", "Weekly Salsa Social", start + timedelta(days=7))

        detect_series_for_event(session, "evt-a")
        series = session.exec(select(EventSeries)).one()
        dismiss_series(session, series.id)

        detect_series_for_event(session, "evt-a")
        series_rows = session.exec(select(EventSeries)).all()
        assert len(series_rows) == 1
        assert series_rows[0].status == "dismissed"


@pytest.mark.unit
class TestMaybeDetectSeriesForEvent:
    def test_noop_when_flag_disabled(self, session):
        start = datetime.now(timezone.utc) + timedelta(days=3)
        _make_event(session, "evt-a", "Weekly Salsa Social", start)
        _make_event(session, "evt-b", "Weekly Salsa Social", start + timedelta(days=7))

        maybe_detect_series_for_event(session, "evt-a")

        assert session.exec(select(EventSeriesScanLog)).all() == []
        assert session.exec(select(EventSeries)).all() == []

    def test_runs_when_flag_enabled(self, session):
        session.add(SiteSetting(key="series_auto_detect_enabled", value="true"))
        session.commit()

        start = datetime.now(timezone.utc) + timedelta(days=3)
        _make_event(session, "evt-a", "Weekly Salsa Social", start)
        _make_event(session, "evt-b", "Weekly Salsa Social", start + timedelta(days=7))

        maybe_detect_series_for_event(session, "evt-a")

        assert len(session.exec(select(EventSeriesScanLog)).all()) == 1
        assert len(session.exec(select(EventSeries)).all()) == 1


@pytest.mark.unit
class TestApproveDismissSplit:
    def test_approve_resolves_without_hiding_any_member(self, session):
        start = datetime.now(timezone.utc) + timedelta(days=3)
        _make_event(session, "evt-a", "Weekly Salsa Social", start)
        _make_event(session, "evt-b", "Weekly Salsa Social", start + timedelta(days=7))
        detect_series_for_event(session, "evt-a")
        series = session.exec(select(EventSeries)).one()

        result = approve_series(
            session,
            series.id,
            canonical_title="Salsa Social",
            admin_email="admin@example.com",
        )

        assert result.status == "resolved"
        assert result.canonical_title == "Salsa Social"
        assert result.resolved_by_admin == "admin@example.com"
        assert session.get(CachedEvent, "evt-a").is_hidden is False
        assert session.get(CachedEvent, "evt-b").is_hidden is False

    def test_dismiss_marks_dismissed(self, session):
        start = datetime.now(timezone.utc) + timedelta(days=3)
        _make_event(session, "evt-a", "Weekly Salsa Social", start)
        _make_event(session, "evt-b", "Weekly Salsa Social", start + timedelta(days=7))
        detect_series_for_event(session, "evt-a")
        series = session.exec(select(EventSeries)).one()

        result = dismiss_series(session, series.id, admin_email="admin@example.com")

        assert result.status == "dismissed"
        assert result.resolved_by_admin == "admin@example.com"

    def test_split_removes_only_membership_not_event(self, session):
        start = datetime.now(timezone.utc) + timedelta(days=3)
        _make_event(session, "evt-a", "Weekly Salsa Social", start)
        _make_event(session, "evt-b", "Weekly Salsa Social", start + timedelta(days=7))
        _make_event(session, "evt-c", "Weekly Salsa Social", start + timedelta(days=14))
        series = create_manual_series(session, ["evt-a", "evt-b", "evt-c"])

        result = split_member(session, series.id, "evt-b")

        assert result is not None
        members = session.exec(
            select(EventSeriesMember).where(EventSeriesMember.series_id == series.id)
        ).all()
        assert {m.event_id for m in members} == {"evt-a", "evt-c"}
        assert session.get(CachedEvent, "evt-b") is not None

    def test_split_dissolves_series_below_two_members(self, session):
        start = datetime.now(timezone.utc) + timedelta(days=3)
        _make_event(session, "evt-a", "Weekly Salsa Social", start)
        _make_event(session, "evt-b", "Weekly Salsa Social", start + timedelta(days=7))
        series = create_manual_series(session, ["evt-a", "evt-b"])

        result = split_member(session, series.id, "evt-b")

        assert result is None
        assert session.get(EventSeries, series.id) is None
        assert session.exec(select(EventSeriesMember)).all() == []
        assert session.get(CachedEvent, "evt-a") is not None
        assert session.get(CachedEvent, "evt-b") is not None

    def test_split_unknown_member_raises(self, session):
        start = datetime.now(timezone.utc) + timedelta(days=3)
        _make_event(session, "evt-a", "Weekly Salsa Social", start)
        _make_event(session, "evt-b", "Weekly Salsa Social", start + timedelta(days=7))
        detect_series_for_event(session, "evt-a")
        series = session.exec(select(EventSeries)).one()

        with pytest.raises(ValueError):
            split_member(session, series.id, "evt-does-not-exist")


@pytest.mark.unit
class TestManualGroupingAndFullScan:
    def test_manual_grouping_always_creates_new_series(self, session):
        start = datetime.now(timezone.utc) + timedelta(days=3)
        _make_event(session, "evt-a", "Weekly Salsa Social", start)
        _make_event(
            session, "evt-b", "Totally Different Title", start + timedelta(days=7)
        )

        series = create_manual_series(
            session,
            ["evt-a", "evt-b"],
            canonical_title="Weekly Salsa Social",
            triggered_by_admin="admin@example.com",
        )

        assert series.source == "manual"
        assert series.canonical_title == "Weekly Salsa Social"
        members = session.exec(
            select(EventSeriesMember).where(EventSeriesMember.series_id == series.id)
        ).all()
        assert {m.event_id for m in members} == {"evt-a", "evt-b"}

    def test_manual_grouping_rejects_event_already_in_series(self, session):
        start = datetime.now(timezone.utc) + timedelta(days=3)
        _make_event(session, "evt-a", "Weekly Salsa Social", start)
        _make_event(session, "evt-b", "Weekly Salsa Social", start + timedelta(days=7))
        _make_event(session, "evt-c", "Weekly Salsa Social", start + timedelta(days=14))
        create_manual_series(session, ["evt-a", "evt-b"])

        with pytest.raises(SeriesMembershipConflict) as exc:
            create_manual_series(session, ["evt-b", "evt-c"])
        assert "evt-b" in exc.value.conflicts

    def test_add_events_to_series_appends_members(self, session):
        start = datetime.now(timezone.utc) + timedelta(days=3)
        _make_event(session, "evt-a", "Weekly Salsa Social", start)
        _make_event(session, "evt-b", "Weekly Salsa Social", start + timedelta(days=7))
        _make_event(session, "evt-c", "Weekly Salsa Social", start + timedelta(days=14))
        series = create_manual_series(session, ["evt-a", "evt-b"])

        add_events_to_series(session, series.id, ["evt-c"])

        members = session.exec(
            select(EventSeriesMember).where(EventSeriesMember.series_id == series.id)
        ).all()
        assert {m.event_id for m in members} == {"evt-a", "evt-b", "evt-c"}

    def test_add_events_to_series_rejects_conflict(self, session):
        start = datetime.now(timezone.utc) + timedelta(days=3)
        _make_event(session, "evt-a", "Weekly Salsa Social", start)
        _make_event(session, "evt-b", "Weekly Salsa Social", start + timedelta(days=7))
        _make_event(session, "evt-c", "Weekly Salsa Social", start + timedelta(days=14))
        _make_event(session, "evt-d", "Weekly Salsa Social", start + timedelta(days=21))
        series = create_manual_series(session, ["evt-a", "evt-b"])
        create_manual_series(session, ["evt-c", "evt-d"])

        with pytest.raises(SeriesMembershipConflict):
            add_events_to_series(session, series.id, ["evt-c"])

    def test_rename_series_updates_title(self, session):
        start = datetime.now(timezone.utc) + timedelta(days=3)
        _make_event(session, "evt-a", "Weekly Salsa Social", start)
        _make_event(session, "evt-b", "Weekly Salsa Social", start + timedelta(days=7))
        series = create_manual_series(session, ["evt-a", "evt-b"])

        updated = rename_series(session, series.id, "Tuesday Milonga")

        assert updated.canonical_title == "Tuesday Milonga"

    def test_full_scan_dedups_pairs(self, session):
        start = datetime.now(timezone.utc) + timedelta(days=3)
        _make_event(session, "evt-a", "Weekly Salsa Social", start)
        _make_event(session, "evt-b", "Weekly Salsa Social", start + timedelta(days=7))
        _make_event(session, "evt-c", "Weekly Salsa Social", start + timedelta(days=14))

        log = run_full_scan(session)

        assert log.status == "completed"
        series_rows = session.exec(select(EventSeries)).all()
        assert len(series_rows) == 1
        members = session.exec(select(EventSeriesMember)).all()
        assert {m.event_id for m in members} == {"evt-a", "evt-b", "evt-c"}


@pytest.mark.unit
class TestGetSeriesForEvent:
    def test_returns_only_pending_series(self, session):
        start = datetime.now(timezone.utc) + timedelta(days=3)
        _make_event(session, "evt-a", "Weekly Salsa Social", start)
        _make_event(session, "evt-b", "Weekly Salsa Social", start + timedelta(days=7))
        detect_series_for_event(session, "evt-a")
        series = session.exec(select(EventSeries)).one()

        assert len(get_series_for_event(session, "evt-a")) == 1

        approve_series(session, series.id)
        assert get_series_for_event(session, "evt-a") == []


# A yearly festival: previous edition already ended, next one ~a year later.
_VENUE = dict(latitude=50.0870, longitude=14.4260, city="Riverton", country_code="XX")


def _past_and_next_edition(session, **next_kwargs):
    past_start = datetime.now(timezone.utc) - timedelta(days=5)
    past = _make_event(
        session,
        "fest-past",
        "Riverside Mambo Weekend 2026",
        past_start,
        calendar_id="cal-1",
        hours=72,
        location="Old Mill Hall",
        **_VENUE,
    )
    kwargs = dict(
        calendar_id="cal-2",
        hours=72,
        location="Old Mill Hall, 22 River Rd, Riverton",
        **_VENUE,
    )
    kwargs.update(next_kwargs)
    nxt = _make_event(
        session,
        "fest-next",
        kwargs.pop("title", "Riverside Mambo Weekend 2027"),
        past_start + timedelta(days=363),
        **kwargs,
    )
    return past, nxt


@pytest.mark.unit
class TestYearlyAndCrossCalendarMatching:
    def test_yearly_edition_matches_across_calendars_and_ended_candidate(self, session):
        _, nxt = _past_and_next_edition(session)
        assert [m.event_id for m in find_candidate_matches(session, nxt)] == [
            "fest-past"
        ]

    def test_city_level_geocode_matches_on_same_city(self, session):
        # ~3 km apart: venue vs city-centroid geocode.
        _, nxt = _past_and_next_edition(
            session, latitude=50.1140, location="Riverton, Freedonia"
        )
        assert [m.event_id for m in find_candidate_matches(session, nxt)] == [
            "fest-past"
        ]

    def test_same_title_far_away_does_not_match(self, session):
        _, nxt = _past_and_next_edition(
            session,
            latitude=48.0,
            longitude=11.0,
            city="Elsewhere",
            location="Old Mill Hall",
        )
        assert find_candidate_matches(session, nxt) == []

    def test_generic_words_do_not_make_different_brands_match(self, session):
        _, nxt = _past_and_next_edition(session, title="Zephyr Mambo Weekend 2027")
        assert find_candidate_matches(session, nxt) == []

    def test_cross_calendar_can_be_disabled(self, session):
        _, nxt = _past_and_next_edition(session)
        save_config(session, {"cross_calendar_enabled": False})
        assert find_candidate_matches(session, nxt) == []

    def test_title_threshold_is_configurable(self, session):
        _, nxt = _past_and_next_edition(session, title="Riversyde Mambo Weekend 2027")
        assert len(find_candidate_matches(session, nxt)) == 1
        save_config(session, {"title_similarity_pct": 100})
        assert find_candidate_matches(session, nxt) == []

    def test_new_series_gets_title_without_year_or_edition(self, session):
        _past_and_next_edition(session, title="Riverside Mambo Weekend 3rd Edition")
        run_full_scan(session)
        series = session.exec(select(EventSeries)).one()
        assert series.canonical_title == "Riverside Mambo Weekend"

    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("Pine Salsa Marathon -Edition 08-", "Pine Salsa Marathon"),
            ("Harbor Social (2027)", "Harbor Social"),
            ("2027", "2027"),
        ],
    )
    def test_canonical_series_title(self, raw, expected):
        assert canonical_series_title(raw) == expected


@pytest.mark.unit
class TestExistingSeriesHandling:
    def test_new_edition_joins_resolved_series_and_reopens_it(self, session):
        past, _ = _past_and_next_edition(session)
        older = _make_event(
            session,
            "fest-older",
            "Riverside Mambo Weekend 2025",
            past.start - timedelta(days=364),
            hours=72,
            location="Old Mill Hall",
            **_VENUE,
        )
        series = create_manual_series(session, [older.event_id, past.event_id])
        approve_series(session, series.id, admin_email="admin@example.com")

        run_full_scan(session)

        session.refresh(series)
        assert series.status == "pending"
        assert series.resolved_at is None
        members = session.exec(select(EventSeriesMember)).all()
        assert {m.event_id for m in members} == {"fest-older", "fest-past", "fest-next"}

    def test_resolved_series_untouched_when_join_disabled(self, session):
        past, _ = _past_and_next_edition(session)
        other = _make_event(
            session,
            "fest-other",
            "Riverside Mambo Weekend",
            past.start + timedelta(days=30),
            hours=72,
            **_VENUE,
        )
        series = create_manual_series(session, [other.event_id, past.event_id])
        approve_series(session, series.id)
        save_config(session, {"join_resolved_enabled": False})

        detect_series_for_event(session, "fest-next")

        session.refresh(series)
        assert series.status == "resolved"
        assert _series_member_ids(session, series.id) == {"fest-other", "fest-past"}

    def test_dismissed_series_is_never_joined(self, session):
        past, _ = _past_and_next_edition(session)
        other = _make_event(
            session,
            "fest-other",
            "Riverside Mambo Weekend",
            past.start + timedelta(days=30),
            hours=72,
            **_VENUE,
        )
        series = create_manual_series(session, [other.event_id, past.event_id])
        dismiss_series(session, series.id)

        run_full_scan(session)

        assert _series_member_ids(session, series.id) == {"fest-other", "fest-past"}

    def test_cross_posted_copy_of_an_occurrence_does_not_join(self, session):
        start = datetime.now(timezone.utc) + timedelta(days=3)
        for i, eid in enumerate(("evt-a", "evt-b")):
            _make_event(
                session,
                eid,
                "Weekly Salsa Social",
                start + timedelta(days=7 * i),
                location="The Warehouse",
            )
        _make_event(
            session,
            "repost-a",
            "Weekly Salsa Social",
            start,
            calendar_id="cal-2",
            location="The Warehouse",
        )

        run_full_scan(session)

        series = session.exec(select(EventSeries)).one()
        assert _series_member_ids(session, series.id) == {"evt-a", "evt-b"}

    def test_removed_member_is_not_re_added_until_added_by_hand(self, session):
        start = datetime.now(timezone.utc) + timedelta(days=3)
        for i, eid in enumerate(("evt-a", "evt-b", "evt-c")):
            _make_event(
                session, eid, "Weekly Salsa Social", start + timedelta(days=7 * i)
            )
        run_full_scan(session)
        series = session.exec(select(EventSeries)).one()

        split_member(session, series.id, "evt-c")
        run_full_scan(session)
        assert _series_member_ids(session, series.id) == {"evt-a", "evt-b"}

        add_events_to_series(session, series.id, ["evt-c"])
        split_member(session, series.id, "evt-a")
        add_events_to_series(session, series.id, ["evt-a"])
        assert _series_member_ids(session, series.id) == {"evt-a", "evt-b", "evt-c"}


@pytest.mark.unit
def test_load_config_ignores_invalid_int_and_keeps_empty_word_list(session):
    session.add(SiteSetting(key="series_max_gap_days", value="abc"))
    session.add(SiteSetting(key="series_generic_title_words", value=""))
    session.commit()
    cfg = load_config(session)
    assert cfg.max_gap_days == 395
    assert cfg.generic_title_words == ()


def _series_member_ids(session, series_id: int) -> set[str]:
    return {
        m.event_id
        for m in session.exec(
            select(EventSeriesMember).where(EventSeriesMember.series_id == series_id)
        ).all()
    }
