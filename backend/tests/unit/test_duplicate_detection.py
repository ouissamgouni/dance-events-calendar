"""Unit tests for the near-duplicate event detection service.

Covers:
- candidate matching: date-window narrowing + title-similarity threshold
- group creation/merging (a new match joins an existing pending group)
- sticky pairs: resolved/dismissed pairs are never regrouped
- keep_event: blocks+hides the rejected members, stamps a reason
- dismiss_group: marks dismissed, leaves the pair recorded
- manual grouping: always creates a new group, ignoring prior decisions
- run_full_scan: dedups pairs across the whole active/upcoming set
- maybe_detect_duplicates_for_event: no-op unless the feature flag is on
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

os.environ.setdefault("SESSION_SECRET", "test-secret-duplicate-detection")

from backend.db.models import (  # noqa: E402
    BlockedEvent,
    CachedEvent,
    EventDuplicateGroup,
    EventDuplicateMember,
    EventDuplicateScanLog,
    SiteSetting,
)
from backend.services.duplicate_detection import (  # noqa: E402
    create_manual_group,
    detect_duplicates_for_event,
    dismiss_group,
    find_candidate_matches,
    get_groups_for_event,
    keep_event,
    maybe_detect_duplicates_for_event,
    run_full_scan,
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
) -> CachedEvent:
    event = CachedEvent(
        event_id=event_id,
        calendar_id=calendar_id,
        title=title,
        start=start,
        end=start + timedelta(hours=hours),
    )
    session.add(event)
    session.commit()
    session.refresh(event)
    return event


@pytest.mark.unit
class TestFindCandidateMatches:
    def test_matches_similar_title_within_window(self, session):
        start = datetime.utcnow() + timedelta(days=3)
        a = _make_event(session, "evt-a", "Salsa Night at the Warehouse", start)
        _make_event(
            session,
            "evt-b",
            "Salsa Night at the Warehouse!",
            start + timedelta(hours=1),
        )
        matches = find_candidate_matches(session, a)
        assert {m.event_id for m in matches} == {"evt-b"}

    def test_ignores_dissimilar_title(self, session):
        start = datetime.utcnow() + timedelta(days=3)
        a = _make_event(session, "evt-a", "Salsa Night", start)
        _make_event(session, "evt-b", "Bachata Workshop", start + timedelta(hours=1))
        matches = find_candidate_matches(session, a)
        assert matches == []

    def test_ignores_events_outside_window(self, session):
        start = datetime.utcnow() + timedelta(days=3)
        a = _make_event(session, "evt-a", "Salsa Night", start)
        _make_event(session, "evt-b", "Salsa Night", start + timedelta(hours=48))
        matches = find_candidate_matches(session, a)
        assert matches == []

    def test_ignores_hidden_events(self, session):
        start = datetime.utcnow() + timedelta(days=3)
        a = _make_event(session, "evt-a", "Salsa Night", start)
        b = _make_event(session, "evt-b", "Salsa Night", start + timedelta(hours=1))
        b.is_hidden = True
        session.add(b)
        session.commit()
        matches = find_candidate_matches(session, a)
        assert matches == []

    def test_ignores_past_events(self, session):
        start = datetime.utcnow() + timedelta(days=3)
        a = _make_event(session, "evt-a", "Salsa Night", start)
        past_start = datetime.utcnow() - timedelta(days=10)
        _make_event(
            session,
            "evt-b",
            "Salsa Night",
            past_start,
        )
        matches = find_candidate_matches(session, a)
        assert matches == []


@pytest.mark.unit
class TestDetectDuplicatesForEvent:
    def test_creates_group_and_logs_scan(self, session):
        start = datetime.utcnow() + timedelta(days=3)
        _make_event(session, "evt-a", "Salsa Night", start)
        _make_event(session, "evt-b", "Salsa Night", start + timedelta(hours=1))

        log = detect_duplicates_for_event(session, "evt-a")

        assert log.status == "completed"
        assert log.candidates_found == 1
        assert log.groups_created == 1

        groups = session.exec(select(EventDuplicateGroup)).all()
        assert len(groups) == 1
        assert groups[0].status == "pending"
        assert groups[0].source == "auto"

        members = session.exec(select(EventDuplicateMember)).all()
        assert {m.event_id for m in members} == {"evt-a", "evt-b"}

    def test_logs_scan_even_when_no_match_found(self, session):
        start = datetime.utcnow() + timedelta(days=3)
        _make_event(session, "evt-a", "Salsa Night", start)

        log = detect_duplicates_for_event(session, "evt-a")

        assert log.status == "completed"
        assert log.candidates_found == 0
        assert log.groups_created == 0
        assert session.exec(select(EventDuplicateGroup)).all() == []

    def test_third_match_joins_existing_pending_group(self, session):
        start = datetime.utcnow() + timedelta(days=3)
        _make_event(session, "evt-a", "Salsa Night", start)
        _make_event(session, "evt-b", "Salsa Night", start + timedelta(hours=1))
        _make_event(session, "evt-c", "Salsa Night", start + timedelta(hours=2))

        detect_duplicates_for_event(session, "evt-a")
        detect_duplicates_for_event(session, "evt-c")

        groups = session.exec(select(EventDuplicateGroup)).all()
        assert len(groups) == 1
        members = session.exec(select(EventDuplicateMember)).all()
        assert {m.event_id for m in members} == {"evt-a", "evt-b", "evt-c"}

    def test_does_not_recreate_group_for_resolved_pair(self, session):
        start = datetime.utcnow() + timedelta(days=3)
        _make_event(session, "evt-a", "Salsa Night", start)
        _make_event(session, "evt-b", "Salsa Night", start + timedelta(hours=1))

        detect_duplicates_for_event(session, "evt-a")
        group = session.exec(select(EventDuplicateGroup)).one()
        keep_event(session, group.id, "evt-a")

        # Re-run detection for the same pair — should not create a new group.
        detect_duplicates_for_event(session, "evt-a")
        groups = session.exec(select(EventDuplicateGroup)).all()
        assert len(groups) == 1

    def test_does_not_recreate_group_for_dismissed_pair(self, session):
        start = datetime.utcnow() + timedelta(days=3)
        _make_event(session, "evt-a", "Salsa Night", start)
        _make_event(session, "evt-b", "Salsa Night", start + timedelta(hours=1))

        detect_duplicates_for_event(session, "evt-a")
        group = session.exec(select(EventDuplicateGroup)).one()
        dismiss_group(session, group.id)

        detect_duplicates_for_event(session, "evt-a")
        groups = session.exec(select(EventDuplicateGroup)).all()
        assert len(groups) == 1
        assert groups[0].status == "dismissed"


@pytest.mark.unit
class TestMaybeDetectDuplicatesForEvent:
    def test_noop_when_flag_disabled(self, session):
        start = datetime.utcnow() + timedelta(days=3)
        _make_event(session, "evt-a", "Salsa Night", start)
        _make_event(session, "evt-b", "Salsa Night", start + timedelta(hours=1))

        maybe_detect_duplicates_for_event(session, "evt-a")

        assert session.exec(select(EventDuplicateScanLog)).all() == []
        assert session.exec(select(EventDuplicateGroup)).all() == []

    def test_runs_when_flag_enabled(self, session):
        session.add(SiteSetting(key="duplicate_auto_detect_enabled", value="true"))
        session.commit()

        start = datetime.utcnow() + timedelta(days=3)
        _make_event(session, "evt-a", "Salsa Night", start)
        _make_event(session, "evt-b", "Salsa Night", start + timedelta(hours=1))

        maybe_detect_duplicates_for_event(session, "evt-a")

        assert len(session.exec(select(EventDuplicateScanLog)).all()) == 1
        assert len(session.exec(select(EventDuplicateGroup)).all()) == 1


@pytest.mark.unit
class TestKeepEvent:
    def test_keeps_one_and_rejects_others(self, session):
        start = datetime.utcnow() + timedelta(days=3)
        _make_event(session, "evt-a", "Salsa Night", start)
        _make_event(session, "evt-b", "Salsa Night", start + timedelta(hours=1))
        detect_duplicates_for_event(session, "evt-a")
        group = session.exec(select(EventDuplicateGroup)).one()

        result = keep_event(session, group.id, "evt-a", admin_email="admin@example.com")

        assert result.status == "resolved"
        assert result.kept_event_id == "evt-a"
        assert result.resolved_by_admin == "admin@example.com"

        kept = session.get(CachedEvent, "evt-a")
        rejected = session.get(CachedEvent, "evt-b")
        assert kept.is_hidden is False
        assert rejected.is_hidden is True
        assert rejected.rejected_duplicate_reason == "Duplicate of evt-a — Salsa Night"
        assert session.get(BlockedEvent, "evt-b") is not None
        assert session.get(BlockedEvent, "evt-a") is None

    def test_raises_for_unknown_group(self, session):
        with pytest.raises(ValueError):
            keep_event(session, 999, "evt-a")

    def test_raises_when_keep_id_not_a_member(self, session):
        start = datetime.utcnow() + timedelta(days=3)
        _make_event(session, "evt-a", "Salsa Night", start)
        _make_event(session, "evt-b", "Salsa Night", start + timedelta(hours=1))
        detect_duplicates_for_event(session, "evt-a")
        group = session.exec(select(EventDuplicateGroup)).one()

        with pytest.raises(ValueError):
            keep_event(session, group.id, "evt-not-a-member")


@pytest.mark.unit
class TestDismissGroup:
    def test_marks_dismissed_without_hiding_events(self, session):
        start = datetime.utcnow() + timedelta(days=3)
        _make_event(session, "evt-a", "Salsa Night", start)
        _make_event(session, "evt-b", "Salsa Night", start + timedelta(hours=1))
        detect_duplicates_for_event(session, "evt-a")
        group = session.exec(select(EventDuplicateGroup)).one()

        result = dismiss_group(session, group.id, admin_email="admin@example.com")

        assert result.status == "dismissed"
        assert result.resolved_by_admin == "admin@example.com"
        assert session.get(CachedEvent, "evt-a").is_hidden is False
        assert session.get(CachedEvent, "evt-b").is_hidden is False


@pytest.mark.unit
class TestCreateManualGroup:
    def test_creates_group_regardless_of_prior_dismissal(self, session):
        start = datetime.utcnow() + timedelta(days=3)
        _make_event(session, "evt-a", "Salsa Night", start)
        _make_event(session, "evt-b", "Bachata Workshop", start + timedelta(hours=1))

        group = create_manual_group(
            session, ["evt-a", "evt-b"], triggered_by_admin="admin@example.com"
        )

        assert group.status == "pending"
        assert group.source == "manual"
        members = session.exec(
            select(EventDuplicateMember).where(
                EventDuplicateMember.group_id == group.id
            )
        ).all()
        assert {m.event_id for m in members} == {"evt-a", "evt-b"}

        log = session.exec(select(EventDuplicateScanLog)).one()
        assert log.scan_type == "manual_pair"
        assert log.status == "completed"


@pytest.mark.unit
class TestRunFullScan:
    def test_dedups_pairs_across_all_events(self, session):
        start = datetime.utcnow() + timedelta(days=3)
        _make_event(session, "evt-a", "Salsa Night", start)
        _make_event(session, "evt-b", "Salsa Night", start + timedelta(hours=1))
        _make_event(session, "evt-c", "Unrelated Workshop", start + timedelta(hours=2))

        log = run_full_scan(session)

        assert log.status == "completed"
        assert log.groups_created == 1
        groups = session.exec(select(EventDuplicateGroup)).all()
        assert len(groups) == 1


@pytest.mark.unit
class TestGetGroupsForEvent:
    def test_returns_only_pending_groups_for_event(self, session):
        start = datetime.utcnow() + timedelta(days=3)
        _make_event(session, "evt-a", "Salsa Night", start)
        _make_event(session, "evt-b", "Salsa Night", start + timedelta(hours=1))
        detect_duplicates_for_event(session, "evt-a")

        groups = get_groups_for_event(session, "evt-a")
        assert len(groups) == 1
        assert groups[0].status == "pending"

        keep_event(session, groups[0].id, "evt-a")
        assert get_groups_for_event(session, "evt-a") == []
