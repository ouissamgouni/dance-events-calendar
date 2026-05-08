"""Critical tests for GDPR tracking endpoints."""

import pytest
from unittest.mock import MagicMock, patch, call, AsyncMock
from fastapi.testclient import TestClient
from sqlmodel import Session

from backend.api.main import app
from backend.db.database import get_session
from backend.db.models import (
    EventView,
    EventSave,
    EventLinkClick,
    EventExport,
    EventAttendance,
    UserEventAttendance,
    UserSavedEvent,
    ShareToken,
)


def _mock_session():
    """Create a mock session that tracks added/deleted objects."""
    session = MagicMock(spec=Session)
    session._added = []
    session._deleted = []

    def mock_add(obj):
        session._added.append(obj)

    def mock_delete(obj):
        session._deleted.append(obj)

    session.add.side_effect = mock_add
    session.delete.side_effect = mock_delete
    return session


@pytest.fixture
def client():
    session = _mock_session()
    app.dependency_overrides[get_session] = lambda: session
    yield TestClient(app), session
    app.dependency_overrides.clear()


@pytest.mark.unit
class TestTrackingEndpoints:
    def test_track_event_view_minimal(self, client):
        c, session = client
        with patch("backend.api.routes.tracking._update_view_geo", new=AsyncMock()):
            resp = c.post("/api/track/event-view", json={"event_id": "ev1"})
        assert resp.status_code == 201
        assert len(session._added) == 1
        view = session._added[0]
        assert isinstance(view, EventView)
        assert view.event_id == "ev1"
        assert view.device_id is None
        assert view.source is None

    def test_track_event_view_with_source_and_device(self, client):
        c, session = client
        with patch("backend.api.routes.tracking._update_view_geo", new=AsyncMock()):
            resp = c.post(
                "/api/track/event-view",
                json={
                    "event_id": "ev2",
                    "device_id": "dev-123",
                    "source": "calendar",
                },
            )
        assert resp.status_code == 201
        view = session._added[0]
        assert view.device_id == "dev-123"
        assert view.source == "calendar"

    def test_track_event_view_invalid_source(self, client):
        c, _ = client
        resp = c.post(
            "/api/track/event-view",
            json={
                "event_id": "ev1",
                "source": "invalid",
            },
        )
        assert resp.status_code == 422

    def test_track_link_click(self, client):
        c, session = client
        with patch("backend.api.routes.tracking._update_click_geo", new=AsyncMock()):
            resp = c.post(
                "/api/track/link-click",
                json={
                    "event_id": "ev1",
                    "url": "https://example.com/event",
                },
            )
        assert resp.status_code == 201
        click = session._added[0]
        assert isinstance(click, EventLinkClick)
        assert click.url == "https://example.com/event"

    def test_track_link_click_url_required(self, client):
        c, _ = client
        resp = c.post("/api/track/link-click", json={"event_id": "ev1"})
        assert resp.status_code == 422

    def test_track_export(self, client):
        c, session = client
        resp = c.post(
            "/api/track/export",
            json={
                "format": "ics",
                "event_count": 5,
            },
        )
        assert resp.status_code == 201
        export = session._added[0]
        assert isinstance(export, EventExport)
        assert export.format == "ics"
        assert export.event_count == 5

    def test_track_export_invalid_format(self, client):
        c, _ = client
        resp = c.post(
            "/api/track/export",
            json={
                "format": "pdf",
                "event_count": 1,
            },
        )
        assert resp.status_code == 422


