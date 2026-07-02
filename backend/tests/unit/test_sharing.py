"""Critical unit tests for the share-my-calendar feature."""

import pytest
from unittest.mock import MagicMock
from datetime import datetime

from fastapi.testclient import TestClient
from sqlmodel import Session

from backend.api.main import app
from backend.db.database import get_session
from backend.db.models import (
    CachedEvent,
    CalendarSetting,
    ShareToken,
    UserSavedEvent,
    UserEventAttendance,
)


# ── Helpers ──────────────────────────────────────────────────────────────────


def _mock_session():
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


def _sample_event(**overrides):
    defaults = dict(
        event_id="evt-share-001",
        calendar_id="cal-1",
        title="Salsa Night",
        description="Weekly salsa",
        location="Dance Studio, Paris",
        start=datetime(2026, 5, 10, 20, 0),
        end=datetime(2026, 5, 10, 23, 0),
        all_day=False,
        deleted_at=None,
        price_is_free=True,
        price_min=None,
        price_max=None,
        price_currency=None,
        latitude=48.8566,
        longitude=2.3522,
        links=None,
    )
    defaults.update(overrides)
    return CachedEvent(**defaults)


def _sample_calendar(**overrides):
    defaults = dict(calendar_id="cal-1", name="Salsa", enabled=True, color="#e11d48")
    defaults.update(overrides)
    return CalendarSetting(**defaults)


def _sample_share_token(token="test-token-uuid", device_id="dev-abc"):
    return ShareToken(
        id=1,
        token=token,
        device_id=device_id,
        created_at=datetime(2026, 4, 29, 12, 0),
    )


def _sample_saved_row(device_id="dev-abc", event_id="evt-share-001"):
    return UserSavedEvent(
        id=1,
        device_id=device_id,
        event_id=event_id,
        saved_at=datetime(2026, 4, 29, 12, 0),
    )


# ── Fixtures ─────────────────────────────────────────────────────────────────


@pytest.fixture
def client():
    session = _mock_session()
    app.dependency_overrides[get_session] = lambda: session
    yield TestClient(app), session
    app.dependency_overrides.clear()


# ── POST /api/share/calendar ──────────────────────────────────────────────────


@pytest.mark.unit
class TestCreateShareToken:
    def test_creates_token_for_new_device(self, client):
        c, session = client

        # No existing token for this device
        def mock_exec(stmt):
            result = MagicMock()
            result.first.return_value = None
            return result

        session.exec.side_effect = mock_exec

        resp = c.post("/api/share/calendar", json={"device_id": "dev-new"})

        assert resp.status_code == 201
        data = resp.json()
        assert "token" in data
        assert len(data["token"]) == 36  # UUID v4 format

        # ShareToken was persisted
        added_tokens = [o for o in session._added if isinstance(o, ShareToken)]
        assert len(added_tokens) == 1
        assert added_tokens[0].device_id == "dev-new"
        session.commit.assert_called_once()

    def test_returns_existing_token_for_known_device(self, client):
        c, session = client
        existing = _sample_share_token(token="existing-uuid", device_id="dev-abc")

        def mock_exec(stmt):
            result = MagicMock()
            result.first.return_value = existing
            return result

        session.exec.side_effect = mock_exec

        resp = c.post("/api/share/calendar", json={"device_id": "dev-abc"})

        assert resp.status_code == 201
        assert resp.json()["token"] == "existing-uuid"

        # No new token created
        added_tokens = [o for o in session._added if isinstance(o, ShareToken)]
        assert len(added_tokens) == 0

    def test_device_id_required(self, client):
        c, _ = client
        resp = c.post("/api/share/calendar", json={})
        assert resp.status_code == 422

    def test_device_id_too_long(self, client):
        c, _ = client
        resp = c.post("/api/share/calendar", json={"device_id": "x" * 65})
        assert resp.status_code == 422

    def test_device_id_empty_string(self, client):
        c, _ = client
        resp = c.post("/api/share/calendar", json={"device_id": ""})
        assert resp.status_code == 422


