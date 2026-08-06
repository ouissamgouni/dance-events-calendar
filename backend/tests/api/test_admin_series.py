"""Tests for the admin event-series grouping API.

Covers:
- auth gate (require_admin) on every endpoint
- GET /api/admin/series (status filter)
- GET /api/admin/series/history
- POST /api/admin/series/scan (manual full scan, ignores feature flag)
- POST /api/admin/series/manual (group events as a series)
- POST /api/admin/series/{series_id}/approve
- POST /api/admin/series/{series_id}/dismiss
- POST /api/admin/series/{series_id}/split (removes a member; dissolves below two)
- POST /api/admin/series/{series_id}/add (append members; single-membership guard)
- PATCH /api/admin/series/{series_id} (rename)
- GET /api/admin/events/{event_id}/series
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

os.environ.setdefault("SESSION_SECRET", "test-secret-admin-series")
os.environ.setdefault("ADMIN_EMAIL", "admin@example.com")
os.environ["DEV_AUTH"] = "true"

from backend.api.main import app  # noqa: E402
from backend.api.routes import auth as auth_module  # noqa: E402
from backend.db.database import get_session  # noqa: E402
from backend.db.models import CachedEvent, EventSeries  # noqa: E402


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
def session(engine):
    with Session(engine) as s:
        yield s


@pytest.fixture
def client(engine):
    def _override():
        with Session(engine) as s:
            yield s

    app.dependency_overrides[get_session] = _override
    auth_module.limiter.reset()
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def _login(client: TestClient, email: str) -> None:
    r = client.post(
        "/api/auth/google",
        json={"credential": "ignored", "mock_email": email},
    )
    assert r.status_code == 200, r.text


def _seed_pair(session: Session) -> None:
    start = datetime.now(timezone.utc) + timedelta(days=3)
    e1 = CachedEvent(
        event_id="evt-aaa",
        calendar_id="cal-1",
        title="Weekly Salsa Social",
        start=start,
        end=start + timedelta(hours=3),
    )
    e2 = CachedEvent(
        event_id="evt-bbb",
        calendar_id="cal-1",
        title="Weekly Salsa Social",
        start=start + timedelta(days=7),
        end=start + timedelta(days=7, hours=3),
    )
    session.add_all([e1, e2])
    session.commit()


def _seed_triple(session: Session) -> None:
    start = datetime.now(timezone.utc) + timedelta(days=3)
    events = [
        CachedEvent(
            event_id=f"evt-{suffix}",
            calendar_id="cal-1",
            title="Weekly Salsa Social",
            start=start + timedelta(days=7 * i),
            end=start + timedelta(days=7 * i, hours=3),
        )
        for i, suffix in enumerate(("aaa", "bbb", "ccc"))
    ]
    session.add_all(events)
    session.commit()


@pytest.mark.unit
class TestAuthGate:
    @pytest.mark.parametrize(
        "method,path",
        [
            ("get", "/api/admin/series"),
            ("get", "/api/admin/series/history"),
            ("post", "/api/admin/series/scan"),
            ("post", "/api/admin/series/1/approve"),
            ("post", "/api/admin/series/1/dismiss"),
            ("post", "/api/admin/series/1/split"),
            ("post", "/api/admin/series/1/add"),
            ("patch", "/api/admin/series/1"),
            ("get", "/api/admin/events/evt-aaa/series"),
        ],
    )
    def test_requires_admin(self, client, session, method, path):
        _login(client, "civilian@example.com")
        if method == "post":
            r = client.post(path, json={})
        elif method == "patch":
            r = client.patch(path, json={})
        else:
            r = client.get(path)
        assert r.status_code == 403


@pytest.mark.unit
class TestScanAndList:
    def test_scan_creates_series_and_list_returns_it(self, client, session):
        _seed_pair(session)
        _login(client, "admin@example.com")

        r = client.post("/api/admin/series/scan")
        assert r.status_code == 200, r.text
        assert r.json()["groups_created"] == 1

        r = client.get("/api/admin/series", params={"status": "pending"})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["total"] == 1
        group = body["items"][0]
        assert group["status"] == "pending"
        assert group["source"] == "auto"
        event_ids = {e["event_id"] for e in group["events"]}
        assert event_ids == {"evt-aaa", "evt-bbb"}

    def test_list_filters_by_status(self, client, session):
        _seed_pair(session)
        _login(client, "admin@example.com")
        client.post("/api/admin/series/scan")

        r = client.get("/api/admin/series", params={"status": "resolved"})
        assert r.json()["total"] == 0

        r = client.get("/api/admin/series", params={"status": "all"})
        assert r.json()["total"] == 1

    def test_history_lists_scan_log(self, client, session):
        _seed_pair(session)
        _login(client, "admin@example.com")
        client.post("/api/admin/series/scan")

        r = client.get("/api/admin/series/history")
        assert r.status_code == 200
        body = r.json()
        assert body["total"] == 1
        assert body["items"][0]["scan_type"] == "full"
        assert body["items"][0]["status"] == "completed"


@pytest.mark.unit
class TestManualGrouping:
    def test_groups_events_as_series(self, client, session):
        _seed_pair(session)
        _login(client, "admin@example.com")

        r = client.post(
            "/api/admin/series/manual",
            json={
                "event_ids": ["evt-aaa", "evt-bbb"],
                "canonical_title": "Salsa Social",
            },
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["source"] == "manual"
        assert body["status"] == "pending"
        assert body["canonical_title"] == "Salsa Social"

    def test_rejects_unknown_event_id(self, client, session):
        _seed_pair(session)
        _login(client, "admin@example.com")

        r = client.post(
            "/api/admin/series/manual",
            json={"event_ids": ["evt-aaa", "evt-missing"]},
        )
        assert r.status_code == 404

    def test_rejects_event_already_in_a_series(self, client, session):
        _seed_triple(session)
        _login(client, "admin@example.com")
        client.post(
            "/api/admin/series/manual",
            json={"event_ids": ["evt-aaa", "evt-bbb"]},
        )

        r = client.post(
            "/api/admin/series/manual",
            json={"event_ids": ["evt-bbb", "evt-ccc"]},
        )
        assert r.status_code == 409
        conflicts = r.json()["detail"]["conflicts"]
        assert {c["event_id"] for c in conflicts} == {"evt-bbb"}


@pytest.mark.unit
class TestApproveDismissSplit:
    def test_approve_resolves_series_without_hiding_members(self, client, session):
        _seed_pair(session)
        _login(client, "admin@example.com")
        client.post("/api/admin/series/scan")
        series_id = session.exec(select(EventSeries)).one().id

        r = client.post(
            f"/api/admin/series/{series_id}/approve",
            json={"canonical_title": "Salsa Social"},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] == "resolved"
        assert body["canonical_title"] == "Salsa Social"

        assert session.get(CachedEvent, "evt-aaa").is_hidden is False
        assert session.get(CachedEvent, "evt-bbb").is_hidden is False

    def test_dismiss_marks_series_dismissed(self, client, session):
        _seed_pair(session)
        _login(client, "admin@example.com")
        client.post("/api/admin/series/scan")
        series_id = session.exec(select(EventSeries)).one().id

        r = client.post(f"/api/admin/series/{series_id}/dismiss")
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "dismissed"

    def test_split_removes_member_keeps_series(self, client, session):
        _seed_triple(session)
        _login(client, "admin@example.com")
        r = client.post(
            "/api/admin/series/manual",
            json={"event_ids": ["evt-aaa", "evt-bbb", "evt-ccc"]},
        )
        series_id = r.json()["id"]

        r = client.post(
            f"/api/admin/series/{series_id}/split",
            json={"event_id": "evt-bbb"},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["dissolved"] is False
        event_ids = {e["event_id"] for e in body["series"]["events"]}
        assert event_ids == {"evt-aaa", "evt-ccc"}

    def test_split_dissolves_series_below_two_members(self, client, session):
        _seed_pair(session)
        _login(client, "admin@example.com")
        client.post("/api/admin/series/scan")
        series_id = session.exec(select(EventSeries)).one().id

        r = client.post(
            f"/api/admin/series/{series_id}/split",
            json={"event_id": "evt-bbb"},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["dissolved"] is True
        assert body["series"] is None
        assert (
            client.get("/api/admin/series", params={"status": "all"}).json()["total"]
            == 0
        )

    def test_approve_unknown_series_returns_400(self, client, session):
        _login(client, "admin@example.com")
        r = client.post("/api/admin/series/999/approve", json={})
        assert r.status_code == 400


@pytest.mark.unit
class TestAddMembersAndRename:
    def test_add_appends_events_to_series(self, client, session):
        _seed_triple(session)
        _login(client, "admin@example.com")
        r = client.post(
            "/api/admin/series/manual",
            json={"event_ids": ["evt-aaa", "evt-bbb"]},
        )
        series_id = r.json()["id"]

        r = client.post(
            f"/api/admin/series/{series_id}/add",
            json={"event_ids": ["evt-ccc"]},
        )
        assert r.status_code == 200, r.text
        event_ids = {e["event_id"] for e in r.json()["events"]}
        assert event_ids == {"evt-aaa", "evt-bbb", "evt-ccc"}

    def test_add_rejects_event_already_in_a_series(self, client, session):
        _seed_triple(session)
        start = datetime.now(timezone.utc) + timedelta(days=40)
        session.add(
            CachedEvent(
                event_id="evt-ddd",
                calendar_id="cal-1",
                title="Weekly Salsa Social",
                start=start,
                end=start + timedelta(hours=3),
            )
        )
        session.commit()
        _login(client, "admin@example.com")
        first = client.post(
            "/api/admin/series/manual",
            json={"event_ids": ["evt-aaa", "evt-bbb"]},
        ).json()["id"]
        client.post(
            "/api/admin/series/manual",
            json={"event_ids": ["evt-ccc", "evt-ddd"]},
        )

        r = client.post(
            f"/api/admin/series/{first}/add",
            json={"event_ids": ["evt-ccc"]},
        )
        assert r.status_code == 409

    def test_add_unknown_series_returns_404(self, client, session):
        _seed_triple(session)
        _login(client, "admin@example.com")
        r = client.post(
            "/api/admin/series/999/add",
            json={"event_ids": ["evt-ccc"]},
        )
        assert r.status_code == 404

    def test_rename_updates_title(self, client, session):
        _seed_pair(session)
        _login(client, "admin@example.com")
        series_id = client.post(
            "/api/admin/series/manual",
            json={"event_ids": ["evt-aaa", "evt-bbb"]},
        ).json()["id"]

        r = client.patch(
            f"/api/admin/series/{series_id}",
            json={"canonical_title": "Tuesday Milonga"},
        )
        assert r.status_code == 200, r.text
        assert r.json()["canonical_title"] == "Tuesday Milonga"

    def test_rename_unknown_series_returns_404(self, client, session):
        _login(client, "admin@example.com")
        r = client.patch(
            "/api/admin/series/999",
            json={"canonical_title": "Nope"},
        )
        assert r.status_code == 404


@pytest.mark.unit
class TestEventCandidates:
    def test_returns_pending_series_for_event(self, client, session):
        _seed_pair(session)
        _login(client, "admin@example.com")
        client.post("/api/admin/series/scan")

        r = client.get("/api/admin/events/evt-aaa/series")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["total"] == 1
