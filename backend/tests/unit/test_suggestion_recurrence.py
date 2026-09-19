"""Occurrence fan-out for user-declared recurring suggestions.

Exercises the CachedEvent materialisation helpers in
``backend.api.routes.suggestions`` and the rolling-window extension job
against a real (in-memory) database rather than mocks, because the behaviour
under test is mostly about what ends up in the tables.
"""

import os
from datetime import datetime, timedelta

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

os.environ.setdefault("SESSION_SECRET", "test-secret-suggestion-recurrence")

from backend.db import database as database_module  # noqa: E402
from backend.db.models import (  # noqa: E402
    CachedEvent,
    EventSeries,
    EventSeriesMember,
    EventSuggestion,
    User,
    UserEventAttendance,
)
from backend.api.routes import suggestions as suggestions_module  # noqa: E402
from backend.api.routes.suggestions import (  # noqa: E402
    PREVIEW_HORIZON_DAYS,
    PREVIEW_OCCURRENCE_LIMIT,
    _apply_creator_going,
    _link_occurrences_to_series,
    _occurrence_event_id,
    _upsert_occurrences_from_suggestion,
)
from backend.services import recurrence_extension  # noqa: E402

START = datetime(2026, 3, 2, 20, 0)  # a Monday
END = datetime(2026, 3, 2, 23, 0)
CALENDAR_ID = "user-submissions"


@pytest.fixture
def engine():
    eng = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(eng)
    prev = database_module._engine
    database_module._engine = eng
    yield eng
    database_module._engine = prev
    SQLModel.metadata.drop_all(eng)


def _suggestion(session, *, status="pending", **overrides) -> EventSuggestion:
    suggestion = EventSuggestion(
        title="Monday Social",
        start=START,
        end=END,
        status=status,
        **overrides,
    )
    session.add(suggestion)
    session.commit()
    session.refresh(suggestion)
    return suggestion


def _materialize(session, suggestion, **kwargs):
    events = _upsert_occurrences_from_suggestion(
        session,
        suggestion,
        review_status=kwargs.pop("review_status", "reviewed"),
        calendar_id=CALENDAR_ID,
        latitude=None,
        longitude=None,
        **kwargs,
    )
    session.add(suggestion)
    session.commit()
    return events


class TestOccurrenceIds:
    def test_first_occurrence_keeps_the_historical_id(self):
        suggestion = EventSuggestion(
            title="T", start=START, end=END, created_event_id="legacy-id"
        )
        assert _occurrence_event_id(suggestion, 0) == "legacy-id"
        assert _occurrence_event_id(suggestion, 3) == f"suggestion-{suggestion.id}-3"

    def test_falls_back_to_the_suggestion_id(self):
        suggestion = EventSuggestion(title="T", start=START, end=END)
        assert _occurrence_event_id(suggestion, 0) == f"suggestion-{suggestion.id}"