@pytest.mark.unit
class TestEventSaveUserSavedEvent:
    """track_event_save must maintain the UserSavedEvent materialized state table."""

    def test_save_action_adds_user_saved_event(self):
        session = MagicMock(spec=Session)
        # No existing UserSavedEvent row
        no_row = MagicMock()
        no_row.first.return_value = None
        session.exec.return_value = no_row

        app.dependency_overrides[get_session] = lambda: session
        try:
            c = TestClient(app)
            # Pin the anon-id cookie so the materialized row's device_id is
            # deterministic. Anonymous writes use the cookie, not the payload
            # device_id, as the dedupe key.
            c.cookies.set("movida_aid", "anon-cookie-fixed")
            resp = c.post(
                "/api/track/event-save",
                json={"event_id": "evt-1", "device_id": "dev-abc", "action": "save"},
            )
            assert resp.status_code == 201

            added = session.add.call_args_list
            types = [type(call.args[0]).__name__ for call in added]
            assert "EventSave" in types
            assert "UserSavedEvent" in types

            # Analytics row still keyed by payload device_id.
            event_save = next(
                call.args[0]
                for call in added
                if isinstance(call.args[0], EventSave)
            )
            assert event_save.device_id == "dev-abc"

            # Materialized state row keyed by the anon-id cookie value.
            user_saved = next(
                call.args[0]
                for call in added
                if isinstance(call.args[0], UserSavedEvent)
            )
            assert user_saved.event_id == "evt-1"
            assert user_saved.device_id == "anon-cookie-fixed"
        finally:
            app.dependency_overrides.clear()

    def test_save_action_skips_duplicate_user_saved_event(self):
        """If UserSavedEvent already exists, no duplicate is inserted."""
        session = MagicMock(spec=Session)
        existing = MagicMock(spec=UserSavedEvent)
        existing_result = MagicMock()
        existing_result.first.return_value = existing
        session.exec.return_value = existing_result

        app.dependency_overrides[get_session] = lambda: session
        try:
            c = TestClient(app)
            resp = c.post(
                "/api/track/event-save",
                json={"event_id": "evt-1", "device_id": "dev-abc", "action": "save"},
            )
            assert resp.status_code == 201

            added = session.add.call_args_list
            types = [type(call.args[0]).__name__ for call in added]
            assert "EventSave" in types
            assert "UserSavedEvent" not in types
        finally:
            app.dependency_overrides.clear()

    def test_unsave_action_deletes_user_saved_event(self):
        session = MagicMock(spec=Session)
        existing = MagicMock(spec=UserSavedEvent)
        existing_result = MagicMock()
        existing_result.first.return_value = existing
        session.exec.return_value = existing_result

        app.dependency_overrides[get_session] = lambda: session
        try:
            c = TestClient(app)
            resp = c.post(
                "/api/track/event-save",
                json={"event_id": "evt-1", "device_id": "dev-abc", "action": "unsave"},
            )
            assert resp.status_code == 201
            # New behaviour: unsave looks up rows by both the anon-id cookie
            # key and the payload device_id (back-compat). With this single
            # mock returning the same row for both lookups, delete is called
            # for each — in real DB the queries would target distinct rows.
            session.delete.assert_called_with(existing)
            assert session.delete.call_count >= 1
        finally:
            app.dependency_overrides.clear()

    def test_unsave_action_no_row_is_noop(self):
        """Unsaving an event that isn't in UserSavedEvent must not crash."""
        session = MagicMock(spec=Session)
        no_row = MagicMock()
        no_row.first.return_value = None
        session.exec.return_value = no_row

        app.dependency_overrides[get_session] = lambda: session
        try:
            c = TestClient(app)
            resp = c.post(
                "/api/track/event-save",
                json={"event_id": "evt-1", "device_id": "dev-abc", "action": "unsave"},
            )
            assert resp.status_code == 201
            session.delete.assert_not_called()
        finally:
            app.dependency_overrides.clear()


