"""API tests for the upcoming-only default filter and the retry-calendar
sync-job endpoint.

Both behaviors were added together to fix the staging admin UX bugs:
1. Admin listings/counters should default to upcoming events only.
2. The "Retry this calendar" button should hit a dedicated endpoint with
   explicit 404/400/409 contracts instead of overloading POST /sync-jobs.
"""

from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from backend.api.deps import require_admin
from backend.api.main import app
from backend.db.database import get_session
from backend.db.models import (
    BlockedEvent,
    CachedEvent,
    CalendarSetting,
    EventPromoCode,
    EventSchedule,
    EventTag,
    SchedulePublication,
    UserEventAttendance,
    UserSavedEvent,
)


def _fake_admin():
    return {"email": "admin@example.com", "name": "Admin"}


@pytest.fixture
def engine():
    eng = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(eng)
    yield eng
    SQLModel.metadata.drop_all(eng)


@pytest.fixture
def client(engine, monkeypatch):
    def _override():
        with Session(engine) as s:
            yield s

    # Ensure the retry endpoint reads from the same in-memory engine.
    from backend.db import database as db_module

    monkeypatch.setattr(db_module, "get_engine", lambda: engine)

    app.dependency_overrides[get_session] = _override
    app.dependency_overrides[require_admin] = _fake_admin
    # Stub out the calendar service so the retry endpoint can be invoked
    # without spinning up a real Google client.
    app.state.calendar_service = MagicMock()
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def _seed_calendar(engine, *, calendar_id="cal-1", enabled=True, name="Test Cal"):
    with Session(engine) as s:
        s.add(CalendarSetting(calendar_id=calendar_id, name=name, enabled=enabled))
        s.commit()


def _seed_events(engine):
    now = datetime.now(timezone.utc)
    past = CachedEvent(
        event_id="evt-past",
        calendar_id="cal-1",
        title="Last Week's Salsa",
        start=now - timedelta(days=7, hours=2),
        end=now - timedelta(days=7),
    )
    future = CachedEvent(
        event_id="evt-future",
        calendar_id="cal-1",
        title="Next Week's Bachata",
        start=now + timedelta(days=7),
        end=now + timedelta(days=7, hours=3),
    )
    with Session(engine) as s:
        s.add(past)
        s.add(future)
        s.commit()


# ---------------------------------------------------------------------------
# include_past filter
# ---------------------------------------------------------------------------