class TestMaterialization:
    def test_submit_materializes_a_bounded_preview(self, engine):
        with Session(engine) as session:
            suggestion = _suggestion(
                session, recurrence_rule="RRULE:FREQ=WEEKLY;COUNT=30"
            )
            _materialize(
                session,
                suggestion,
                review_status="pending",
                limit=PREVIEW_OCCURRENCE_LIMIT,
                horizon_end=START + timedelta(days=PREVIEW_HORIZON_DAYS),
            )

            rows = session.exec(select(CachedEvent).order_by(CachedEvent.start)).all()
            # The submitter sees more than one date, but nowhere near all 30.
            assert 1 < len(rows) <= PREVIEW_OCCURRENCE_LIMIT
            assert rows[0].start == START
            assert all(row.review_status == "pending" for row in rows)
            assert all(row.suggestion_id == suggestion.id for row in rows)
            assert suggestion.created_event_id == rows[0].event_id

    def test_approval_expands_the_whole_series(self, engine):
        with Session(engine) as session:
            suggestion = _suggestion(
                session, recurrence_rule="RRULE:FREQ=WEEKLY;COUNT=4"
            )
            _materialize(session, suggestion, review_status="pending", limit=1)
            events = _materialize(session, suggestion)

            assert len(events) == 4
            rows = session.exec(select(CachedEvent).order_by(CachedEvent.start)).all()
            assert [row.start for row in rows] == [
                START + timedelta(days=7 * i) for i in range(4)
            ]
            # Duration and the anchor id both survive the second pass.
            assert all(row.end - row.start == END - START for row in rows)
            assert all(row.suggestion_id == suggestion.id for row in rows)
            assert suggestion.created_event_id == rows[0].event_id

    def test_explicit_dates_keep_their_own_durations(self, engine):
        with Session(engine) as session:
            suggestion = _suggestion(
                session,
                recurrence_dates=[
                    {"start": "2026-03-02T20:00:00", "end": "2026-03-02T23:00:00"},
                    {"start": "2026-04-11T14:00:00", "end": "2026-04-12T02:00:00"},
                ],
            )
            events = _materialize(session, suggestion)

            assert len(events) == 2
            assert events[0].end - events[0].start == timedelta(hours=3)
            assert events[1].end - events[1].start == timedelta(hours=12)

    def test_shrinking_the_recurrence_hides_orphaned_occurrences(self, engine):
        with Session(engine) as session:
            suggestion = _suggestion(
                session, recurrence_rule="RRULE:FREQ=WEEKLY;COUNT=4"
            )
            _materialize(session, suggestion)
            assert len(session.exec(select(CachedEvent)).all()) == 4

            suggestion.recurrence_rule = "RRULE:FREQ=WEEKLY;COUNT=2"
            kept = _materialize(session, suggestion)

            kept_ids = {event.event_id for event in kept}
            rows = session.exec(select(CachedEvent)).all()
            assert len(rows) == 4  # rows are hidden, never deleted
            assert {row.event_id for row in rows if not row.is_hidden} == kept_ids
            assert len(kept_ids) == 2

    def test_re_expanding_reuses_the_hidden_rows(self, engine):
        with Session(engine) as session:
            suggestion = _suggestion(
                session, recurrence_rule="RRULE:FREQ=WEEKLY;COUNT=3"
            )
            _materialize(session, suggestion)
            suggestion.recurrence_rule = "RRULE:FREQ=WEEKLY;COUNT=1"
            _materialize(session, suggestion)
            suggestion.recurrence_rule = "RRULE:FREQ=WEEKLY;COUNT=3"
            _materialize(session, suggestion)

            rows = session.exec(select(CachedEvent)).all()
            assert len(rows) == 3
            assert not any(row.is_hidden for row in rows)


class TestSeriesLinking:
    def test_links_every_occurrence_under_one_series(self, engine):
        with Session(engine) as session:
            suggestion = _suggestion(
                session, recurrence_rule="RRULE:FREQ=WEEKLY;COUNT=3"
            )
            events = _materialize(session, suggestion)
            series = _link_occurrences_to_series(
                session, suggestion, events, "admin@x.io"
            )
            session.commit()

            assert series is not None
            assert series.status == "resolved"
            assert series.source == "manual"
            members = session.exec(select(EventSeriesMember)).all()
            assert {member.event_id for member in members} == {
                event.event_id for event in events
            }
            assert {member.series_id for member in members} == {series.id}

    def test_single_occurrence_creates_no_series(self, engine):
        with Session(engine) as session:
            suggestion = _suggestion(session)
            events = _materialize(session, suggestion)
            assert (
                _link_occurrences_to_series(session, suggestion, events, None) is None
            )
            session.commit()
            assert session.exec(select(EventSeries)).all() == []

    def test_second_pass_reuses_the_existing_series(self, engine):
        with Session(engine) as session:
            suggestion = _suggestion(
                session, recurrence_rule="RRULE:FREQ=WEEKLY;COUNT=2"
            )
            events = _materialize(session, suggestion)
            first = _link_occurrences_to_series(session, suggestion, events, None)
            session.commit()

            suggestion.recurrence_rule = "RRULE:FREQ=WEEKLY;COUNT=4"
            events = _materialize(session, suggestion)
            second = _link_occurrences_to_series(session, suggestion, events, None)
            session.commit()

            assert second is not None and first is not None
            assert second.id == first.id
            assert len(session.exec(select(EventSeries)).all()) == 1
            # event_id is globally unique in event_series_members, so the
            # already-linked rows must not be inserted twice.
            assert len(session.exec(select(EventSeriesMember)).all()) == 4


