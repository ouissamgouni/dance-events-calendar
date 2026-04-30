"""Unit tests for the calendar default tags feature.

Covers:
  - GET  /api/admin/calendars/{id}/default-tags
  - PUT  /api/admin/calendars/{id}/default-tags
  - SyncService: new events receive default tags; existing events do not.
"""

import pytest
from datetime import datetime
from unittest.mock import MagicMock, call

from fastapi.testclient import TestClient
from sqlmodel import Session

from backend.api.main import app
from backend.api.deps import require_admin
from backend.db.database import get_session
from backend.db.models import (
    CalendarDefaultTag,
    CalendarSetting,
    CachedEvent,
    EventTag,
    Tag,
)


# ── Shared helpers ─────────────────────────────────────────────────────────────


def _mock_session():
    session = MagicMock(spec=Session)
    session._added = []
    session._deleted = []
    session.add.side_effect = session._added.append
    session.delete.side_effect = session._deleted.append
    return session


def _make_calendar(cal_id="cal-001"):
    return CalendarSetting(
        calendar_id=cal_id,
        name="Salsa Events",
        enabled=True,
        color="#e11d48",
    )


def _make_default_tag_row(cal_id="cal-001", tag_id=1):
    return CalendarDefaultTag(calendar_id=cal_id, tag_id=tag_id)


def _make_tag(tag_id=1):
    return Tag(id=tag_id, group_id=1, slug="salsa", label="Salsa", ordinal=0)


@pytest.fixture
def admin_client():
    session = _mock_session()
    app.dependency_overrides[get_session] = lambda: session
    app.dependency_overrides[require_admin] = lambda: {"sub": "admin"}
    yield TestClient(app), session
    app.dependency_overrides.clear()


# ── GET /api/admin/calendars/{id}/default-tags ────────────────────────────────


@pytest.mark.unit
class TestGetCalendarDefaultTags:
    def test_returns_empty_list_when_no_defaults(self, admin_client):
        c, session = admin_client
        session.get.return_value = _make_calendar()
        session.exec.return_value.all.return_value = []

        resp = c.get("/api/admin/calendars/cal-001/default-tags")

        assert resp.status_code == 200
        body = resp.json()
        assert body["calendar_id"] == "cal-001"
        assert body["tag_ids"] == []

    def test_returns_configured_tag_ids(self, admin_client):
        c, session = admin_client
        session.get.return_value = _make_calendar()
        rows = [_make_default_tag_row(tag_id=1), _make_default_tag_row(tag_id=3)]
        session.exec.return_value.all.return_value = rows

        resp = c.get("/api/admin/calendars/cal-001/default-tags")

        assert resp.status_code == 200
        assert sorted(resp.json()["tag_ids"]) == [1, 3]

    def test_returns_404_when_calendar_missing(self, admin_client):
        c, session = admin_client
        session.get.return_value = None  # calendar not found

        resp = c.get("/api/admin/calendars/nonexistent/default-tags")

        assert resp.status_code == 404

    def test_requires_admin(self):
        """Unauthenticated request must be rejected."""
        session = _mock_session()
        # Do NOT override require_admin
        app.dependency_overrides[get_session] = lambda: session
        try:
            c = TestClient(app)
            resp = c.get("/api/admin/calendars/cal-001/default-tags")
            assert resp.status_code in (401, 403)
        finally:
            app.dependency_overrides.clear()


# ── PUT /api/admin/calendars/{id}/default-tags ────────────────────────────────


@pytest.mark.unit
class TestSetCalendarDefaultTags:
    def test_replaces_existing_tags(self, admin_client):
        c, session = admin_client
        cal = _make_calendar()
        session.get.return_value = cal

        old_row = _make_default_tag_row(tag_id=99)
        session.exec.return_value.all.return_value = [old_row]

        tag = _make_tag(tag_id=1)
        # exec for valid_tags query returns [tag]
        # exec for existing rows query returns [old_row]
        session.exec.return_value.all.side_effect = [[tag], [old_row]]

        resp = c.put(
            "/api/admin/calendars/cal-001/default-tags",
            json={"tag_ids": [1]},
        )

        assert resp.status_code == 200
        assert resp.json()["tag_ids"] == [1]
        # Old row was deleted
        assert old_row in session._deleted
        # New CalendarDefaultTag was added
        added_defaults = [
            o for o in session._added if isinstance(o, CalendarDefaultTag)
        ]
        assert len(added_defaults) == 1
        assert added_defaults[0].tag_id == 1
        assert added_defaults[0].calendar_id == "cal-001"

    def test_ignores_invalid_tag_ids(self, admin_client):
        c, session = admin_client
        session.get.return_value = _make_calendar()
        # Only tag 1 is valid; tag 999 does not exist in DB
        tag = _make_tag(tag_id=1)
        session.exec.return_value.all.side_effect = [[tag], []]

        resp = c.put(
            "/api/admin/calendars/cal-001/default-tags",
            json={"tag_ids": [1, 999]},
        )

        assert resp.status_code == 200
        assert resp.json()["tag_ids"] == [1]

    def test_empty_tag_ids_clears_all_defaults(self, admin_client):
        c, session = admin_client
        session.get.return_value = _make_calendar()
        old_row = _make_default_tag_row(tag_id=5)
        # valid_tags query → no results; existing rows → [old_row]
        session.exec.return_value.all.side_effect = [[], [old_row]]

        resp = c.put(
            "/api/admin/calendars/cal-001/default-tags",
            json={"tag_ids": []},
        )

        assert resp.status_code == 200
        assert resp.json()["tag_ids"] == []
        assert old_row in session._deleted

    def test_returns_404_when_calendar_missing(self, admin_client):
        c, session = admin_client
        session.get.return_value = None

        resp = c.put(
            "/api/admin/calendars/nonexistent/default-tags",
            json={"tag_ids": [1]},
        )

        assert resp.status_code == 404