@pytest.mark.unit
class TestEventAttendanceEndpoint:
    """track_event_attendance validates input and writes EventAttendance + UserEventAttendance."""

    def test_going_action_accepted(self):
        session = MagicMock(spec=Session)
        no_row = MagicMock()
        no_row.first.return_value = None
        session.exec.return_value = no_row

        app.dependency_overrides[get_session] = lambda: session
        try:
            c = TestClient(app)
            resp = c.post(
                "/api/track/event-attendance",
                json={"event_id": "evt-1", "device_id": "dev-abc", "action": "going"},
            )
            assert resp.status_code == 201

            added_types = [
                type(call.args[0]).__name__ for call in session.add.call_args_list
            ]
            assert "EventAttendance" in added_types
            assert "UserEventAttendance" in added_types

            attendance = next(
                call.args[0]
                for call in session.add.call_args_list
                if isinstance(call.args[0], EventAttendance)
            )
            assert attendance.event_id == "evt-1"
            assert attendance.device_id == "dev-abc"
            assert attendance.action == "going"
        finally:
            app.dependency_overrides.clear()

    def test_not_going_action_accepted(self):
        session = MagicMock(spec=Session)
        existing = MagicMock(spec=UserEventAttendance)
        result = MagicMock()
        result.first.return_value = existing
        session.exec.return_value = result

        app.dependency_overrides[get_session] = lambda: session
        try:
            c = TestClient(app)
            resp = c.post(
                "/api/track/event-attendance",
                json={
                    "event_id": "evt-1",
                    "device_id": "dev-abc",
                    "action": "not_going",
                },
            )
            assert resp.status_code == 201
            # See note in test_unsave_action_deletes_user_saved_event — the
            # endpoint now performs an extra lookup for the legacy device_id
            # key, so the same mocked row may be deleted twice.
            session.delete.assert_called_with(existing)
        finally:
            app.dependency_overrides.clear()

    def test_invalid_action_rejected(self, client):
        c, _ = client
        resp = c.post(
            "/api/track/event-attendance",
            json={"event_id": "evt-1", "device_id": "dev-abc", "action": "maybe"},
        )
        assert resp.status_code == 422

    def test_missing_device_id_rejected(self, client):
        c, _ = client
        resp = c.post(
            "/api/track/event-attendance",
            json={"event_id": "evt-1", "action": "going"},
        )
        assert resp.status_code == 422

    def test_going_skips_duplicate_user_event_attendance(self):
        """If UserEventAttendance already exists, no duplicate is inserted."""
        session = MagicMock(spec=Session)
        existing = MagicMock(spec=UserEventAttendance)
        result = MagicMock()
        result.first.return_value = existing
        session.exec.return_value = result

        app.dependency_overrides[get_session] = lambda: session
        try:
            c = TestClient(app)
            resp = c.post(
                "/api/track/event-attendance",
                json={"event_id": "evt-1", "device_id": "dev-abc", "action": "going"},
            )
            assert resp.status_code == 201

            added_types = [
                type(call.args[0]).__name__ for call in session.add.call_args_list
            ]
            assert "EventAttendance" in added_types
            assert "UserEventAttendance" not in added_types
        finally:
            app.dependency_overrides.clear()

    def test_not_going_no_row_is_noop(self):
        """not_going when no UserEventAttendance row must not crash."""
        session = MagicMock(spec=Session)
        no_row = MagicMock()
        no_row.first.return_value = None
        session.exec.return_value = no_row

        app.dependency_overrides[get_session] = lambda: session
        try:
            c = TestClient(app)
            resp = c.post(
                "/api/track/event-attendance",
                json={
                    "event_id": "evt-1",
                    "device_id": "dev-abc",
                    "action": "not_going",
                },
            )
            assert resp.status_code == 201
            session.delete.assert_not_called()
        finally:
            app.dependency_overrides.clear()


@pytest.mark.unit
class TestGDPRDataDeletion:
    def test_delete_user_data(self, client):
        c, session = client
        mock_view = MagicMock(spec=EventView)
        mock_save = MagicMock(spec=EventSave)
        mock_click = MagicMock(spec=EventLinkClick)
        mock_user_saved = MagicMock(spec=UserSavedEvent)
        mock_token = MagicMock(spec=ShareToken)
        mock_attendance = MagicMock(spec=EventAttendance)
        mock_user_attendance = MagicMock(spec=UserEventAttendance)

        def mock_exec(stmt):
            result = MagicMock()
            sql_text = str(stmt)
            if "event_views" in sql_text:
                result.all.return_value = [mock_view]
            elif "event_saves" in sql_text:
                result.all.return_value = [mock_save]
            elif "event_link_clicks" in sql_text:
                result.all.return_value = [mock_click]
            elif "event_exports" in sql_text:
                result.all.return_value = []
            elif "user_saved_events" in sql_text:
                result.all.return_value = [mock_user_saved]
            elif "share_tokens" in sql_text:
                result.all.return_value = [mock_token]
            elif "event_attendances" in sql_text:
                result.all.return_value = [mock_attendance]
            elif "user_event_attendances" in sql_text:
                result.all.return_value = [mock_user_attendance]
            else:
                result.all.return_value = []
            return result

        session.exec.side_effect = mock_exec

        resp = c.delete("/api/user-data/device-abc")
        assert resp.status_code == 200
        data = resp.json()
        assert data["deleted"]["event_views"] == 1
        assert data["deleted"]["event_saves"] == 1
        assert data["deleted"]["event_link_clicks"] == 1
        assert data["deleted"]["event_exports"] == 0
        assert data["deleted"]["user_saved_events"] == 1
        assert data["deleted"]["share_tokens"] == 1
        assert data["deleted"]["event_attendances"] == 1
        assert data["deleted"]["user_event_attendances"] == 1
        # view + save + click + user_saved + token + attendance + user_attendance = 7 deletions
        assert session.delete.call_count == 7

    def test_delete_user_data_empty(self, client):
        c, session = client

        def mock_exec(stmt):
            result = MagicMock()
            result.all.return_value = []
            return result

        session.exec.side_effect = mock_exec

        resp = c.delete("/api/user-data/device-xyz")
        assert resp.status_code == 200
        data = resp.json()
        assert all(v == 0 for v in data["deleted"].values())