class TestExtensionJob:
    def _approved(self, session, **overrides):
        suggestion = _suggestion(
            session,
            status="approved",
            assigned_calendar_id=CALENDAR_ID,
            **overrides,
        )
        return suggestion

    def test_extends_an_open_ended_series_to_the_new_horizon(self, engine):
        with Session(engine) as session:
            suggestion = self._approved(session, recurrence_rule="RRULE:FREQ=WEEKLY")
            _materialize(
                session, suggestion, limit=4, horizon_end=START + timedelta(days=21)
            )
            suggestion_id = suggestion.id
            assert len(session.exec(select(CachedEvent)).all()) == 4

        stats = recurrence_extension.run_once()

        assert stats["series_extended"] == 1
        assert stats["occurrences_created"] > 0
        with Session(engine) as session:
            rows = session.exec(
                select(CachedEvent).where(CachedEvent.suggestion_id == suggestion_id)
            ).all()
            assert len(rows) > 4
            assert not any(row.is_hidden for row in rows)

    def test_is_a_no_op_for_bounded_and_pending_series(self, engine):
        with Session(engine) as session:
            bounded = self._approved(
                session, recurrence_rule="RRULE:FREQ=WEEKLY;COUNT=3"
            )
            _materialize(session, bounded)
            pending = _suggestion(
                session,
                recurrence_rule="RRULE:FREQ=WEEKLY",
                assigned_calendar_id=CALENDAR_ID,
            )
            _materialize(session, pending, review_status="pending", limit=1)

        assert recurrence_extension.run_once() == {
            "series_extended": 0,
            "occurrences_created": 0,
        }

    def test_ignores_non_recurring_suggestions(self, engine):
        with Session(engine) as session:
            suggestion = self._approved(session)
            _materialize(session, suggestion)

        assert recurrence_extension.run_once() == {
            "series_extended": 0,
            "occurrences_created": 0,
        }


