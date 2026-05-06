"""Unit tests for the heuristic tag-suggestion pipeline stage.

Uses an in-memory SQLite session to verify DB interaction (idempotency,
exclusions, rejection-suppression, persistence).
"""

from datetime import datetime, timedelta

import pytest
from sqlmodel import Session, SQLModel, create_engine

from backend.db.models import (
    CachedEvent,
    CalendarSetting,
    EventTag,
    Tag,
    TagGroup,
    TagSuggestion,
)
from backend.services.pipeline.stages.tag_suggestion import (
    REJECTION_SUPPRESSION_DAYS,
    TagSuggestionStage,
    delete_pending_ai_suggestions,
    excluded_tag_ids_for_event,
    persist_suggestions,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def session():
    engine = create_engine("sqlite://")
    SQLModel.metadata.create_all(engine)
    with Session(engine) as sess:
        yield sess


def _seed_taxonomy(session: Session) -> dict[str, int]:
    """Seed a small taxonomy. Returns slug → tag_id map."""
    g = TagGroup(slug="dance", label="Dance", ordinal=0, allow_multiple=True)
    session.add(g)
    session.flush()
    tags = [
        Tag(group_id=g.id, slug="salsa", label="Salsa", ordinal=0),
        Tag(group_id=g.id, slug="bachata", label="Bachata", ordinal=1),
        Tag(group_id=g.id, slug="kizomba", label="Kizomba", ordinal=2),
    ]
    for t in tags:
        session.add(t)
    session.flush()
    return {t.slug: t.id for t in tags}


def _seed_event(session: Session, *, event_id="evt-1", title="Salsa Night",
                description=None) -> CachedEvent:
    cal = CalendarSetting(calendar_id="cal-1", name="Test Cal", enabled=True)
    session.add(cal)
    session.flush()
    ev = CachedEvent(
        event_id=event_id,
        calendar_id="cal-1",
        title=title,
        description=description,
        start=datetime(2025, 1, 1, 20, 0, 0),
        end=datetime(2025, 1, 1, 23, 0, 0),
    )
    session.add(ev)
    session.flush()
    return ev


# ---------------------------------------------------------------------------
# should_process / process fallback
# ---------------------------------------------------------------------------


def _bare_event(**overrides) -> CachedEvent:
    base = dict(
        event_id="x",
        calendar_id="c",
        title="Salsa",
        start=datetime(2025, 1, 1, 20, 0, 0),
        end=datetime(2025, 1, 1, 23, 0, 0),
    )
    base.update(overrides)
    return CachedEvent(**base)


def test_should_process_false_when_no_text():
    stage = TagSuggestionStage()
    ev = _bare_event(title=None, description=None, location=None)
    assert stage.should_process(ev) is False


def test_should_process_true_with_title():
    stage = TagSuggestionStage()
    ev = _bare_event(title="Salsa", description=None)
    assert stage.should_process(ev) is True


def test_process_without_session_is_noop():
    """Parallel-pipeline path has no session; stage must not raise."""
    stage = TagSuggestionStage()
    ev = _bare_event(title="Salsa")
    assert stage.process(ev) is True


# ---------------------------------------------------------------------------
# process_with_session — happy path + idempotency
# ---------------------------------------------------------------------------


def test_process_with_session_creates_suggestions(session):
    ids = _seed_taxonomy(session)
    ev = _seed_event(session, title="Salsa & Bachata Social")

    stage = TagSuggestionStage()
    assert stage.process_with_session(session, ev) is True

    rows = session.exec(
        TagSuggestion.__table__.select().where(
            TagSuggestion.__table__.c.event_id == ev.event_id
        )
    ).all()
    tag_ids = {r.tag_id for r in rows}
    assert ids["salsa"] in tag_ids
    assert ids["bachata"] in tag_ids
    for r in rows:
        assert r.source == "heuristic"
        assert r.status == "pending"
        assert r.confidence is not None and 0 < r.confidence <= 1


def test_process_with_session_idempotent_when_ai_rows_exist(session):
    ids = _seed_taxonomy(session)
    ev = _seed_event(session, title="Salsa Night")

    stage = TagSuggestionStage()
    stage.process_with_session(session, ev)
    first_count = session.exec(
        TagSuggestion.__table__.select().where(
            TagSuggestion.__table__.c.event_id == ev.event_id
        )
    ).all()
    assert len(first_count) >= 1

    # Second run should NOT add more rows.
    stage.process_with_session(session, ev)
    second_count = session.exec(
        TagSuggestion.__table__.select().where(
            TagSuggestion.__table__.c.event_id == ev.event_id
        )
    ).all()
    assert len(second_count) == len(first_count)
    assert ids  # silence unused


# ---------------------------------------------------------------------------
# Exclusions
# ---------------------------------------------------------------------------


def test_excluded_tag_ids_includes_already_applied(session):
    ids = _seed_taxonomy(session)
    ev = _seed_event(session, title="Salsa Night")
    session.add(EventTag(event_id=ev.event_id, tag_id=ids["salsa"]))
    session.flush()

    excluded = excluded_tag_ids_for_event(session, ev.event_id)
    assert ids["salsa"] in excluded


def test_excluded_tag_ids_includes_recently_rejected(session):
    ids = _seed_taxonomy(session)
    ev = _seed_event(session, title="Salsa Night")
    session.add(TagSuggestion(
        event_id=ev.event_id,
        tag_id=ids["bachata"],
        status="rejected",
        source="heuristic",
        reviewed_at=datetime.utcnow() - timedelta(days=1),
    ))
    session.flush()

    excluded = excluded_tag_ids_for_event(session, ev.event_id)
    assert ids["bachata"] in excluded


def test_excluded_tag_ids_ignores_old_rejections(session):
    ids = _seed_taxonomy(session)
    ev = _seed_event(session, title="Salsa Night")
    session.add(TagSuggestion(
        event_id=ev.event_id,
        tag_id=ids["bachata"],
        status="rejected",
        source="heuristic",
        reviewed_at=datetime.utcnow() - timedelta(days=REJECTION_SUPPRESSION_DAYS + 5),
    ))
    session.flush()

    excluded = excluded_tag_ids_for_event(session, ev.event_id)
    assert ids["bachata"] not in excluded


def test_excluded_tag_ids_ignores_user_rejections(session):
    """Only auto-source rejections suppress future auto suggestions."""
    ids = _seed_taxonomy(session)
    ev = _seed_event(session, title="Salsa Night")
    session.add(TagSuggestion(
        event_id=ev.event_id,
        tag_id=ids["bachata"],
        status="rejected",
        source="user",
        reviewed_at=datetime.utcnow() - timedelta(days=1),
    ))
    session.flush()

    excluded = excluded_tag_ids_for_event(session, ev.event_id)
    assert ids["bachata"] not in excluded


# ---------------------------------------------------------------------------
# persist_suggestions / delete_pending_ai_suggestions
# ---------------------------------------------------------------------------


def test_persist_suggestions_skips_existing_pending(session):
    from backend.services.tag_suggester import TagCandidate

    ids = _seed_taxonomy(session)
    ev = _seed_event(session, title="Salsa Night")
    session.add(TagSuggestion(
        event_id=ev.event_id,
        tag_id=ids["salsa"],
        status="pending",
        source="heuristic",
        confidence=0.9,
    ))
    session.flush()

    inserted = persist_suggestions(session, ev.event_id, [
        TagCandidate(tag_id=ids["salsa"], confidence=0.95, matched_terms=("salsa",)),
        TagCandidate(tag_id=ids["bachata"], confidence=0.8, matched_terms=("bachata",)),
    ])
    assert len(inserted) == 1
    assert inserted[0].tag_id == ids["bachata"]


def test_persist_suggestions_empty_candidates_returns_empty(session):
    _seed_taxonomy(session)
    ev = _seed_event(session, title="Salsa Night")
    assert persist_suggestions(session, ev.event_id, []) == []


def test_delete_pending_ai_suggestions_only_removes_pending_ai(session):
    ids = _seed_taxonomy(session)
    ev = _seed_event(session, title="Salsa Night")
    session.add_all([
        TagSuggestion(event_id=ev.event_id, tag_id=ids["salsa"], status="pending",
                      source="heuristic", confidence=0.9),
        TagSuggestion(event_id=ev.event_id, tag_id=ids["bachata"], status="approved",
                      source="heuristic", confidence=0.8),
        TagSuggestion(event_id=ev.event_id, tag_id=ids["kizomba"], status="pending",
                      source="user"),
    ])
    session.flush()

    removed = delete_pending_ai_suggestions(session, ev.event_id)
    assert removed == 1

    remaining = session.exec(
        TagSuggestion.__table__.select().where(
            TagSuggestion.__table__.c.event_id == ev.event_id
        )
    ).all()
    assert len(remaining) == 2
    statuses = {(r.status, r.source) for r in remaining}
    assert ("approved", "heuristic") in statuses
    assert ("pending", "user") in statuses
