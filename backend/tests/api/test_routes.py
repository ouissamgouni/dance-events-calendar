"""API route tests using FastAPI TestClient (no real DB)."""

from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock, patch

import pytest

from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from backend.api.main import app
from backend.api.deps import get_current_user_optional, require_admin
from backend.db.database import get_session
from backend.db.models import (
    BlockedEvent,
    CachedEvent,
    CalendarSetting,
    SiteSetting,
    User,
)


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
def sqlite_client():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)

    def _override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = _override
    app.dependency_overrides[require_admin] = _fake_admin
    try:
        yield TestClient(app), engine
    finally:
        app.dependency_overrides.clear()
        SQLModel.metadata.drop_all(engine)


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
class TestSettingsEndpoint:
    def test_settings_returns_trending_banner_default_true(self, sqlite_client):
        client, _engine = sqlite_client
        resp = client.get("/api/settings")
        assert resp.status_code == 200
        assert resp.json()["trending_banner_enabled"] is True
        assert resp.json()["default_explorer_period"] == "next_3_months"

    def test_admin_can_update_trending_banner_flag(self, sqlite_client):
        client, engine = sqlite_client

        resp = client.put("/api/settings", json={"trending_banner_enabled": True})
        assert resp.status_code == 200
        assert resp.json()["trending_banner_enabled"] is True

        with Session(engine) as session:
            row = session.get(SiteSetting, "trending_banner_enabled")
            assert row is not None
            assert row.value == "true"

        resp = client.get("/api/settings")
        assert resp.status_code == 200
        assert resp.json()["trending_banner_enabled"] is True

    def test_admin_can_update_default_explorer_period(self, sqlite_client):
        client, engine = sqlite_client

        resp = client.put(
            "/api/settings", json={"default_explorer_period": "next_30_days"}
        )
        assert resp.status_code == 200
        assert resp.json()["default_explorer_period"] == "next_30_days"

        with Session(engine) as session:
            row = session.get(SiteSetting, "default_explorer_period")
            assert row is not None
            assert row.value == "next_30_days"

        resp = client.get("/api/settings")
        assert resp.status_code == 200
        assert resp.json()["default_explorer_period"] == "next_30_days"

    def test_admin_cannot_update_invalid_default_explorer_period(self, sqlite_client):
        client, _engine = sqlite_client

        resp = client.put(
            "/api/settings", json={"default_explorer_period": "next_12_months"}
        )
        assert resp.status_code == 422

    def test_settings_default_notification_flags(self, sqlite_client):
        client, _engine = sqlite_client
        body = client.get("/api/settings").json()
        # Defaults come from ``config/loader.py`` (env-driven) and mirror
        # the Pydantic response defaults when nothing is set in DB.
        assert body["event_reminders_enabled"] is True
        assert body["activity_digest_email_enabled"] is True
        assert body["interest_match_notifications_enabled"] is True
        # ``web_push_enabled`` defaults False unless VAPID keys are present.
        assert "web_push_enabled" in body
        assert body["reminder_lead_hours"] == 24
        assert body["activity_digest_schedule"] == "tue,fri @ 09:00"

    def test_admin_can_update_notification_gates(self, sqlite_client):
        client, engine = sqlite_client
        resp = client.put(
            "/api/settings",
            json={
                "event_reminders_enabled": False,
                "activity_digest_email_enabled": False,
                "interest_match_notifications_enabled": False,
                "web_push_enabled": True,
                "reminder_lead_hours": 6,
                "activity_digest_schedule": "mon,thu @ 18:30",
            },
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["event_reminders_enabled"] is False
        assert body["activity_digest_email_enabled"] is False
        assert body["interest_match_notifications_enabled"] is False
        assert body["web_push_enabled"] is True
        assert body["reminder_lead_hours"] == 6
        assert body["activity_digest_schedule"] == "mon,thu @ 18:30"

        with Session(engine) as session:
            assert session.get(SiteSetting, "event_reminders_enabled").value == "false"
            assert session.get(SiteSetting, "web_push_enabled").value == "true"
            assert session.get(SiteSetting, "reminder_lead_hours").value == "6"
            assert (
                session.get(SiteSetting, "activity_digest_schedule").value
                == "mon,thu @ 18:30"
            )

        # GET reflects the persisted values.
        body = client.get("/api/settings").json()
        assert body["event_reminders_enabled"] is False
        assert body["activity_digest_schedule"] == "mon,thu @ 18:30"

    def test_admin_cannot_set_invalid_reminder_lead_hours(self, sqlite_client):
        client, _engine = sqlite_client
        # Below min.
        assert (
            client.put("/api/settings", json={"reminder_lead_hours": 0}).status_code
            == 422
        )
        # Above max (720 = 30 days).
        assert (
            client.put("/api/settings", json={"reminder_lead_hours": 721}).status_code
            == 422
        )

    def test_admin_cannot_set_malformed_digest_schedule(self, sqlite_client):
        client, _engine = sqlite_client
        for bad in ("everyday @ 09:00", "tue,fri", "tue,fri @ ", "TUE @ 09:00"):
            resp = client.put("/api/settings", json={"activity_digest_schedule": bad})
            assert resp.status_code == 422, (
                f"expected 422 for {bad!r} got {resp.status_code}"
            )


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

    def test_get_events_sets_public_cache_for_anonymous_list(
        self, sample_calendar, sample_events
    ):
        mock_session = make_session_with_data(
            calendars=[sample_calendar],
            events=sample_events,
        )
        app.dependency_overrides[get_session] = lambda: mock_session
        try:
            client = TestClient(app)
            resp = client.get("/api/events")

            assert resp.status_code == 200
            assert resp.headers["cache-control"] == "public, max-age=60"
            assert "vary" not in resp.headers
        finally:
            app.dependency_overrides.clear()

    def test_get_events_sets_private_cache_for_signed_in_list(
        self, sample_calendar, sample_events
    ):
        mock_session = make_session_with_data(
            calendars=[sample_calendar],
            events=sample_events,
        )
        app.dependency_overrides[get_session] = lambda: mock_session
        app.dependency_overrides[get_current_user_optional] = lambda: User(
            email="viewer@example.com"
        )
        try:
            client = TestClient(app)
            resp = client.get("/api/events")

            assert resp.status_code == 200
            assert resp.headers["cache-control"] == "private, max-age=0"
            assert resp.headers["vary"] == "Cookie"
        finally:
            app.dependency_overrides.clear()

    def test_get_events_sets_private_cache_for_interest_filter(self, sample_calendar):
        mock_session = make_session_with_data(
            calendars=[sample_calendar],
            events=[],
        )
        app.dependency_overrides[get_session] = lambda: mock_session
        try:
            client = TestClient(app)
            resp = client.get("/api/events?interest_source=follows")

            assert resp.status_code == 200
            assert resp.json() == []
            assert resp.headers["cache-control"] == "private, max-age=0"
            assert resp.headers["vary"] == "Cookie"
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

    def test_get_events_start_date_uses_overlap_filter(
        self, sample_calendar, sample_events
    ):
        captured_sql = {}
        mock_session = MagicMock(spec=Session)

        def mock_exec(stmt):
            result = MagicMock()
            sql_text = str(stmt)
            if "calendar_settings" in sql_text:
                result.all.return_value = [sample_calendar]
            elif "cached_events" in sql_text:
                captured_sql["value"] = sql_text
                result.all.return_value = sample_events
            elif "event_views" in sql_text and "GROUP BY" in sql_text:
                result.all.return_value = []
            else:
                result.all.return_value = []
            return result

        mock_session.exec = mock_exec
        app.dependency_overrides[get_session] = lambda: mock_session
        try:
            client = TestClient(app)
            with patch(
                "backend.api.routes.events._get_since_date",
                return_value="2020-01-01T00:00:00",
            ):
                resp = client.get("/api/events?start_date=2026-04-20")
            assert resp.status_code == 200
            sql_text = captured_sql["value"]
            assert (
                'cached_events."end" >=' in sql_text
                or "cached_events.end >=" in sql_text
            )
            assert (
                "cached_events.start >=" not in sql_text
                and 'cached_events."start" >=' not in sql_text
            )
        finally:
            app.dependency_overrides.clear()

    def test_search_events_allows_anonymous_and_filters_hidden_deleted_and_past(
        self, sqlite_client
    ):
        client, engine = sqlite_client
        now = datetime.now(UTC).replace(tzinfo=None)

        with Session(engine) as session:
            session.add(
                CalendarSetting(
                    calendar_id="cal-1",
                    name="Test Calendar",
                    enabled=True,
                    color="#ff0000",
                )
            )
            session.add_all(
                [
                    CachedEvent(
                        event_id="evt-future-1",
                        calendar_id="cal-1",
                        title="Salsa Social Night",
                        location="Studio One",
                        start=now + timedelta(days=2),
                        end=now + timedelta(days=2, hours=3),
                        all_day=False,
                        is_hidden=False,
                    ),
                    CachedEvent(
                        event_id="evt-future-2",
                        calendar_id="cal-1",
                        title="Late Salsa Social",
                        location="Studio Two",
                        start=now + timedelta(days=7),
                        end=now + timedelta(days=7, hours=3),
                        all_day=False,
                        is_hidden=False,
                    ),
                    CachedEvent(
                        event_id="evt-hidden",
                        calendar_id="cal-1",
                        title="Hidden Salsa Social",
                        location="Hidden Venue",
                        start=now + timedelta(days=3),
                        end=now + timedelta(days=3, hours=3),
                        all_day=False,
                        is_hidden=True,
                    ),
                    CachedEvent(
                        event_id="evt-deleted",
                        calendar_id="cal-1",
                        title="Deleted Salsa Social",
                        location="Deleted Venue",
                        start=now + timedelta(days=4),
                        end=now + timedelta(days=4, hours=3),
                        all_day=False,
                        is_hidden=False,
                        deleted_at=now,
                    ),
                    CachedEvent(
                        event_id="evt-past",
                        calendar_id="cal-1",
                        title="Past Salsa Social",
                        location="Old Venue",
                        start=now - timedelta(days=2),
                        end=now - timedelta(days=2, hours=-3),
                        all_day=False,
                        is_hidden=False,
                    ),
                ]
            )
            session.commit()

        resp = client.get("/api/events/search?q=salsa&limit=10")

        assert resp.status_code == 200
        data = resp.json()
        assert [row["event_id"] for row in data] == ["evt-future-1", "evt-future-2"]
        assert data[0]["location"] == "Studio One"

    def test_search_events_rejects_too_short_query(self, sqlite_client):
        client, _engine = sqlite_client

        resp = client.get("/api/events/search?q=s")

        assert resp.status_code == 422

    def test_get_events_paginates_with_limit_and_offset(self, sqlite_client):
        client, engine = sqlite_client
        now = datetime.now(UTC).replace(tzinfo=None)

        with Session(engine) as session:
            session.add(
                CalendarSetting(
                    calendar_id="cal-1",
                    name="Test Calendar",
                    enabled=True,
                    color="#ff0000",
                )
            )
            session.add_all(
                [
                    CachedEvent(
                        event_id=f"evt-{i}",
                        calendar_id="cal-1",
                        title=f"Event {i}",
                        location="Venue",
                        start=now + timedelta(days=i),
                        end=now + timedelta(days=i, hours=3),
                        all_day=False,
                        is_hidden=False,
                    )
                    for i in range(3)
                ]
            )
            session.commit()

        resp = client.get("/api/events?limit=2")
        assert resp.status_code == 200
        data = resp.json()
        assert [row["event_id"] for row in data] == ["evt-0", "evt-1"]
        assert resp.headers["x-has-more"] == "true"

        resp = client.get("/api/events?limit=2&offset=2")
        assert resp.status_code == 200
        data = resp.json()
        assert [row["event_id"] for row in data] == ["evt-2"]
        assert resp.headers["x-has-more"] == "false"

    def test_get_events_omits_has_more_header_when_unpaginated(
        self, sample_calendar, sample_events
    ):
        mock_session = make_session_with_data(
            calendars=[sample_calendar],
            events=sample_events,
        )
        app.dependency_overrides[get_session] = lambda: mock_session
        try:
            client = TestClient(app)
            resp = client.get("/api/events")
            assert resp.status_code == 200
            assert "x-has-more" not in resp.headers
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

    def test_patch_event_change_calendar(self):
        event = CachedEvent(
            event_id="evt-1",
            calendar_id="cal-1",
            title="t",
            start=datetime(2026, 5, 1, 20, 0),
            end=datetime(2026, 5, 1, 23, 0),
        )
        cal_old = CalendarSetting(
            calendar_id="cal-1", name="Old", enabled=True, color="#ff0000"
        )
        cal_new = CalendarSetting(
            calendar_id="cal-2", name="New", enabled=True, color="#00ff00"
        )

        def _get(model, key):
            if model == CachedEvent:
                return event
            if key == "cal-1":
                return cal_old
            if key == "cal-2":
                return cal_new
            return None

        mock_session = MagicMock(spec=Session)
        mock_session.get.side_effect = _get
        app.dependency_overrides[get_session] = lambda: mock_session
        app.dependency_overrides[require_admin] = _fake_admin
        try:
            client = TestClient(app)
            resp = client.patch(
                "/api/admin/events/evt-1", json={"calendar_id": "cal-2"}
            )
            assert resp.status_code == 200
            assert resp.json()["calendar_id"] == "cal-2"
        finally:
            app.dependency_overrides.clear()

    def test_patch_event_unknown_calendar_rejected(self):
        event = CachedEvent(
            event_id="evt-1",
            calendar_id="cal-1",
            title="t",
            start=datetime(2026, 5, 1, 20, 0),
            end=datetime(2026, 5, 1, 23, 0),
        )

        def _get(model, key):
            if model == CachedEvent:
                return event
            return None

        mock_session = MagicMock(spec=Session)
        mock_session.get.side_effect = _get
        app.dependency_overrides[get_session] = lambda: mock_session
        app.dependency_overrides[require_admin] = _fake_admin
        try:
            client = TestClient(app)
            resp = client.patch("/api/admin/events/evt-1", json={"calendar_id": "nope"})
            assert resp.status_code == 400
        finally:
            app.dependency_overrides.clear()

    def test_patch_event_review_status(self):
        event = CachedEvent(
            event_id="evt-1",
            calendar_id="cal-1",
            title="t",
            start=datetime(2026, 5, 1, 20, 0),
            end=datetime(2026, 5, 1, 23, 0),
            review_status="pending",
        )
        cal = CalendarSetting(
            calendar_id="cal-1", name="C", enabled=True, color="#ff0000"
        )
        mock_session = MagicMock(spec=Session)
        mock_session.get.side_effect = lambda model, key: (
            event if model == CachedEvent else cal
        )
        app.dependency_overrides[get_session] = lambda: mock_session
        app.dependency_overrides[require_admin] = _fake_admin
        try:
            client = TestClient(app)
            resp = client.patch(
                "/api/admin/events/evt-1", json={"review_status": "reviewed"}
            )
            assert resp.status_code == 200
            assert resp.json()["review_status"] == "reviewed"
        finally:
            app.dependency_overrides.clear()

    def test_patch_event_invalid_review_status(self):
        event = CachedEvent(
            event_id="evt-1",
            calendar_id="cal-1",
            title="t",
            start=datetime(2026, 5, 1, 20, 0),
            end=datetime(2026, 5, 1, 23, 0),
        )
        mock_session = MagicMock(spec=Session)
        mock_session.get.return_value = event
        app.dependency_overrides[get_session] = lambda: mock_session
        app.dependency_overrides[require_admin] = _fake_admin
        try:
            client = TestClient(app)
            resp = client.patch(
                "/api/admin/events/evt-1", json={"review_status": "garbage"}
            )
            assert resp.status_code == 422
        finally:
            app.dependency_overrides.clear()


@pytest.mark.unit
class TestGeocodeEndpoint:
    def test_geocode_search_returns_results(self):
        app.dependency_overrides[require_admin] = _fake_admin
        try:
            with patch(
                "backend.api.routes.admin.search_locations",
                return_value=[
                    {
                        "display_name": "Paris, France",
                        "latitude": 48.8566,
                        "longitude": 2.3522,
                    }
                ],
            ):
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

    def test_events_requires_auth(self):
        app.dependency_overrides.clear()
        client = TestClient(app)
        resp = client.get("/api/admin/events")
        assert resp.status_code in (401, 403)


@pytest.mark.unit
class TestHideBlockEndpoints:
    def _make_event(self, is_hidden=False):
        return CachedEvent(
            event_id="evt-1",
            calendar_id="cal-1",
            title="Test",
            start=datetime(2099, 6, 1, 20, 0),
            end=datetime(2099, 6, 1, 23, 0),
            is_hidden=is_hidden,
        )

    def _make_cal(self):
        return CalendarSetting(
            calendar_id="cal-1", name="C", enabled=True, color="#ff0000"
        )

    def test_patch_is_hidden_true_returns_is_hidden(self):
        event = self._make_event()
        cal = self._make_cal()
        mock_session = MagicMock(spec=Session)
        mock_session.get.side_effect = lambda model, key: (
            event if model == CachedEvent else cal
        )
        app.dependency_overrides[get_session] = lambda: mock_session
        app.dependency_overrides[require_admin] = _fake_admin
        try:
            client = TestClient(app)
            resp = client.patch("/api/admin/events/evt-1", json={"is_hidden": True})
            assert resp.status_code == 200
            assert resp.json()["is_hidden"] is True
        finally:
            app.dependency_overrides.clear()

    def test_block_event_sets_is_hidden_and_is_blocked(self):
        event = self._make_event()
        cal = self._make_cal()
        mock_session = MagicMock(spec=Session)
        mock_session.get.side_effect = lambda model, key: (
            event if model == CachedEvent else (None if model == BlockedEvent else cal)
        )
        app.dependency_overrides[get_session] = lambda: mock_session
        app.dependency_overrides[require_admin] = _fake_admin
        try:
            client = TestClient(app)
            resp = client.post("/api/admin/events/evt-1/block")
            assert resp.status_code == 200
            data = resp.json()
            assert data["is_hidden"] is True
            assert data["is_blocked"] is True
        finally:
            app.dependency_overrides.clear()

    def test_block_event_not_found(self):
        mock_session = MagicMock(spec=Session)
        mock_session.get.return_value = None
        app.dependency_overrides[get_session] = lambda: mock_session
        app.dependency_overrides[require_admin] = _fake_admin
        try:
            client = TestClient(app)
            resp = client.post("/api/admin/events/nonexistent/block")
            assert resp.status_code == 404
        finally:
            app.dependency_overrides.clear()

    def test_unblock_event_clears_is_hidden_and_is_blocked(self):
        event = self._make_event(is_hidden=True)
        cal = self._make_cal()
        blocked = BlockedEvent(event_id="evt-1")
        mock_session = MagicMock(spec=Session)

        def _get(model, key):
            if model == CachedEvent:
                return event
            if model == BlockedEvent:
                return blocked
            return cal

        mock_session.get.side_effect = _get
        app.dependency_overrides[get_session] = lambda: mock_session
        app.dependency_overrides[require_admin] = _fake_admin
        try:
            client = TestClient(app)
            resp = client.delete("/api/admin/events/evt-1/block")
            assert resp.status_code == 200
            data = resp.json()
            assert data["is_hidden"] is False
            assert data["is_blocked"] is False
        finally:
            app.dependency_overrides.clear()

    def test_unblock_event_not_found(self):
        mock_session = MagicMock(spec=Session)
        mock_session.get.return_value = None
        app.dependency_overrides[get_session] = lambda: mock_session
        app.dependency_overrides[require_admin] = _fake_admin
        try:
            client = TestClient(app)
            resp = client.delete("/api/admin/events/nonexistent/block")
            assert resp.status_code == 404
        finally:
            app.dependency_overrides.clear()
