"""Unit tests for the event suggestion feature."""

import pytest
from datetime import datetime
from unittest.mock import MagicMock, patch, AsyncMock

from fastapi.testclient import TestClient
from sqlmodel import Session

from backend.api.main import app
from backend.api.deps import require_admin, get_client_ip, create_session_token
from backend.db.database import get_session
from backend.db.models import CachedEvent, CalendarSetting, EventSuggestion


def _fake_admin():
    return {"email": "admin@example.com", "name": "Admin"}


def _mock_session_with_suggestions(*suggestions):
    """Create a mock session that supports get/add/commit/refresh/exec for suggestions."""
    session = MagicMock(spec=Session)
    store = {s.id: s for s in suggestions}

    def mock_get(model, pk):
        if model is EventSuggestion:
            return store.get(pk)
        if model is CalendarSetting:
            return CalendarSetting(calendar_id=str(pk), name="Test Cal", enabled=True)
        return None

    def mock_add(obj):
        if isinstance(obj, EventSuggestion):
            store[obj.id] = obj
        pass

    def mock_refresh(obj):
        pass

    def mock_commit():
        pass

    def mock_exec(stmt):
        result = MagicMock()
        result.all.return_value = list(store.values())
        return result

    session.get = mock_get
    session.add = mock_add
    session.commit = mock_commit
    session.refresh = mock_refresh
    session.exec = mock_exec
    return session


def _make_suggestion(**overrides) -> EventSuggestion:
    from uuid import uuid4

    defaults = dict(
        id=uuid4(),
        title="Test Salsa Night",
        description="A fun event",
        location="Berlin",
        start=datetime(2026, 6, 15, 20, 0),
        end=datetime(2026, 6, 15, 23, 0),
        all_day=False,
        status="pending",
        submitter_name="John",
        submitter_email="john@example.com",
        submitter_ip="1.2.3.4",
        submitter_user_agent="Mozilla/5.0",
    )
    defaults.update(overrides)
    return EventSuggestion(**defaults)


@pytest.mark.unit
class TestSubmitSuggestion:
    def test_honeypot_silent_reject(self):
        """Filled honeypot field → 201 returned, but no DB write."""
        mock_session = MagicMock(spec=Session)
        app.dependency_overrides[get_session] = lambda: mock_session

        client = TestClient(app)
        resp = client.post(
            "/api/suggestions",
            json={
                "title": "Bot Event",
                "start": "2026-06-15T20:00:00",
                "end": "2026-06-15T23:00:00",
                "website": "http://spam.com",  # honeypot filled
            },
        )

        assert resp.status_code == 201
        data = resp.json()
        assert "under review" in data["message"]
        # Session.add should NOT have been called (no DB write)
        mock_session.add.assert_not_called()

        app.dependency_overrides.clear()

    def test_submit_valid_suggestion(self):
        """Valid submission → 201, session.add called with correct data."""
        mock_session = MagicMock(spec=Session)
        # Make refresh a no-op, and make the added object available
        mock_session.refresh = MagicMock()
        mock_session.commit = MagicMock()

        captured = []
        original_add = mock_session.add

        def capture_add(obj):
            captured.append(obj)

        mock_session.add = capture_add

        app.dependency_overrides[get_session] = lambda: mock_session

        client = TestClient(app)
        resp = client.post(
            "/api/suggestions",
            json={
                "title": "Salsa Tuesday",
                "description": "Weekly salsa class",
                "location": "Studio A",
                "start": "2026-06-15T20:00:00",
                "end": "2026-06-15T23:00:00",
                "submitter_name": "Alice",
                "submitter_email": "alice@example.com",
                "screen_size": "1920x1080",
                "timezone": "Europe/Berlin",
            },
        )

        assert resp.status_code == 201
        assert len(captured) == 1
        suggestion = captured[0]
        assert isinstance(suggestion, EventSuggestion)
        assert suggestion.title == "Salsa Tuesday"
        assert suggestion.status == "pending"
        assert suggestion.submitter_name == "Alice"
        assert suggestion.submitter_screen_size == "1920x1080"
        assert suggestion.submitter_timezone == "Europe/Berlin"
        # IP should be captured from test client
        assert suggestion.submitter_ip is not None

        app.dependency_overrides.clear()

    def test_submit_missing_title(self):
        """Missing title → 422 validation error."""
        app.dependency_overrides[get_session] = lambda: MagicMock(spec=Session)
        try:
            client = TestClient(app)
            resp = client.post(
                "/api/suggestions",
                json={
                    "start": "2026-06-15T20:00:00",
                    "end": "2026-06-15T23:00:00",
                },
            )
            assert resp.status_code == 422
        finally:
            app.dependency_overrides.pop(get_session, None)


