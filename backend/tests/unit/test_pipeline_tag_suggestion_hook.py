"""Test that the streaming sync pipeline triggers tag suggestion after persisting
new/updated events. Regression for: tag suggestions used to be skipped on sync.

We exercise ``EventPipelineProcessor._run_tag_suggestion`` directly against an
in-memory SQLite DB seeded with a tag taxonomy and a freshly-persisted event.
This is the unit-level seam — the post-persist hook in ``_process_one_event``
is a one-liner that just calls this helper, so testing the helper covers the
behavior and avoids spinning up the whole pipeline.
"""

from datetime import datetime

import pytest
from sqlmodel import Session, SQLModel, create_engine, select

from backend.db.models import (
    CachedEvent,
    CalendarSetting,
    Tag,
    TagGroup,
    TagSuggestion,
)
from backend.services.event_pipeline_processor import EventPipelineProcessor


@pytest.fixture
def session():
    engine = create_engine("sqlite://")
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        yield s


def _seed(session: Session) -> CachedEvent:
    g = TagGroup(slug="dance", label="Dance", ordinal=0, allow_multiple=True)
    session.add(g)
    session.flush()
    session.add(Tag(group_id=g.id, slug="salsa", label="Salsa", ordinal=0))
    session.add(Tag(group_id=g.id, slug="bachata", label="Bachata", ordinal=1))
    session.add(CalendarSetting(calendar_id="cal-1", name="Test Cal", enabled=True))
    session.flush()
    ev = CachedEvent(
        event_id="evt-1",
        calendar_id="cal-1",
        title="Salsa Night with live band",
        start=datetime(2026, 1, 1, 20, 0),
        end=datetime(2026, 1, 1, 23, 0),
    )
    session.add(ev)
    session.commit()
    return ev


@pytest.mark.unit
def test_run_tag_suggestion_creates_pending_suggestions(session):
    ev = _seed(session)

    # Use object.__new__ to bypass __init__ (which wires up workers, queues, …).
    proc = object.__new__(EventPipelineProcessor)
    proc._run_tag_suggestion(session, ev)
    session.commit()

    suggestions = session.exec(
        select(TagSuggestion).where(TagSuggestion.event_id == ev.event_id)
    ).all()
    slugs = {
        session.get(Tag, s.tag_id).slug for s in suggestions if s.tag_id is not None
    }
    assert "salsa" in slugs, f"expected 'salsa' suggestion, got {slugs}"


@pytest.mark.unit
def test_run_tag_suggestion_skips_event_with_no_text(session):
    session.add(CalendarSetting(calendar_id="cal-1", name="Test Cal", enabled=True))
    session.flush()
    ev = CachedEvent(
        event_id="evt-empty",
        calendar_id="cal-1",
        title=None,
        description=None,
        location=None,
        start=datetime(2026, 1, 1, 20, 0),
        end=datetime(2026, 1, 1, 23, 0),
    )
    session.add(ev)
    session.commit()

    proc = object.__new__(EventPipelineProcessor)
    # should_process returns False — must not raise.
    proc._run_tag_suggestion(session, ev)

    suggestions = session.exec(
        select(TagSuggestion).where(TagSuggestion.event_id == "evt-empty")
    ).all()
    assert suggestions == []
