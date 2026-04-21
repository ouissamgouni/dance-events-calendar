"""Critical tests for GDPR tracking endpoints."""

import pytest
from unittest.mock import MagicMock, patch, call
from fastapi.testclient import TestClient
from sqlmodel import Session

from backend.api.main import app
from backend.db.database import get_session
from backend.db.models import EventView, EventSave, EventLinkClick, EventExport


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
class TestGDPRDataDeletion:
    def test_delete_user_data(self, client):
        c, session = client
        # Mock exec to return some records
        mock_view = MagicMock(spec=EventView)
        mock_save = MagicMock(spec=EventSave)
        mock_click = MagicMock(spec=EventLinkClick)

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
        # Verify delete was called for each record
        assert session.delete.call_count == 3

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
