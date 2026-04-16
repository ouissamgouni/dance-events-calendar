"""Unit tests for My Calendar feature: save tracking, export, batch fetch."""

import pytest
from unittest.mock import MagicMock
from datetime import datetime

from fastapi.testclient import TestClient
from sqlmodel import Session

from backend.api.main import app
from backend.db.database import get_session
from backend.db.models import CachedEvent, CalendarSetting


def _make_mock_session(events=None, calendars=None):
    """Create a mock session returning given events/calendars."""
    session = MagicMock(spec=Session)

    def mock_exec(stmt):
        result = MagicMock()
        sql_text = str(stmt)
        if "calendar_settings" in sql_text:
            result.all.return_value = calendars or []
        elif "cached_events" in sql_text:
            result.all.return_value = events or []
        elif "event_views" in sql_text and "GROUP BY" in sql_text:
            result.all.return_value = []
        else:
            result.all.return_value = []
        return result

    session.exec = mock_exec
    return session


def _sample_event(**overrides):
    defaults = dict(
        event_id="evt-1",
        calendar_id="cal-1",
        title="Salsa Night",
        description="Weekly salsa",
        location="Dance Studio",
        start=datetime(2026, 5, 10, 20, 0),
        end=datetime(2026, 5, 10, 23, 0),
        all_day=False,
        deleted_at=None,
        price_is_free=True,
        price_min=None,
        price_max=None,
        price_currency=None,
    )
    defaults.update(overrides)
    return CachedEvent(**defaults)


def _sample_calendar(**overrides):
    defaults = dict(calendar_id="cal-1", name="Test", enabled=True, color="#ff0000")
    defaults.update(overrides)
    return CalendarSetting(**defaults)


@pytest.mark.unit
class TestEventSaveTracking:
    def test_track_save(self):
        mock_session = MagicMock(spec=Session)
        app.dependency_overrides[get_session] = lambda: mock_session
        try:
            client = TestClient(app)
            resp = client.post(
                "/api/track/event-save",
                json={"event_id": "evt-1", "device_id": "dev-abc", "action": "save"},
            )
            assert resp.status_code == 201
            assert resp.json()["status"] == "tracked"
            mock_session.add.assert_called_once()
            mock_session.commit.assert_called_once()
        finally:
            app.dependency_overrides.clear()

    def test_track_unsave(self):
        mock_session = MagicMock(spec=Session)
        app.dependency_overrides[get_session] = lambda: mock_session
        try:
            client = TestClient(app)
            resp = client.post(
                "/api/track/event-save",
                json={"event_id": "evt-1", "device_id": "dev-abc", "action": "unsave"},
            )
            assert resp.status_code == 201
            assert resp.json()["status"] == "tracked"
        finally:
            app.dependency_overrides.clear()

    def test_track_save_invalid_action(self):
        client = TestClient(app)
        resp = client.post(
            "/api/track/event-save",
            json={"event_id": "evt-1", "device_id": "dev-abc", "action": "invalid"},
        )
        assert resp.status_code == 422

    def test_track_save_missing_device_id(self):
        client = TestClient(app)
        resp = client.post(
            "/api/track/event-save",
            json={"event_id": "evt-1", "action": "save"},
        )
        assert resp.status_code == 422


@pytest.mark.unit
class TestBatchFetchEvents:
    def test_fetch_by_ids_returns_matching(self):
        event = _sample_event()
        cal = _sample_calendar()
        mock_session = _make_mock_session(events=[event], calendars=[cal])
        app.dependency_overrides[get_session] = lambda: mock_session
        try:
            client = TestClient(app)
            resp = client.post(
                "/api/events/by-ids",
                json={"event_ids": ["evt-1"]},
            )
            assert resp.status_code == 200
            data = resp.json()
            assert isinstance(data, list)
            assert len(data) == 1
            assert data[0]["event_id"] == "evt-1"
        finally:
            app.dependency_overrides.clear()

    def test_fetch_by_ids_empty_list_rejected(self):
        """Empty list is rejected by schema (min_length=1)."""
        client = TestClient(app)
        resp = client.post(
            "/api/events/by-ids",
            json={"event_ids": []},
        )
        assert resp.status_code == 422


@pytest.mark.unit
class TestExportIcs:
    def test_export_ics_returns_calendar_file(self):
        event = _sample_event()
        mock_session = _make_mock_session(events=[event])
        app.dependency_overrides[get_session] = lambda: mock_session
        try:
            client = TestClient(app)
            resp = client.post(
                "/api/events/export/ics",
                json={"event_ids": ["evt-1"]},
            )
            assert resp.status_code == 200
            assert resp.headers["content-type"].startswith("text/calendar")
            body = resp.text
            assert "BEGIN:VCALENDAR" in body
            assert "BEGIN:VEVENT" in body
            assert "Salsa Night" in body
            assert "END:VCALENDAR" in body
        finally:
            app.dependency_overrides.clear()

    def test_export_ics_empty_ids_rejected(self):
        """Empty list is rejected by schema (min_length=1)."""
        client = TestClient(app)
        resp = client.post(
            "/api/events/export/ics",
            json={"event_ids": []},
        )
        assert resp.status_code == 422


@pytest.mark.unit
class TestExportXlsx:
    def test_export_xlsx_returns_spreadsheet(self):
        event = _sample_event()
        mock_session = _make_mock_session(events=[event])
        app.dependency_overrides[get_session] = lambda: mock_session
        try:
            client = TestClient(app)
            resp = client.post(
                "/api/events/export/xlsx",
                json={"event_ids": ["evt-1"]},
            )
            assert resp.status_code == 200
            assert "spreadsheetml" in resp.headers["content-type"]
            # Verify it's a valid xlsx (starts with PK zip header)
            assert resp.content[:2] == b"PK"
        finally:
            app.dependency_overrides.clear()


@pytest.mark.unit
class TestIcsBuild:
    """Unit tests for the ICS builder functions."""

    def test_ics_escape(self):
        from backend.api.routes.export import _ics_escape

        assert _ics_escape("hello; world, test") == "hello\\; world\\, test"
        assert _ics_escape("line1\nline2") == "line1\\nline2"
        assert _ics_escape("no special") == "no special"

    def test_build_ics_all_day(self):
        from backend.api.routes.export import _build_ics

        event = _sample_event(all_day=True)
        ics = _build_ics([event])
        assert "DTSTART;VALUE=DATE:20260510" in ics
        assert "DTEND;VALUE=DATE:20260510" in ics

    def test_build_ics_timed(self):
        from backend.api.routes.export import _build_ics

        event = _sample_event(all_day=False)
        ics = _build_ics([event])
        assert "DTSTART:20260510T200000Z" in ics
        assert "DTEND:20260510T230000Z" in ics

    def test_build_ics_location_and_description(self):
        from backend.api.routes.export import _build_ics

        event = _sample_event(location="Studio A", description="Come dance!")
        ics = _build_ics([event])
        assert "LOCATION:Studio A" in ics
        assert "DESCRIPTION:Come dance!" in ics