@pytest.mark.unit
class TestApproveSuggestion:
    def test_approve_creates_cached_event(self):
        """Approving a pending suggestion creates a CachedEvent and updates status."""
        suggestion = _make_suggestion()
        mock_session = _mock_session_with_suggestions(suggestion)

        # Track added objects
        added_objects = []
        original_add = mock_session.add

        def tracking_add(obj):
            added_objects.append(obj)
            original_add(obj)

        mock_session.add = tracking_add

        app.dependency_overrides[get_session] = lambda: mock_session
        app.dependency_overrides[require_admin] = _fake_admin

        client = TestClient(app)
        resp = client.post(
            f"/api/admin/suggestions/{suggestion.id}/approve",
            json={"calendar_id": "cal-1"},
        )

        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "approved"
        assert data["assigned_calendar_id"] == "cal-1"

        # A CachedEvent should have been added
        cached_events = [o for o in added_objects if isinstance(o, CachedEvent)]
        assert len(cached_events) == 1
        assert cached_events[0].title == suggestion.title

        app.dependency_overrides.clear()

    def test_approve_already_approved(self):
        """Re-approving an already approved suggestion → 400."""
        suggestion = _make_suggestion(status="approved")
        mock_session = _mock_session_with_suggestions(suggestion)

        app.dependency_overrides[get_session] = lambda: mock_session
        app.dependency_overrides[require_admin] = _fake_admin

        client = TestClient(app)
        resp = client.post(
            f"/api/admin/suggestions/{suggestion.id}/approve",
            json={"calendar_id": "cal-1"},
        )

        assert resp.status_code == 400
        assert "already" in resp.json()["detail"].lower()

        app.dependency_overrides.clear()


@pytest.mark.unit
class TestRejectSuggestion:
    def test_reject_sets_status(self):
        """Rejecting a pending suggestion sets status and reviewed_at."""
        suggestion = _make_suggestion()
        mock_session = _mock_session_with_suggestions(suggestion)

        app.dependency_overrides[get_session] = lambda: mock_session
        app.dependency_overrides[require_admin] = _fake_admin

        client = TestClient(app)
        resp = client.post(
            f"/api/admin/suggestions/{suggestion.id}/reject",
            json={"admin_notes": "Duplicate event"},
        )

        assert resp.status_code == 200
        assert suggestion.status == "rejected"
        assert suggestion.admin_notes == "Duplicate event"
        assert suggestion.reviewed_at is not None

        app.dependency_overrides.clear()


@pytest.mark.unit
class TestGetClientIp:
    def test_direct_no_proxy(self):
        """Without TRUSTED_PROXIES, returns request.client.host."""
        mock_request = MagicMock()
        mock_request.client.host = "203.0.113.50"
        mock_request.headers = {}

        with patch("backend.api.deps.get_trusted_proxies", return_value=[]):
            ip = get_client_ip(mock_request)

        assert ip == "203.0.113.50"

    def test_trusted_proxy_returns_forwarded(self):
        """With matching TRUSTED_PROXIES, returns X-Forwarded-For first IP."""
        mock_request = MagicMock()
        mock_request.client.host = "10.0.0.1"  # proxy IP
        mock_request.headers = {"x-forwarded-for": "203.0.113.50, 10.0.0.1"}

        with patch(
            "backend.api.deps.get_trusted_proxies",
            return_value=["10.0.0.0/8"],
        ):
            ip = get_client_ip(mock_request)

        assert ip == "203.0.113.50"

    def test_untrusted_proxy_ignores_header(self):
        """With non-matching proxy, ignores X-Forwarded-For."""
        mock_request = MagicMock()
        mock_request.client.host = "192.168.1.100"
        mock_request.headers = {"x-forwarded-for": "203.0.113.50"}

        with patch(
            "backend.api.deps.get_trusted_proxies",
            return_value=["10.0.0.0/8"],  # doesn't match 192.168.x
        ):
            ip = get_client_ip(mock_request)

        assert ip == "192.168.1.100"


@pytest.mark.unit
class TestGeolocatePrivateIp:
    @pytest.mark.asyncio
    async def test_private_ip_returns_none(self):
        """Private/loopback IPs should return None without calling external API."""
        from backend.services.ip_geolocation import geolocate_ip

        result = await geolocate_ip("127.0.0.1")
        assert result is None

        result = await geolocate_ip("10.0.0.1")
        assert result is None

        result = await geolocate_ip("192.168.1.1")
        assert result is None