# ── GET /api/share/calendar/{token} ──────────────────────────────────────────


@pytest.mark.unit
class TestGetSharedCalendar:
    def test_invalid_token_returns_404(self, client):
        c, session = client

        def mock_exec(stmt):
            result = MagicMock()
            result.first.return_value = None
            result.all.return_value = []
            return result

        session.exec.side_effect = mock_exec

        resp = c.get("/api/share/calendar/bad-token")
        assert resp.status_code == 404
        assert resp.json()["detail"] == "Share link not found"

    def test_valid_token_no_saved_events_returns_empty(self, client):
        c, session = client
        share = _sample_share_token()

        call_count = 0

        def mock_exec(stmt):
            nonlocal call_count
            result = MagicMock()
            if call_count == 0:
                # ShareToken lookup
                result.first.return_value = share
            else:
                # UserSavedEvent / UserEventAttendance lookups
                result.all.return_value = []
            call_count += 1
            return result

        session.exec.side_effect = mock_exec

        resp = c.get("/api/share/calendar/test-token-uuid")
        assert resp.status_code == 200
        assert resp.json() == {"events": [], "owner_display_name": None}

    def test_valid_token_with_saved_events_returns_events(self, client):
        c, session = client
        share = _sample_share_token()
        saved_row = _sample_saved_row()
        event = _sample_event()
        cal = _sample_calendar()

        call_count = 0

        def mock_exec(stmt):
            nonlocal call_count
            result = MagicMock()
            sql_text = str(stmt)
            if call_count == 0:
                # ShareToken lookup
                result.first.return_value = share
                call_count += 1
            elif "user_saved_events" in sql_text:
                result.all.return_value = [saved_row]
                call_count += 1
            elif "user_event_attendance" in sql_text:
                result.all.return_value = []
                call_count += 1
            elif "calendar_settings" in sql_text:
                result.all.return_value = [cal]
                call_count += 1
            elif "cached_events" in sql_text:
                result.all.return_value = [event]
                call_count += 1
            elif "event_views" in sql_text:
                result.all.return_value = []
                call_count += 1
            else:
                result.all.return_value = []
                call_count += 1
            return result

        session.exec.side_effect = mock_exec

        resp = c.get("/api/share/calendar/test-token-uuid")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["events"]) == 1
        assert data["events"][0]["event_id"] == "evt-share-001"
        assert data["events"][0]["title"] == "Salsa Night"

    def test_shared_page_hides_disabled_calendar_events(self, client):
        """Events from disabled calendars must not leak into shared view."""
        c, session = client
        share = _sample_share_token()
        saved_row = _sample_saved_row()

        call_count = 0

        def mock_exec(stmt):
            nonlocal call_count
            result = MagicMock()
            sql_text = str(stmt)
            if call_count == 0:
                result.first.return_value = share
                call_count += 1
            elif "user_saved_events" in sql_text:
                result.all.return_value = [saved_row]
                call_count += 1
            elif "user_event_attendance" in sql_text:
                result.all.return_value = []
                call_count += 1
            elif "calendar_settings" in sql_text:
                # No enabled calendars
                result.all.return_value = []
                call_count += 1
            else:
                result.all.return_value = []
                call_count += 1
            return result

        session.exec.side_effect = mock_exec

        resp = c.get("/api/share/calendar/test-token-uuid")
        assert resp.status_code == 200
        assert resp.json() == {"events": [], "owner_display_name": None}


def _sample_attending_row(device_id="dev-abc", event_id="evt-going-001"):
    return UserEventAttendance(
        id=1,
        device_id=device_id,
        event_id=event_id,
        attending_since=datetime(2026, 4, 29, 12, 0),
    )