@pytest.mark.unit
class TestIncludePastFilter:
    def test_default_excludes_past_events(self, client, engine):
        _seed_calendar(engine)
        _seed_events(engine)

        resp = client.get("/api/admin/events")
        assert resp.status_code == 200
        ids = {e["event_id"] for e in resp.json()["items"]}
        assert ids == {"evt-future"}

    def test_include_past_true_returns_all(self, client, engine):
        _seed_calendar(engine)
        _seed_events(engine)

        resp = client.get("/api/admin/events?include_past=true")
        assert resp.status_code == 200
        ids = {e["event_id"] for e in resp.json()["items"]}
        assert ids == {"evt-past", "evt-future"}

    def test_rows_include_views_clicks_and_alert_reach(self, client, engine):
        from backend.db.models import EventLinkClick, EventView

        _seed_calendar(engine)
        _seed_events(engine)
        with Session(engine) as s:
            s.add(EventView(event_id="evt-future", device_id="d1"))
            s.add(EventView(event_id="evt-future", device_id="d1"))
            s.add(EventView(event_id="evt-future", device_id="d2"))
            s.add(EventLinkClick(event_id="evt-future", url="https://x.test"))
            s.commit()

        resp = client.get("/api/admin/events")

        row = resp.json()["items"][0]
        assert row["view_count"] == 3
        assert row["unique_viewers"] == 2
        assert row["link_clicks"] == 1
        assert row["interest_reach"]["eligible"] is False
        assert row["interest_reach"]["ineligible_reason"] == "pending review"

    def test_filter_options_excludes_blocked_events_from_geo_counts(
        self, client, engine
    ):
        _seed_calendar(engine)
        now = datetime.now(timezone.utc)
        with Session(engine) as session:
            session.add_all(
                [
                    CachedEvent(
                        event_id="evt-open",
                        calendar_id="cal-1",
                        title="Open Event",
                        location="Open Venue",
                        start=now + timedelta(days=1),
                        end=now + timedelta(days=1, hours=2),
                    ),
                    CachedEvent(
                        event_id="evt-blocked",
                        calendar_id="cal-1",
                        title="Blocked Event",
                        location="Blocked Venue",
                        start=now + timedelta(days=1),
                        end=now + timedelta(days=1, hours=2),
                    ),
                    BlockedEvent(event_id="evt-blocked"),
                ]
            )
            session.commit()

        resp = client.get("/api/admin/events/filter-options")

        assert resp.status_code == 200
        geo_counts = {
            option["value"]: option["count"] for option in resp.json()["geo_statuses"]
        }
        assert geo_counts["ungeolocated"] == 1

    @pytest.mark.parametrize(
        ("geo_status", "expected_id"),
        [
            ("geolocated", "evt-geolocated"),
            ("ungeolocated", "evt-ungeolocated"),
            ("no-location", "evt-no-location"),
        ],
    )
    def test_geo_status_filters_events_and_ids(
        self, client, engine, geo_status, expected_id
    ):
        _seed_calendar(engine)
        now = datetime.now(timezone.utc)
        with Session(engine) as session:
            session.add_all(
                [
                    CachedEvent(
                        event_id="evt-geolocated",
                        calendar_id="cal-1",
                        title="Geolocated Event",
                        location="Mapped Venue",
                        latitude=48.8566,
                        longitude=2.3522,
                        start=now + timedelta(days=1),
                        end=now + timedelta(days=1, hours=2),
                    ),
                    CachedEvent(
                        event_id="evt-ungeolocated",
                        calendar_id="cal-1",
                        title="Ungeolocated Event",
                        location="Unknown Venue",
                        start=now + timedelta(days=1),
                        end=now + timedelta(days=1, hours=2),
                    ),
                    CachedEvent(
                        event_id="evt-no-location",
                        calendar_id="cal-1",
                        title="No Location Event",
                        start=now + timedelta(days=1),
                        end=now + timedelta(days=1, hours=2),
                    ),
                ]
            )
            session.commit()

        events_resp = client.get(f"/api/admin/events?geo_status={geo_status}")
        ids_resp = client.get(f"/api/admin/events/ids?geo_status={geo_status}")

        assert events_resp.status_code == 200
        assert [item["event_id"] for item in events_resp.json()["items"]] == [
            expected_id
        ]
        assert ids_resp.status_code == 200
        assert ids_resp.json()["ids"] == [expected_id]


def _event(event_id, days=1, **kwargs):
    now = datetime.now(timezone.utc)
    return CachedEvent(
        event_id=event_id,
        calendar_id="cal-1",
        title=event_id,
        start=now + timedelta(days=days),
        end=now + timedelta(days=days, hours=2),
        **kwargs,
    )


