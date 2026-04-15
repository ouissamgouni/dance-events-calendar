"""API route tests using FastAPI TestClient (no real DB)."""

import pytest
from unittest.mock import MagicMock, patch
from datetime import datetime

from fastapi.testclient import TestClient
from sqlmodel import Session

from backend.api.main import app
from backend.api.deps import require_admin
from backend.db.database import get_session
from backend.db.models import CachedEvent, CalendarSetting, EventView


def _fake_admin():
    return {"email": "admin@example.com", "name": "Admin"}


def make_session_with_data(calendars=None, events=None):
    """Create a mock session that returns given calendars and events."""
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


@pytest.fixture
def sample_calendar():
    return CalendarSetting(
        calendar_id="cal-1",
        name="Test Calendar",
        enabled=True,
        color="#ff0000",
    )


@pytest.fixture
def sample_events():
    return [
        CachedEvent(
            event_id="evt-1",
            calendar_id="cal-1",
            title="Test Event",
            description="Description with https://example.com/tickets link",
            location="Test Venue",
            start=datetime(2026, 4, 20, 20, 0),
            end=datetime(2026, 4, 20, 23, 0),
            all_day=False,
        ),
    ]


@pytest.mark.unit
class TestHealthEndpoint:
    def test_health_returns_ok(self):
        client = TestClient(app)
        resp = client.get("/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"


@pytest.mark.unit
class TestEventsEndpoint:
    def test_get_events_returns_list(self, sample_calendar, sample_events):
        mock_session = make_session_with_data(
            calendars=[sample_calendar],
            events=sample_events,
        )
        app.dependency_overrides[get_session] = lambda: mock_session
        try:
            client = TestClient(app)
            resp = client.get("/api/events")
            assert resp.status_code == 200
            data = resp.json()
            assert isinstance(data, list)
            assert len(data) == 1
            assert data[0]["title"] == "Test Event"
            assert data[0]["color"] == "#ff0000"
        finally:
            app.dependency_overrides.clear()

    def test_get_events_empty_when_no_enabled_calendars(self):
        mock_session = make_session_with_data(calendars=[], events=[])
        app.dependency_overrides[get_session] = lambda: mock_session
        try:
            client = TestClient(app)
            resp = client.get("/api/events")
            assert resp.status_code == 200
            assert resp.json() == []
        finally:
            app.dependency_overrides.clear()


@pytest.mark.unit
class TestTrackingEndpoint:
    def test_track_event_view(self):
        mock_session = MagicMock(spec=Session)
        app.dependency_overrides[get_session] = lambda: mock_session
        try:
            client = TestClient(app)
            resp = client.post(
                "/api/track/event-view",
                json={"event_id": "evt-1"},
            )
            assert resp.status_code == 201
            assert resp.json()["status"] == "tracked"
            mock_session.add.assert_called_once()
            mock_session.commit.assert_called_once()
        finally:
            app.dependency_overrides.clear()

    def test_track_event_view_missing_event_id(self):
        client = TestClient(app)
        resp = client.post("/api/track/event-view", json={})
        assert resp.status_code == 422


@pytest.mark.unit
class TestAdminEndpoints:
    def test_list_calendars(self, sample_calendar):
        mock_session = make_session_with_data(calendars=[sample_calendar])
        app.dependency_overrides[get_session] = lambda: mock_session
        try:
            client = TestClient(app)
            resp = client.get("/api/admin/calendars")
            assert resp.status_code == 200
            data = resp.json()
            assert len(data) == 1
            assert data[0]["name"] == "Test Calendar"
        finally:
            app.dependency_overrides.clear()

    def test_toggle_calendar_not_found(self):
        mock_session = MagicMock(spec=Session)
        mock_session.get.return_value = None
        app.dependency_overrides[get_session] = lambda: mock_session
        app.dependency_overrides[require_admin] = _fake_admin
        try:
            client = TestClient(app)
            resp = client.post(
                "/api/admin/calendars/nonexistent/toggle",
                json={"enabled": True},
            )
            assert resp.status_code == 404
        finally:
            app.dependency_overrides.clear()

    def test_toggle_calendar_success(self, sample_calendar):
        mock_session = MagicMock(spec=Session)
        mock_session.get.return_value = sample_calendar
        app.dependency_overrides[get_session] = lambda: mock_session
        app.dependency_overrides[require_admin] = _fake_admin
        try:
            client = TestClient(app)
            resp = client.post(
                "/api/admin/calendars/cal-1/toggle",
                json={"enabled": False},
            )
            assert resp.status_code == 200
            assert resp.json()["enabled"] is False
        finally:
            app.dependency_overrides.clear()


@pytest.mark.unit
class TestEventUpdateEndpoint:
    def test_patch_event_updates_title(self):
        from backend.db.models import CachedEvent, CalendarSetting

        event = CachedEvent(
            event_id="evt-1",
            calendar_id="cal-1",
            title="Old Title",
            start=datetime(2026, 5, 1, 20, 0),
            end=datetime(2026, 5, 1, 23, 0),
        )
        cal = CalendarSetting(
            calendar_id="cal-1", name="Test", enabled=True, color="#ff0000"
        )
        mock_session = MagicMock(spec=Session)
        mock_session.get.side_effect = lambda model, key: (
            event if model == CachedEvent else cal
        )
        app.dependency_overrides[get_session] = lambda: mock_session
        app.dependency_overrides[require_admin] = _fake_admin
        try:
            client = TestClient(app)
            resp = client.patch("/api/admin/events/evt-1", json={"title": "New Title"})
            assert resp.status_code == 200
            assert resp.json()["title"] == "New Title"
        finally:
            app.dependency_overrides.clear()

    def test_patch_event_not_found(self):
        mock_session = MagicMock(spec=Session)
        mock_session.get.return_value = None
        app.dependency_overrides[get_session] = lambda: mock_session
        app.dependency_overrides[require_admin] = _fake_admin
        try:
            client = TestClient(app)
            resp = client.patch("/api/admin/events/nonexistent", json={"title": "X"})
            assert resp.status_code == 404
        finally:
            app.dependency_overrides.clear()

    def test_patch_event_without_auth(self):
        app.dependency_overrides.clear()
        client = TestClient(app)
        resp = client.patch("/api/admin/events/evt-1", json={"title": "X"})
        assert resp.status_code in (401, 403)


@pytest.mark.unit
class TestGeocodeEndpoint:
    def test_geocode_search_returns_results(self):
        app.dependency_overrides[require_admin] = _fake_admin
        try:
            with patch("geopy.geocoders.Nominatim") as MockNom:
                mock_result = MagicMock()
                mock_result.address = "Paris, France"
                mock_result.latitude = 48.8566
                mock_result.longitude = 2.3522
                MockNom.return_value.geocode.return_value = [mock_result]

                client = TestClient(app)
                resp = client.get("/api/admin/geocode?q=Paris")
                assert resp.status_code == 200
                data = resp.json()
                assert len(data) == 1
                assert data[0]["display_name"] == "Paris, France"
                assert data[0]["latitude"] == 48.8566
        finally:
            app.dependency_overrides.clear()

    def test_geocode_search_without_query(self):
        app.dependency_overrides[require_admin] = _fake_admin
        try:
            client = TestClient(app)
            resp = client.get("/api/admin/geocode")
            assert resp.status_code == 422
        finally:
            app.dependency_overrides.clear()

    def test_geocode_search_short_query(self):
        app.dependency_overrides[require_admin] = _fake_admin
        try:
            client = TestClient(app)
            resp = client.get("/api/admin/geocode?q=ab")
            assert resp.status_code == 422
        finally:
            app.dependency_overrides.clear()


@pytest.mark.unit
class TestPendingReviewEndpoints:
    def test_list_pending_events(self, sample_calendar):
        pending_event = CachedEvent(
            event_id="evt-pending",
            calendar_id="cal-1",
            title="Pending Event",
            start=datetime(2099, 6, 1, 20, 0),
            end=datetime(2099, 6, 1, 23, 0),
            review_status="pending",
        )

        def mock_exec(stmt):
            result = MagicMock()
            sql_text = str(stmt)
            if "calendar_settings" in sql_text:
                result.all.return_value = [sample_calendar]
            elif "cached_events" in sql_text:
                result.all.return_value = [pending_event]
            else:
                result.all.return_value = []
            return result

        mock_session = MagicMock(spec=Session)
        mock_session.exec = mock_exec
        app.dependency_overrides[get_session] = lambda: mock_session
        app.dependency_overrides[require_admin] = _fake_admin
        try:
            client = TestClient(app)
            resp = client.get("/api/admin/events/pending")
            assert resp.status_code == 200
            data = resp.json()
            assert len(data) == 1
            assert data[0]["review_status"] == "pending"
            assert data[0]["title"] == "Pending Event"
        finally:
            app.dependency_overrides.clear()

    def test_review_event_marks_reviewed(self):
        event = CachedEvent(
            event_id="evt-1",
            calendar_id="cal-1",
            title="Test",
            start=datetime(2099, 6, 1, 20, 0),
            end=datetime(2099, 6, 1, 23, 0),
            review_status="pending",
        )
        cal = CalendarSetting(
            calendar_id="cal-1", name="Test", enabled=True, color="#ff0000"
        )
        mock_session = MagicMock(spec=Session)
        mock_session.get.side_effect = lambda model, key: (
            event if model == CachedEvent else cal
        )
        app.dependency_overrides[get_session] = lambda: mock_session
        app.dependency_overrides[require_admin] = _fake_admin
        try:
            client = TestClient(app)
            resp = client.post("/api/admin/events/evt-1/review")
            assert resp.status_code == 200
            assert resp.json()["review_status"] == "reviewed"
        finally:
            app.dependency_overrides.clear()

    def test_review_event_not_found(self):
        mock_session = MagicMock(spec=Session)
        mock_session.get.return_value = None
        app.dependency_overrides[get_session] = lambda: mock_session
        app.dependency_overrides[require_admin] = _fake_admin
        try:
            client = TestClient(app)
            resp = client.post("/api/admin/events/nonexistent/review")
            assert resp.status_code == 404
        finally:
            app.dependency_overrides.clear()

    def test_mark_all_reviewed(self):
        pending = [
            CachedEvent(
                event_id=f"evt-{i}",
                calendar_id="cal-1",
                title=f"Event {i}",
                start=datetime(2099, 6, 1, 20, 0),
                end=datetime(2099, 6, 1, 23, 0),
                review_status="pending",
            )
            for i in range(3)
        ]

        def mock_exec(stmt):
            result = MagicMock()
            result.all.return_value = pending
            return result

        mock_session = MagicMock(spec=Session)
        mock_session.exec = mock_exec
        app.dependency_overrides[get_session] = lambda: mock_session
        app.dependency_overrides[require_admin] = _fake_admin
        try:
            client = TestClient(app)
            resp = client.post("/api/admin/events/mark-all-reviewed")
            assert resp.status_code == 200
            data = resp.json()
            assert data["marked_reviewed"] == 3
            for evt in pending:
                assert evt.review_status == "reviewed"
        finally:
            app.dependency_overrides.clear()

    def test_pending_events_requires_auth(self):
        app.dependency_overrides.clear()
        client = TestClient(app)
        resp = client.get("/api/admin/events/pending")
        assert resp.status_code in (401, 403)
