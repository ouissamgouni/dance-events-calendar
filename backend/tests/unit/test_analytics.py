"""Unit tests for analytics endpoints."""

import pytest
from unittest.mock import MagicMock
from fastapi.testclient import TestClient
from sqlmodel import Session

from backend.api.main import app
from backend.api.deps import require_admin
from backend.db.database import get_session
from backend.db.models import (
    CachedEvent,
    EventView,
    EventAttendance,
    EventLinkClick,
    EventExport,
)


def _fake_admin():
    return {"email": "admin@example.com", "name": "Admin"}


@pytest.fixture(autouse=True)
def _visible_events(monkeypatch):
    # Per test, so other modules' auth gates don't see a leaked admin override.
    monkeypatch.setitem(app.dependency_overrides, require_admin, _fake_admin)
    # Mocked sessions return MagicMock events, which carry no real status.
    monkeypatch.setattr(
        "backend.api.routes.tracking.viewer_can_see_event", lambda *a, **k: True
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _row(*values):
    """Return a simple tuple standing in for a SQLAlchemy Row."""
    return tuple(values)


# ---------------------------------------------------------------------------
# most-viewed-events — unique_viewers
# ---------------------------------------------------------------------------


@pytest.mark.unit
class TestMostViewedEvents:
    def test_returns_unique_viewers(self):
        mock_session = MagicMock(spec=Session)

        # Row: (event_id, view_count, unique_viewers)
        view_rows = [_row("evt-1", 10, 7), _row("evt-2", 5, 3)]
        event_objs = [
            CachedEvent(
                event_id="evt-1",
                calendar_id="cal-1",
                title="Salsa Night",
                start=__import__("datetime").datetime(2026, 5, 1, 20, 0),
                end=__import__("datetime").datetime(2026, 5, 1, 23, 0),
            ),
            CachedEvent(
                event_id="evt-2",
                calendar_id="cal-1",
                title="Bachata Party",
                start=__import__("datetime").datetime(2026, 5, 2, 20, 0),
                end=__import__("datetime").datetime(2026, 5, 2, 23, 0),
            ),
        ]

        def mock_exec(stmt):
            result = MagicMock()
            sql = str(stmt).lower()
            if "event_views" in sql:
                result.all.return_value = view_rows
            elif "cached_events" in sql:
                result.all.return_value = event_objs
            else:
                result.all.return_value = []
            return result

        mock_session.exec = mock_exec
        app.dependency_overrides[get_session] = lambda: mock_session

        client = TestClient(app)
        resp = client.get("/api/admin/most-viewed-events")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 2
        assert data[0]["unique_viewers"] == 7
        assert data[0]["view_count"] == 10
        assert data[0]["title"] == "Salsa Night"

        app.dependency_overrides.pop(get_session, None)


# ---------------------------------------------------------------------------
# source-breakdown
# ---------------------------------------------------------------------------


@pytest.mark.unit
class TestSourceBreakdown:
    def test_aggregates_by_source(self):
        mock_session = MagicMock(spec=Session)
        source_rows = [
            _row("explorer-list", 50),
            _row("calendar", 30),
            _row("direct", 10),
        ]

        def mock_exec(stmt):
            result = MagicMock()
            result.all.return_value = source_rows
            return result

        mock_session.exec = mock_exec
        app.dependency_overrides[get_session] = lambda: mock_session

        client = TestClient(app)
        resp = client.get("/api/admin/analytics/source-breakdown")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 3
        assert data[0]["source"] == "explorer-list"
        assert data[0]["view_count"] == 50
        assert all("source" in row and "view_count" in row for row in data)

        app.dependency_overrides.pop(get_session, None)

    def test_returns_empty_when_no_views(self):
        mock_session = MagicMock(spec=Session)
        mock_session.exec = lambda _: MagicMock(all=lambda: [])
        app.dependency_overrides[get_session] = lambda: mock_session

        client = TestClient(app)
        resp = client.get("/api/admin/analytics/source-breakdown")
        assert resp.status_code == 200
        assert resp.json() == []

        app.dependency_overrides.pop(get_session, None)


# ---------------------------------------------------------------------------
# top-links
# ---------------------------------------------------------------------------


@pytest.mark.unit
class TestTopLinks:
    def test_returns_links_with_event_title(self):
        mock_session = MagicMock(spec=Session)
        link_rows = [
            _row("evt-1", "https://tickets.example.com", 15),
            _row("evt-2", "https://venue.example.com", 8),
        ]
        event_objs = [
            CachedEvent(
                event_id="evt-1",
                calendar_id="cal-1",
                title="Salsa Night",
                start=__import__("datetime").datetime(2026, 5, 1, 20, 0),
                end=__import__("datetime").datetime(2026, 5, 1, 23, 0),
            ),
            CachedEvent(
                event_id="evt-2",
                calendar_id="cal-1",
                title="Bachata Party",
                start=__import__("datetime").datetime(2026, 5, 2, 20, 0),
                end=__import__("datetime").datetime(2026, 5, 2, 23, 0),
            ),
        ]

        def mock_exec(stmt):
            result = MagicMock()
            sql = str(stmt).lower()
            if "event_link_clicks" in sql:
                result.all.return_value = link_rows
            elif "cached_events" in sql:
                result.all.return_value = event_objs
            else:
                result.all.return_value = []
            return result

        mock_session.exec = mock_exec
        app.dependency_overrides[get_session] = lambda: mock_session

        client = TestClient(app)
        resp = client.get("/api/admin/analytics/top-links")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 2
        assert data[0]["url"] == "https://tickets.example.com"
        assert data[0]["click_count"] == 15
        assert data[0]["event_title"] == "Salsa Night"

        app.dependency_overrides.pop(get_session, None)


# ---------------------------------------------------------------------------
# exports
# ---------------------------------------------------------------------------


@pytest.mark.unit
class TestAnalyticsExports:
    def test_aggregates_by_format(self):
        mock_session = MagicMock(spec=Session)
        export_rows = [_row("ics", 30, 450), _row("xlsx", 12, 180)]

        def mock_exec(stmt):
            result = MagicMock()
            result.all.return_value = export_rows
            return result

        mock_session.exec = mock_exec
        app.dependency_overrides[get_session] = lambda: mock_session

        client = TestClient(app)
        resp = client.get("/api/admin/analytics/exports")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 2
        assert data[0]["format"] == "ics"
        assert data[0]["export_count"] == 30
        assert data[0]["total_events_exported"] == 450

        app.dependency_overrides.pop(get_session, None)

    def test_returns_zero_total_when_null(self):
        """total_events_exported should be 0 when SUM returns None (no rows)."""
        mock_session = MagicMock(spec=Session)
        mock_session.exec = lambda _: MagicMock(all=lambda: [_row("ics", 1, None)])
        app.dependency_overrides[get_session] = lambda: mock_session

        client = TestClient(app)
        resp = client.get("/api/admin/analytics/exports")
        assert resp.status_code == 200
        assert resp.json()[0]["total_events_exported"] == 0

        app.dependency_overrides.pop(get_session, None)


# ---------------------------------------------------------------------------
# most-attended-events
# ---------------------------------------------------------------------------


@pytest.mark.unit
class TestMostAttendedEvents:
    def _make_event(self, event_id: str, title: str) -> CachedEvent:
        import datetime

        return CachedEvent(
            event_id=event_id,
            calendar_id="cal-1",
            title=title,
            start=datetime.datetime(2026, 5, 1, 20, 0),
            end=datetime.datetime(2026, 5, 1, 23, 0),
        )

    def test_returns_going_count_with_title(self):
        mock_session = MagicMock(spec=Session)
        # Rows: (event_id, going_count)
        going_rows = [_row("evt-1", 5), _row("evt-2", 2)]
        event_objs = [
            self._make_event("evt-1", "Salsa Night"),
            self._make_event("evt-2", "Bachata Party"),
        ]

        def mock_exec(stmt):
            result = MagicMock()
            sql = str(stmt).lower()
            if "event_attendances" in sql:
                result.all.return_value = going_rows
            elif "cached_events" in sql:
                result.all.return_value = event_objs
            else:
                result.all.return_value = []
            return result

        mock_session.exec = mock_exec
        app.dependency_overrides[get_session] = lambda: mock_session
        app.dependency_overrides[require_admin] = _fake_admin

        client = TestClient(app)
        resp = client.get("/api/admin/most-attended-events")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 2
        assert data[0]["event_id"] == "evt-1"
        assert data[0]["title"] == "Salsa Night"
        assert data[0]["going_count"] == 5
        assert data[1]["going_count"] == 2

        app.dependency_overrides.pop(get_session, None)

    def test_returns_empty_when_no_going(self):
        mock_session = MagicMock(spec=Session)
        mock_session.exec = lambda _: MagicMock(all=lambda: [])
        app.dependency_overrides[get_session] = lambda: mock_session
        app.dependency_overrides[require_admin] = _fake_admin

        client = TestClient(app)
        resp = client.get("/api/admin/most-attended-events")
        assert resp.status_code == 200
        assert resp.json() == []

        app.dependency_overrides.pop(get_session, None)

    def test_unknown_event_id_shows_fallback_title(self):
        """If an event_id is not found in CachedEvent, title falls back to 'Unknown'."""
        mock_session = MagicMock(spec=Session)
        going_rows = [_row("evt-orphan", 3)]

        def mock_exec(stmt):
            result = MagicMock()
            sql = str(stmt).lower()
            if "event_attendances" in sql:
                result.all.return_value = going_rows
            elif "cached_events" in sql:
                result.all.return_value = []  # event deleted from cache
            else:
                result.all.return_value = []
            return result

        mock_session.exec = mock_exec
        app.dependency_overrides[get_session] = lambda: mock_session
        app.dependency_overrides[require_admin] = _fake_admin

        client = TestClient(app)
        resp = client.get("/api/admin/most-attended-events")
        assert resp.status_code == 200
        data = resp.json()
        assert data[0]["title"] == "Unknown"
        assert data[0]["going_count"] == 3

        app.dependency_overrides.pop(get_session, None)
