from datetime import datetime

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from backend.db.models import CachedEvent, SiteSetting
from backend.services.event_visibility import (
    apply_event_visibility,
    eligible_event_ids,
    event_is_user_facing,
    show_pending_events_enabled,
)


@pytest.fixture
def session():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as db_session:
        yield db_session
    SQLModel.metadata.drop_all(engine)


def _event(event_id: str, review_status: str) -> CachedEvent:
    return CachedEvent(
        event_id=event_id,
        calendar_id="calendar",
        title=event_id,
        start=datetime(2026, 10, 1, 18),
        end=datetime(2026, 10, 1, 20),
        review_status=review_status,
    )


@pytest.mark.unit
def test_pending_events_are_ineligible_by_default(session):
    reviewed = _event("reviewed", "reviewed")
    pending = _event("pending", "pending")
    session.add(reviewed)
    session.add(pending)
    session.commit()

    assert show_pending_events_enabled(session) is False
    assert event_is_user_facing(session, reviewed) is True
    assert event_is_user_facing(session, pending) is False
    assert eligible_event_ids(session, [reviewed.event_id, pending.event_id]) == {
        reviewed.event_id
    }
    rows = session.exec(apply_event_visibility(select(CachedEvent), session)).all()
    assert [row.event_id for row in rows] == [reviewed.event_id]


@pytest.mark.unit
def test_pending_events_are_eligible_when_enabled(session):
    pending = _event("pending", "pending")
    session.add(pending)
    session.add(SiteSetting(key="show_pending_events", value="true"))
    session.commit()

    assert show_pending_events_enabled(session) is True
    assert event_is_user_facing(session, pending) is True
    assert eligible_event_ids(session, [pending.event_id]) == {pending.event_id}
    rows = session.exec(apply_event_visibility(select(CachedEvent), session)).all()
    assert [row.event_id for row in rows] == [pending.event_id]


def _submission(session, owner_id, event_id="submitted", status="pending"):
    from backend.db.models import EventSuggestion

    suggestion = EventSuggestion(
        title="Submitted",
        start=datetime(2026, 10, 1, 18),
        end=datetime(2026, 10, 1, 20),
        submitter_user_id=owner_id,
        status=status,
    )
    session.add(suggestion)
    session.flush()
    event = _event(event_id, "pending")
    event.suggestion_id = suggestion.id
    event.visibility = "private"
    event.owner_user_id = owner_id
    session.add(event)
    session.commit()
    return event


def _owner(session):
    from backend.db.models import User

    owner = User(email="owner@example.com", provider="dev", provider_subject="owner")
    session.add(owner)
    session.commit()
    return owner


@pytest.mark.unit
@pytest.mark.parametrize("toggle", [False, True])
def test_private_event_is_visible_to_its_owner_only(session, toggle):
    from uuid import uuid4

    from backend.services.event_visibility import viewer_can_see_event

    owner = _owner(session)
    if toggle:
        session.add(SiteSetting(key="show_pending_events", value="true"))
        session.commit()
    event = _submission(session, owner.id)

    # The toggle never publishes a private event.
    assert event_is_user_facing(session, event) is False
    assert eligible_event_ids(session, [event.event_id]) == set()
    assert eligible_event_ids(session, [event.event_id], viewer_id=uuid4()) == set()
    assert eligible_event_ids(session, [event.event_id], viewer_id=owner.id) == {
        event.event_id
    }
    assert viewer_can_see_event(session, event, owner.id) is True
    assert viewer_can_see_event(session, event, uuid4()) is False
    assert viewer_can_see_event(session, event, None, is_admin=True) is True


@pytest.mark.unit
def test_reviewed_private_event_stays_private(session):
    owner = _owner(session)
    event = _submission(session, owner.id, status="declined")
    event.review_status = "reviewed"
    session.add(event)
    session.commit()

    assert event_is_user_facing(session, event) is False
    assert eligible_event_ids(session, [event.event_id]) == set()


@pytest.mark.unit
def test_audience_and_status_of_every_kind_of_event(session):
    from backend.services.event_visibility import (
        audience,
        audience_clause,
        event_wants_public,
        wants_public_clause,
    )

    owner = _owner(session)
    synced = _event("synced", "pending")
    hidden = _event("hidden", "reviewed")
    hidden.is_hidden = True
    live = _event("live", "reviewed")
    session.add_all([synced, hidden, live])
    session.commit()
    private = _submission(session, owner.id, "private", status="private")
    requested = _submission(session, owner.id, "requested", status="pending")

    events = [synced, hidden, live, private, requested]
    assert {e.event_id: (audience(e), e.status) for e in events} == {
        "synced": ("public", "new"),
        "hidden": ("public", "unpublished"),
        "live": ("public", "published"),
        "private": ("private", "new"),
        "requested": ("private", "new"),
    }
    assert {e.event_id for e in events if event_wants_public(session, e)} == {
        "requested"
    }
    assert set(
        session.exec(select(CachedEvent.event_id).where(audience_clause("private")))
    ) == {"private", "requested"}
    assert set(
        session.exec(select(CachedEvent.event_id).where(wants_public_clause())).all()
    ) == {"requested"}