@pytest.mark.unit
class TestRichFilters:
    def _ids(self, client, **params):
        resp = client.get("/api/admin/events", params={"limit": 100, **params})
        assert resp.status_code == 200, resp.text
        ids = [item["event_id"] for item in resp.json()["items"]]
        ids_resp = client.get("/api/admin/events/ids", params=params)
        assert sorted(ids_resp.json()["ids"]) == sorted(ids)
        return ids

    def test_price_and_discount_filters_and_facets(self, client, engine):
        _seed_calendar(engine)
        now = datetime.now(timezone.utc)
        with Session(engine) as s:
            s.add_all(
                [
                    _event("free", price_is_free=True),
                    _event("paid", price_min=10.0, price_currency="EUR"),
                    _event("unknown"),
                    EventPromoCode(
                        event_id="paid",
                        code="A",
                        submitter_user_id=uuid4(),
                        status="approved",
                    ),
                    EventPromoCode(
                        event_id="free",
                        code="B",
                        submitter_user_id=uuid4(),
                        status="approved",
                        expires_at=now - timedelta(days=1),
                    ),
                    EventPromoCode(
                        event_id="unknown",
                        code="C",
                        submitter_user_id=uuid4(),
                        status="pending",
                    ),
                ]
            )
            s.commit()

        assert self._ids(client, price="paid") == ["paid"]
        assert set(self._ids(client, price="free,unknown")) == {"free", "unknown"}
        assert self._ids(client, discount="active") == ["paid"]
        assert set(self._ids(client, discount="active,expired")) == {"paid", "free"}

        opts = client.get(
            "/api/admin/events/filter-options", params={"price": "paid"}
        ).json()
        assert {o["value"]: o["count"] for o in opts["prices"]} == {
            "paid": 1,
            "free": 1,
            "unknown": 1,
        }
        assert {o["value"]: o["count"] for o in opts["discounts"]} == {
            "active": 1,
            "expired": 0,
        }
        assert opts["total_count"] == 1

    def test_program_engagement_and_has_filters(self, client, engine):
        _seed_calendar(engine)
        with Session(engine) as s:
            s.add_all(
                [
                    _event(
                        "published",
                        image_url="https://img.test/a.jpg",
                        links=[{"url": "https://tickets.test"}],
                    ),
                    _event("draft"),
                    _event("bare", links=[]),
                    EventSchedule(event_id="published", timezone="UTC"),
                    EventSchedule(event_id="draft", timezone="UTC"),
                    UserEventAttendance(device_id="d1", event_id="published"),
                    UserSavedEvent(device_id="d1", event_id="published"),
                    UserSavedEvent(device_id="d2", event_id="published"),
                    UserEventAttendance(device_id="d3", event_id="draft"),
                    EventTag(event_id="draft", tag_id=1),
                ]
            )
            s.commit()
            schedule = s.exec(
                select(EventSchedule).where(EventSchedule.event_id == "published")
            ).one()
            s.add(SchedulePublication(schedule_id=schedule.id, version=1, snapshot={}))
            s.commit()

        assert self._ids(client, program="published") == ["published"]
        assert self._ids(client, program="draft") == ["draft"]
        assert self._ids(client, program="none") == ["bare"]
        assert self._ids(client, going_min=1, saved_min=2) == ["published"]
        # d1 is both going and saved: counted once.
        assert self._ids(client, engaged_min=2) == ["published"]
        assert self._ids(client, engaged_min=3) == []
        assert self._ids(client, has_image="true") == ["published"]
        assert self._ids(client, has_links="true") == ["published"]
        assert set(self._ids(client, has_links="false")) == {"draft", "bare"}
        assert set(self._ids(client, has_tags="false")) == {"published", "bare"}
        assert self._ids(client, sort="engaged") == ["published", "draft", "bare"]
        assert self._ids(client, sort="engaged", order="asc")[0] == "bare"

        rows = {
            i["event_id"]: i for i in client.get("/api/admin/events").json()["items"]
        }
        assert rows["published"]["program_status"] == "published"
        assert rows["published"]["going_count"] == 1
        assert rows["published"]["saved_count"] == 2
        assert rows["published"]["engaged_count"] == 2
        assert rows["draft"]["program_status"] == "draft"
        assert rows["bare"]["program_status"] is None

    def test_in_series_and_date_range(self, client, engine):
        _seed_calendar(engine)
        shared = uuid4()
        with Session(engine) as s:
            s.add_all(
                [
                    _event("occ-1", suggestion_id=shared),
                    _event("occ-2", days=8, suggestion_id=shared),
                    _event("single"),
                    _event("last-month", days=-30),
                ]
            )
            s.commit()

        assert set(self._ids(client, in_series="true")) == {"occ-1", "occ-2"}
        assert self._ids(client, in_series="false") == ["single"]
        # An explicit range reaches past events without include_past.
        start = (datetime.now(timezone.utc) - timedelta(days=31)).date()
        end = (datetime.now(timezone.utc) - timedelta(days=29)).date()
        assert self._ids(
            client, start_from=start.isoformat(), start_to=end.isoformat()
        ) == ["last-month"]

    def test_rejects_unknown_facet_values(self, client, engine):
        assert client.get("/api/admin/events?price=cheap").status_code == 422
        assert client.get("/api/admin/events?sort=bogus").status_code == 422

    def test_sort_by_added(self, client, engine):
        _seed_calendar(engine)
        now = datetime.now(timezone.utc)
        with Session(engine) as s:
            old = _event("old")
            old.created_at = now - timedelta(days=3)
            new = _event("new", days=9)
            new.created_at = now
            s.add_all([old, new])
            s.commit()

        assert self._ids(client, sort="added") == ["new", "old"]
        assert self._ids(client, sort="added", order="asc") == ["old", "new"]
        item = client.get("/api/admin/events").json()["items"][0]
        assert item["created_at"] is not None

    def test_filter_options_scope_counts(self, client, engine):
        _seed_calendar(engine)
        with Session(engine) as s:
            s.add_all(
                [
                    _event(
                        "imaged", image_url="https://img.test/a.jpg", price_is_free=True
                    ),
                    _event("tagged", price_is_free=True),
                    _event("plain", location="Somewhere"),
                    _event("past", days=-10),
                    EventTag(event_id="tagged", tag_id=1),
                    UserEventAttendance(device_id="d1", event_id="plain"),
                ]
            )
            s.commit()

        opts = client.get(
            "/api/admin/events/filter-options",
            params={"price": "free", "has_image": "true", "include_past": "true"},
        ).json()
        assert opts["total_count"] == 1
        # Presets reset dates and other filters.
        assert opts["quick_views"]["all"] == 3
        assert opts["quick_views"]["untagged"] == 2
        assert opts["quick_views"]["geo"] == 1
        # has_image ignores its own selection; price still applies.
        assert opts["has_counts"]["has_image"] == {"yes": 1, "no": 1}
        assert opts["has_counts"]["has_tags"] == {"yes": 0, "no": 1}
        assert opts["min_counts"]["going_min"] == 0
        # Each active filter alone, with search + dates.
        assert opts["dimension_counts"] == {"dates": 4, "price": 2, "has_image": 1}