class TestCreatorGoing:
    """The submitter's "I'm going" must cover the whole declared recurrence.

    Occurrences appear in three waves (preview on submit, full horizon on
    approval, rolling window for open-ended rules), so the RSVP is replayed on
    each one — while the follower notification fires exactly once.
    """

    def _user(self, session, *, default_audience=None) -> User:
        user = User(
            email="alice@example.com",
            display_name="Alice",
            share_attendance_default_audience=default_audience,
        )
        session.add(user)
        session.commit()
        session.refresh(user)
        return user

    def _going_event_ids(self, session) -> set[str]:
        return {row.event_id for row in session.exec(select(UserEventAttendance)).all()}

    def test_covers_every_preview_occurrence(self, engine):
        with Session(engine) as session:
            user = self._user(session)
            suggestion = _suggestion(
                session,
                recurrence_rule="RRULE:FREQ=WEEKLY;COUNT=30",
                submitter_user_id=user.id,
                creator_going=True,
                creator_going_audience="friends",
            )
            events = _materialize(
                session,
                suggestion,
                review_status="pending",
                limit=PREVIEW_OCCURRENCE_LIMIT,
                horizon_end=START + timedelta(days=PREVIEW_HORIZON_DAYS),
            )
            _apply_creator_going(session, suggestion, events, fan_out=True)
            session.commit()

            assert len(events) > 1
            assert self._going_event_ids(session) == {e.event_id for e in events}
            rows = session.exec(select(UserEventAttendance)).all()
            assert all(row.user_id == user.id for row in rows)
            assert all(row.share_audience == "friends" for row in rows)
            assert not any(row.share_publicly for row in rows)

    def test_fans_out_once_for_the_whole_series(self, engine, monkeypatch):
        calls = []
        monkeypatch.setattr(
            suggestions_module,
            "fan_out_going",
            lambda session, actor, event_id, **kw: calls.append(event_id) or 0,
        )
        with Session(engine) as session:
            user = self._user(session)
            suggestion = _suggestion(
                session,
                recurrence_rule="RRULE:FREQ=WEEKLY;COUNT=6",
                submitter_user_id=user.id,
                creator_going=True,
            )
            events = _materialize(session, suggestion, review_status="pending")
            _apply_creator_going(session, suggestion, events, fan_out=True)
            session.commit()

            assert len(events) == 6
            assert calls == [events[0].event_id]

    def test_later_waves_do_not_fan_out_again(self, engine, monkeypatch):
        calls = []
        monkeypatch.setattr(
            suggestions_module,
            "fan_out_going",
            lambda session, actor, event_id, **kw: calls.append(event_id) or 0,
        )
        with Session(engine) as session:
            user = self._user(session)
            suggestion = _suggestion(
                session,
                recurrence_rule="RRULE:FREQ=WEEKLY;COUNT=4",
                submitter_user_id=user.id,
                creator_going=True,
            )
            events = _materialize(session, suggestion)
            _apply_creator_going(session, suggestion, events, fan_out=False)
            session.commit()

            assert calls == []
            assert len(self._going_event_ids(session)) == 4

    def test_approval_backfills_the_expanded_occurrences(self, engine):
        with Session(engine) as session:
            user = self._user(session)
            suggestion = _suggestion(
                session,
                recurrence_rule="RRULE:FREQ=WEEKLY;COUNT=4",
                submitter_user_id=user.id,
                creator_going=True,
            )
            preview = _materialize(
                session, suggestion, review_status="pending", limit=1
            )
            _apply_creator_going(session, suggestion, preview, fan_out=True)
            session.commit()
            assert len(self._going_event_ids(session)) == 1

            approved = _materialize(session, suggestion)
            _apply_creator_going(session, suggestion, approved, fan_out=False)
            session.commit()

            assert self._going_event_ids(session) == {e.event_id for e in approved}
            assert len(approved) == 4

    def test_extension_job_covers_new_occurrences(self, engine):
        with Session(engine) as session:
            user = self._user(session)
            suggestion = _suggestion(
                session,
                status="approved",
                assigned_calendar_id=CALENDAR_ID,
                recurrence_rule="RRULE:FREQ=WEEKLY",
                submitter_user_id=user.id,
                creator_going=True,
            )
            events = _materialize(
                session, suggestion, limit=4, horizon_end=START + timedelta(days=21)
            )
            _apply_creator_going(session, suggestion, events, fan_out=True)
            session.commit()
            suggestion_id = suggestion.id
            assert len(self._going_event_ids(session)) == 4

        recurrence_extension.run_once()

        with Session(engine) as session:
            rows = session.exec(
                select(CachedEvent).where(CachedEvent.suggestion_id == suggestion_id)
            ).all()
            assert len(rows) > 4
            assert self._going_event_ids(session) == {row.event_id for row in rows}

    def test_opting_out_stops_future_occurrences(self, engine):
        with Session(engine) as session:
            user = self._user(session)
            suggestion = _suggestion(
                session,
                status="approved",
                assigned_calendar_id=CALENDAR_ID,
                recurrence_rule="RRULE:FREQ=WEEKLY",
                submitter_user_id=user.id,
                creator_going=False,
            )
            _materialize(
                session, suggestion, limit=4, horizon_end=START + timedelta(days=21)
            )
            session.commit()

        recurrence_extension.run_once()

        with Session(engine) as session:
            assert self._going_event_ids(session) == set()

    def test_anonymous_submissions_are_skipped(self, engine):
        with Session(engine) as session:
            suggestion = _suggestion(
                session,
                recurrence_rule="RRULE:FREQ=WEEKLY;COUNT=3",
                creator_going=True,
            )
            events = _materialize(session, suggestion)
            _apply_creator_going(session, suggestion, events, fan_out=True)
            session.commit()

            assert self._going_event_ids(session) == set()

    def test_audience_falls_back_to_the_account_default(self, engine):
        with Session(engine) as session:
            user = self._user(session, default_audience="public")
            suggestion = _suggestion(
                session,
                submitter_user_id=user.id,
                creator_going=True,
                creator_going_audience=None,
            )
            events = _materialize(session, suggestion)
            _apply_creator_going(session, suggestion, events, fan_out=False)
            session.commit()

            row = session.exec(select(UserEventAttendance)).one()
            assert row.share_audience == "public"
            assert row.share_publicly is True