@pytest.mark.unit
def test_set_event_status_mirrors_legacy_columns(session):
    from backend.services.event_visibility import (
        REASON_DUPLICATE,
        REASON_GOOGLE_CALENDAR,
        is_listed,
        is_processable,
        set_event_status,
    )

    event = _event("ev", "pending")
    session.add(event)
    session.commit()

    set_event_status(event, "cancelled")
    session.commit()
    assert (event.status, event.is_cancelled, event.is_hidden) == (
        "cancelled",
        True,
        False,
    )
    assert is_listed(event) and not is_processable(event)

    set_event_status(event, "removed", REASON_DUPLICATE)
    session.commit()
    assert (event.status, event.status_reason, event.is_hidden) == (
        "removed",
        "duplicate",
        True,
    )
    assert event.deleted_at is None
    assert not is_listed(event) and not is_processable(event)

    set_event_status(event, "removed", REASON_GOOGLE_CALENDAR)
    assert event.deleted_at is not None

    set_event_status(event, "new")
    session.commit()
    assert (event.status, event.status_reason, event.deleted_at, event.is_hidden) == (
        "new",
        None,
        None,
        False,
    )


@pytest.mark.unit
def test_legacy_writes_keep_status_in_step(session):
    from backend.services.event_visibility import REASON_OWNER, set_event_status

    event = _event("ev", "pending")
    session.add(event)
    session.commit()
    assert event.status == "new"

    event.review_status = "reviewed"
    session.commit()
    assert event.status == "published"

    event.is_hidden = True
    session.commit()
    assert event.status == "unpublished"

    event.is_hidden = False
    event.deleted_at = datetime(2026, 10, 1)
    session.commit()
    assert (event.status, event.status_reason) == ("removed", "google_calendar")

    # A removal keeps its reason when an unrelated legacy column changes.
    set_event_status(event, "removed", REASON_OWNER)
    session.commit()
    event.review_status = "pending"
    session.commit()
    assert (event.status, event.status_reason) == ("removed", "owner")


@pytest.mark.unit
def test_removing_an_event_dismisses_what_waits_on_it(session):
    from backend.db.models import (
        EventDuplicateGroup,
        EventDuplicateMember,
        EventPromoCode,
        EventRevision,
        TagSuggestion,
    )
    from backend.services.event_visibility import REASON_ADMIN, set_event_status

    owner = _owner(session)
    gone, other, third = (_event(i, "reviewed") for i in ("gone", "other", "third"))
    session.add_all([gone, other, third])
    pair = EventDuplicateGroup(status="pending")
    trio = EventDuplicateGroup(status="pending")
    session.add_all([pair, trio])
    session.flush()
    session.add_all(
        [
            EventDuplicateMember(group_id=pair.id, event_id="gone"),
            EventDuplicateMember(group_id=pair.id, event_id="other"),
            EventDuplicateMember(group_id=trio.id, event_id="gone"),
            EventDuplicateMember(group_id=trio.id, event_id="other"),
            EventDuplicateMember(group_id=trio.id, event_id="third"),
            TagSuggestion(event_id="gone", free_text="zouk"),
            TagSuggestion(event_id="other", free_text="zouk"),
            EventRevision(event_id="gone", source="sync", status="pending", changes={}),
            EventPromoCode(event_id="gone", code="X", submitter_user_id=owner.id),
        ]
    )
    session.commit()

    set_event_status(gone, "removed", REASON_ADMIN)
    session.commit()

    assert {s.event_id: s.status for s in session.exec(select(TagSuggestion))} == {
        "gone": "rejected",
        "other": "pending",
    }
    assert session.exec(select(EventRevision)).one().status == "closed"
    assert session.exec(select(EventPromoCode)).one().status == "rejected"
    session.refresh(pair)
    session.refresh(trio)
    assert (pair.status, trio.status) == ("dismissed", "pending")
    assert {
        m.event_id
        for m in session.exec(
            select(EventDuplicateMember).where(EventDuplicateMember.group_id == trio.id)
        )
    } == {"other", "third"}