# ---------------------------------------------------------------------------
# /sync-jobs/{job_id}/retry-calendar
# ---------------------------------------------------------------------------


@pytest.mark.unit
class TestRetryCalendarEndpoint:
    def test_returns_404_for_unknown_calendar(self, client, engine):
        _seed_calendar(engine)
        resp = client.post(
            "/api/admin/sync-jobs/job-xyz/retry-calendar?calendar_id=nope"
        )
        assert resp.status_code == 404

    def test_returns_400_for_disabled_calendar(self, client, engine):
        _seed_calendar(engine, calendar_id="cal-off", enabled=False, name="Off Cal")
        resp = client.post(
            "/api/admin/sync-jobs/job-xyz/retry-calendar?calendar_id=cal-off"
        )
        assert resp.status_code == 400
        assert "disabled" in resp.json()["detail"].lower()

    def test_starts_job_for_enabled_calendar(self, client, engine):
        _seed_calendar(engine)

        fake_job = MagicMock()
        fake_job.model_dump = lambda: {"id": "job-new", "mode": "incremental"}

        with patch("backend.api.routes.admin.get_sync_job_service") as get_svc:
            svc = MagicMock()
            svc.start_job.return_value = fake_job
            get_svc.return_value = svc

            resp = client.post(
                "/api/admin/sync-jobs/job-xyz/retry-calendar?calendar_id=cal-1"
            )

            assert resp.status_code == 200
            assert svc.start_job.called
            kwargs = svc.start_job.call_args.kwargs
            assert kwargs["mode"] == "incremental"
            assert kwargs["calendar_ids"] == ["cal-1"]

    def test_returns_409_when_another_job_is_running(self, client, engine):
        _seed_calendar(engine)

        with patch("backend.api.routes.admin.get_sync_job_service") as get_svc:
            svc = MagicMock()
            svc.start_job.side_effect = RuntimeError("Another sync job is running")
            get_svc.return_value = svc

            resp = client.post(
                "/api/admin/sync-jobs/job-xyz/retry-calendar?calendar_id=cal-1"
            )
            assert resp.status_code == 409