def _feed_mock(
    session, *, share, saved=None, attending=None, events=None, calendars=("cal-1",)
):
    """Dispatch ``session.exec`` results by table name for the feed endpoint."""
    saved = list(saved or [])
    attending = list(attending or [])
    events = list(events or [])

    def mock_exec(stmt):
        result = MagicMock()
        sql = str(stmt).lower()
        if "share_tokens" in sql:
            result.first.return_value = share
        elif "user_saved_events" in sql:
            result.all.return_value = saved
        elif "user_event_attendances" in sql:
            result.all.return_value = attending
        elif "calendar_settings" in sql:
            result.all.return_value = list(calendars)
        elif "cached_events" in sql:
            result.all.return_value = events
        else:
            result.first.return_value = None
            result.all.return_value = []
        return result

    session.exec.side_effect = mock_exec


# ── GET /api/share/calendar/{token}.ics (live subscription feed) ─────────────


@pytest.mark.unit
class TestCalendarFeed:
    def test_invalid_token_returns_404(self, client):
        c, session = client
        _feed_mock(session, share=None)

        resp = c.get("/api/share/calendar/bad-token.ics")
        assert resp.status_code == 404

    def test_going_scope_returns_calendar(self, client):
        c, session = client
        share = _sample_share_token()
        going_event = _sample_event(event_id="evt-going-001", title="Bachata Social")
        _feed_mock(
            session,
            share=share,
            attending=[_sample_attending_row(event_id="evt-going-001")],
            events=[going_event],
        )

        resp = c.get("/api/share/calendar/test-token-uuid.ics?scope=going")
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/calendar")
        body = resp.text
        assert "BEGIN:VCALENDAR" in body
        assert "REFRESH-INTERVAL;VALUE=DURATION:PT12H" in body
        assert "X-WR-CALNAME:My Movida — Going" in body
        assert "SUMMARY:Bachata Social" in body
        assert "DTSTAMP:" in body

    def test_saved_scope_excludes_going_events(self, client):
        """scope=saved must ignore 'going' rows entirely (no events queried)."""
        c, session = client
        share = _sample_share_token()
        _feed_mock(
            session,
            share=share,
            saved=[],
            attending=[_sample_attending_row(event_id="evt-going-001")],
            events=[_sample_event(event_id="evt-going-001")],
        )

        resp = c.get("/api/share/calendar/test-token-uuid.ics?scope=saved")
        assert resp.status_code == 200
        body = resp.text
        assert "BEGIN:VEVENT" not in body
        assert "X-WR-CALNAME:My Movida — Saved" in body

    def test_all_scope_includes_saved_and_going(self, client):
        c, session = client
        share = _sample_share_token()
        saved_event = _sample_event(event_id="evt-saved-001", title="Salsa Night")
        going_event = _sample_event(event_id="evt-going-001", title="Bachata Social")
        _feed_mock(
            session,
            share=share,
            saved=[_sample_saved_row(event_id="evt-saved-001")],
            attending=[_sample_attending_row(event_id="evt-going-001")],
            events=[saved_event, going_event],
        )

        resp = c.get("/api/share/calendar/test-token-uuid.ics")
        assert resp.status_code == 200
        body = resp.text
        assert "SUMMARY:Salsa Night" in body
        assert "SUMMARY:Bachata Social" in body
        assert "X-WR-CALNAME:My Movida — Saved & Going" in body

    def test_all_day_event_uses_date_value(self, client):
        c, session = client
        share = _sample_share_token()
        all_day = _sample_event(
            event_id="evt-going-001",
            all_day=True,
            start=datetime(2026, 5, 10, 0, 0),
            end=datetime(2026, 5, 11, 0, 0),
        )
        _feed_mock(
            session,
            share=share,
            attending=[_sample_attending_row(event_id="evt-going-001")],
            events=[all_day],
        )

        resp = c.get("/api/share/calendar/test-token-uuid.ics?scope=going")
        assert resp.status_code == 200
        assert "DTSTART;VALUE=DATE:20260510" in resp.text