@pytest.mark.unit
def test_a_new_public_event_waits_on_one_creation_change(session):
    from backend.db.models import EventRevision
    from backend.services.event_visibility import set_event_status

    synced = _event("synced", "pending")
    live = _event("live", "reviewed")
    session.add_all([synced, live])
    session.commit()

    change = session.exec(select(EventRevision)).one()
    assert (change.event_id, change.kind, change.source, change.status) == (
        "synced",
        "create",
        "sync",
        "pending",
    )

    set_event_status(synced, "published")
    session.commit()
    session.refresh(change)
    assert change.status == "accepted"

    set_event_status(synced, "new")
    session.commit()
    open_changes = session.exec(
        select(EventRevision).where(EventRevision.status == "pending")
    ).all()
    assert [(c.event_id, c.kind) for c in open_changes] == [("synced", "create")]

    set_event_status(synced, "removed", "admin")
    session.commit()
    assert (
        session.exec(
            select(EventRevision.status).where(EventRevision.id == open_changes[0].id)
        ).one()
        == "closed"
    )


@pytest.mark.unit
def test_a_go_public_request_is_a_change(session):
    from backend.db.models import EventRevision, EventSuggestion

    owner = _owner(session)
    _submission(session, owner.id, "private", status="private")
    suggestion = session.exec(select(EventSuggestion)).one()
    assert session.exec(select(EventRevision)).all() == []

    suggestion.status = "pending"
    session.commit()
    change = session.exec(select(EventRevision)).one()
    assert (change.suggestion_id, change.kind, change.status) == (
        suggestion.id,
        "go_public",
        "pending",
    )

    suggestion.status = "declined"
    suggestion.reviewed_by = "admin@example.com"
    session.commit()
    session.refresh(change)
    assert (change.status, change.decided_by) == ("rejected", "admin@example.com")


@pytest.mark.unit
def test_status_backfill_migration(session, monkeypatch):
    import importlib

    from sqlalchemy import text

    from backend.db.models import BlockedEvent, EventSuggestion

    migration = importlib.import_module(
        "backend.db.alembic.versions.es1a2b3c4d5e_cached_event_status"
    )

    def suggestion(status):
        row = EventSuggestion(
            title=status,
            start=datetime(2026, 10, 1),
            end=datetime(2026, 10, 1),
            status=status,
        )
        session.add(row)
        session.flush()
        return row.id

    rows = {
        "pending": _event("pending", "pending"),
        "published": _event("published", "reviewed"),
        "hidden": _event("hidden", "reviewed"),
        "cancelled": _event("cancelled", "reviewed"),
        "gone": _event("gone", "reviewed"),
        "blocked": _event("blocked", "reviewed"),
        "dup": _event("dup", "reviewed"),
        "owner": _event("owner", "reviewed"),
        "rejected": _event("rejected", "reviewed"),
        "orphan": _event("orphan", "reviewed"),
    }
    rows["hidden"].is_hidden = True
    rows["cancelled"].is_cancelled = True
    rows["gone"].deleted_at = datetime(2026, 9, 1)
    for key in ("blocked", "dup", "owner", "rejected", "orphan"):
        rows[key].is_hidden = True
    rows["owner"].suggestion_id = suggestion("withdrawn")
    rows["rejected"].suggestion_id = suggestion("blocked")
    rows["orphan"].suggestion_id = suggestion("approved")
    session.add_all(rows.values())
    session.add(BlockedEvent(event_id="blocked", reason="deleted"))
    session.add(BlockedEvent(event_id="dup", reason="duplicate"))
    session.commit()
    connection = session.connection()
    connection.execute(
        text("UPDATE cached_events SET status = 'pending', status_reason = NULL")
    )

    class _Op:
        def execute(self, sql):
            connection.execute(text(sql))

        def __getattr__(self, _name):
            return lambda *args, **kwargs: None

    monkeypatch.setattr(migration, "op", _Op())
    migration.upgrade()

    result = dict(
        (row[0], (row[1], row[2]))
        for row in connection.execute(
            text("SELECT event_id, status, status_reason FROM cached_events")
        )
    )
    assert result == {
        "pending": ("pending", None),
        "published": ("published", None),
        "hidden": ("hidden", None),
        "cancelled": ("cancelled", None),
        "gone": ("removed", "google_calendar"),
        "blocked": ("removed", "admin"),
        "dup": ("removed", "duplicate"),
        "owner": ("removed", "owner"),
        "rejected": ("removed", "admin"),
        "orphan": ("removed", "series_edit"),
    }
