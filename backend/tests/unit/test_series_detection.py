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
from datetime import datetime, timedelta

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
    approve_series,
    create_manual_series,
    detect_series_for_event,
    dismiss_series,
    find_candidate_matches,
    get_series_for_event,
    maybe_detect_series_for_event,
    run_full_scan,
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
) -> CachedEvent:
    event = CachedEvent(
        event_id=event_id,
        calendar_id=calendar_id,
        title=title,
        start=start,
        end=start + timedelta(hours=hours),
        location=location,
    )
    session.add(event)
    session.commit()
    session.refresh(event)
    return event


@pytest.mark.unit
class TestFindCandidateMatches:
    def test_matches_similar_title_in_same_calendar_different_week(self, session):
        start = datetime.utcnow() + timedelta(days=3)
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
        start = datetime.utcnow() + timedelta(days=3)
        a = _make_event(session, "evt-a", "Weekly Salsa Social", start)
        _make_event(session, "evt-b", "Bachata Workshop", start + timedelta(days=7))
        matches = find_candidate_matches(session, a)
        assert matches == []

    def test_ignores_different_calendar(self, session):
        start = datetime.utcnow() + timedelta(days=3)
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
        start = datetime.utcnow() + timedelta(days=3)
        a = _make_event(session, "evt-a", "Weekly Salsa Social", start)
        _make_event(session, "evt-b", "Weekly Salsa Social", start + timedelta(hours=1))
        matches = find_candidate_matches(session, a)
        assert matches == []

    def test_ignores_events_outside_window(self, session):
        start = datetime.utcnow() + timedelta(days=3)
        a = _make_event(session, "evt-a", "Weekly Salsa Social", start)
        _make_event(
            session, "evt-b", "Weekly Salsa Social", start + timedelta(days=200)
        )
        matches = find_candidate_matches(session, a)
        assert matches == []

    def test_location_mismatch_excludes_when_both_set(self, session):
        start = datetime.utcnow() + timedelta(days=3)
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
        start = datetime.utcnow() + timedelta(days=3)
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
        start = datetime.utcnow() + timedelta(days=3)
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
        start = datetime.utcnow() + timedelta(days=3)
        _make_event(session, "evt-a", "Weekly Salsa Social", start)

        log = detect_series_for_event(session, "evt-a")

        assert log.status == "completed"
        assert log.candidates_found == 0
        assert log.groups_created == 0
        assert session.exec(select(EventSeries)).all() == []

    def test_third_occurrence_joins_existing_pending_series(self, session):
        start = datetime.utcnow() + timedelta(days=3)
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
        start = datetime.utcnow() + timedelta(days=3)
        _make_event(session, "evt-a", "Weekly Salsa Social", start)
        _make_event(session, "evt-b", "Weekly Salsa Social", start + timedelta(days=7))

        detect_series_for_event(session, "evt-a")
        series = session.exec(select(EventSeries)).one()
        approve_series(session, series.id)

        detect_series_for_event(session, "evt-a")
        series_rows = session.exec(select(EventSeries)).all()
        assert len(series_rows) == 1

    def test_does_not_recreate_series_for_dismissed_pair(self, session):
        start = datetime.utcnow() + timedelta(days=3)
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
        start = datetime.utcnow() + timedelta(days=3)
        _make_event(session, "evt-a", "Weekly Salsa Social", start)
        _make_event(session, "evt-b", "Weekly Salsa Social", start + timedelta(days=7))

        maybe_detect_series_for_event(session, "evt-a")

        assert session.exec(select(EventSeriesScanLog)).all() == []
        assert session.exec(select(EventSeries)).all() == []

    def test_runs_when_flag_enabled(self, session):
        session.add(SiteSetting(key="series_auto_detect_enabled", value="true"))
        session.commit()

        start = datetime.utcnow() + timedelta(days=3)
        _make_event(session, "evt-a", "Weekly Salsa Social", start)
        _make_event(session, "evt-b", "Weekly Salsa Social", start + timedelta(days=7))

        maybe_detect_series_for_event(session, "evt-a")

        assert len(session.exec(select(EventSeriesScanLog)).all()) == 1
        assert len(session.exec(select(EventSeries)).all()) == 1


@pytest.mark.unit
class TestApproveDismissSplit:
    def test_approve_resolves_without_hiding_any_member(self, session):
        start = datetime.utcnow() + timedelta(days=3)
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
        start = datetime.utcnow() + timedelta(days=3)
        _make_event(session, "evt-a", "Weekly Salsa Social", start)
        _make_event(session, "evt-b", "Weekly Salsa Social", start + timedelta(days=7))
        detect_series_for_event(session, "evt-a")
        series = session.exec(select(EventSeries)).one()

        result = dismiss_series(session, series.id, admin_email="admin@example.com")

        assert result.status == "dismissed"
        assert result.resolved_by_admin == "admin@example.com"

    def test_split_removes_only_membership_not_event(self, session):
        start = datetime.utcnow() + timedelta(days=3)
        _make_event(session, "evt-a", "Weekly Salsa Social", start)
        _make_event(session, "evt-b", "Weekly Salsa Social", start + timedelta(days=7))
        detect_series_for_event(session, "evt-a")
        series = session.exec(select(EventSeries)).one()

        split_member(session, series.id, "evt-b")

        members = session.exec(
            select(EventSeriesMember).where(EventSeriesMember.series_id == series.id)
        ).all()
        assert {m.event_id for m in members} == {"evt-a"}
        assert session.get(CachedEvent, "evt-b") is not None

    def test_split_unknown_member_raises(self, session):
        start = datetime.utcnow() + timedelta(days=3)
        _make_event(session, "evt-a", "Weekly Salsa Social", start)
        _make_event(session, "evt-b", "Weekly Salsa Social", start + timedelta(days=7))
        detect_series_for_event(session, "evt-a")
        series = session.exec(select(EventSeries)).one()

        with pytest.raises(ValueError):
            split_member(session, series.id, "evt-does-not-exist")


@pytest.mark.unit
class TestManualGroupingAndFullScan:
    def test_manual_grouping_always_creates_new_series(self, session):
        start = datetime.utcnow() + timedelta(days=3)
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

    def test_full_scan_dedups_pairs(self, session):
        start = datetime.utcnow() + timedelta(days=3)
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
        start = datetime.utcnow() + timedelta(days=3)
        _make_event(session, "evt-a", "Weekly Salsa Social", start)
        _make_event(session, "evt-b", "Weekly Salsa Social", start + timedelta(days=7))
        detect_series_for_event(session, "evt-a")
        series = session.exec(select(EventSeries)).one()

        assert len(get_series_for_event(session, "evt-a")) == 1

        approve_series(session, series.id)
        assert get_series_for_event(session, "evt-a") == []