# ── SyncService: default tags applied only to NEW events ──────────────────────


def _make_calendar_setting(cal_id="cal-1"):
    from backend.db.models import CalendarSetting

    return CalendarSetting(
        calendar_id=cal_id,
        name="Test Calendar",
        enabled=True,
    )


def _make_calendar_event(event_id="evt-new", calendar_id="cal-1"):
    from backend.services.calendar.base import CalendarEvent

    return CalendarEvent(
        event_id=event_id,
        calendar_id=calendar_id,
        title="New Salsa Social",
        description=None,
        location=None,
        start=datetime(2026, 6, 1, 20, 0),
        end=datetime(2026, 6, 1, 23, 0),
        all_day=False,
    )


def _make_sync_service_with(events=None, deleted_ids=None):
    from backend.services.calendar.base import SyncResult
    from backend.services.sync_service import SyncService

    cal_svc = MagicMock()
    cal_svc.get_events.return_value = SyncResult(
        events=events or [],
        deleted_event_ids=deleted_ids or [],
        next_sync_token=None,
    )
    svc = SyncService(cal_svc)
    svc.pipeline = MagicMock()
    svc.pipeline.run.return_value = MagicMock(to_dict=lambda: {})
    return svc


@pytest.mark.unit
class TestSyncServiceDefaultTags:
    def test_new_event_gets_default_tags(self):
        """EventTag rows are added for each default tag when a new event is synced."""
        default_tag = CalendarDefaultTag(calendar_id="cal-1", tag_id=7)

        svc = _make_sync_service_with(events=[_make_calendar_event()])
        session = MagicMock()
        session.get.return_value = None  # event is new
        session.exec.return_value.all.return_value = [default_tag]
        session.exec.return_value.first.return_value = None  # no content-hash duplicate

        svc.sync_calendar(session, _make_calendar_setting())

        added = session.add.call_args_list
        event_tags_added = [c[0][0] for c in added if isinstance(c[0][0], EventTag)]
        assert len(event_tags_added) == 1
        assert event_tags_added[0].event_id == "evt-new"
        assert event_tags_added[0].tag_id == 7

    def test_existing_event_does_not_get_default_tags(self):
        """Re-syncing an existing event must NOT apply default tags."""
        default_tag = CalendarDefaultTag(calendar_id="cal-1", tag_id=7)

        svc = _make_sync_service_with(events=[_make_calendar_event()])
        existing = MagicMock()
        existing.title = "New Salsa Social"
        existing.description = None
        existing.location = None
        existing.start = datetime(2026, 6, 1, 20, 0)
        existing.end = datetime(2026, 6, 1, 23, 0)
        existing.all_day = False
        existing.latitude = None
        existing.price_min = None
        existing.links = None

        session = MagicMock()
        session.get.return_value = existing  # event already in DB
        session.exec.return_value.all.return_value = [default_tag]

        svc.sync_calendar(session, _make_calendar_setting())

        added = session.add.call_args_list
        event_tags_added = [c[0][0] for c in added if isinstance(c[0][0], EventTag)]
        assert event_tags_added == [], (
            "Default tags must NOT be applied to existing events"
        )

    def test_multiple_default_tags_all_applied_to_new_event(self):
        """All configured default tags are applied when a new event is synced."""
        defaults = [
            CalendarDefaultTag(calendar_id="cal-1", tag_id=3),
            CalendarDefaultTag(calendar_id="cal-1", tag_id=5),
        ]

        svc = _make_sync_service_with(events=[_make_calendar_event()])
        session = MagicMock()
        session.get.return_value = None  # new event
        session.exec.return_value.all.return_value = defaults
        session.exec.return_value.first.return_value = None  # no content-hash duplicate

        svc.sync_calendar(session, _make_calendar_setting())

        added = session.add.call_args_list
        event_tags_added = [c[0][0] for c in added if isinstance(c[0][0], EventTag)]
        applied_tag_ids = {et.tag_id for et in event_tags_added}
        assert applied_tag_ids == {3, 5}

    def test_no_default_tags_configured_no_event_tags_added(self):
        """If a calendar has no default tags, no EventTag rows are created."""
        svc = _make_sync_service_with(events=[_make_calendar_event()])
        session = MagicMock()
        session.get.return_value = None  # new event
        session.exec.return_value.all.return_value = []  # no defaults
        session.exec.return_value.first.return_value = None  # no content-hash duplicate

        svc.sync_calendar(session, _make_calendar_setting())

        added = session.add.call_args_list
        event_tags_added = [c[0][0] for c in added if isinstance(c[0][0], EventTag)]
        assert event_tags_added == []
