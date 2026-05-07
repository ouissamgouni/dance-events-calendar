"""API tests for the upcoming-only default filter and the retry-calendar
sync-job endpoint.

Both behaviors were added together to fix the staging admin UX bugs:
1. Admin listings/counters should default to upcoming events only.
2. The "Retry this calendar" button should hit a dedicated endpoint with
   explicit 404/400/409 contracts instead of overloading POST /sync-jobs.
"""

from datetime import datetime, timedelta
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from backend.api.deps import require_admin
from backend.api.main import app
from backend.db.database import get_session
from backend.db.models import CachedEvent, CalendarSetting


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
    now = datetime.utcnow()
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
