"""Tests for the admin near-duplicate event detection API.

Covers:
- auth gate (require_admin) on every endpoint
- GET /api/admin/duplicates (status filter)
- GET /api/admin/duplicates/history
- POST /api/admin/duplicates/scan (manual full scan, ignores feature flag)
- POST /api/admin/duplicates/manual (flag events as duplicates)
- POST /api/admin/duplicates/{group_id}/keep
- POST /api/admin/duplicates/{group_id}/dismiss
- GET /api/admin/events/{event_id}/duplicates
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

os.environ.setdefault("SESSION_SECRET", "test-secret-admin-duplicates")
os.environ.setdefault("ADMIN_EMAIL", "admin@example.com")
os.environ["DEV_AUTH"] = "true"

from backend.api.main import app  # noqa: E402
from backend.api.routes import auth as auth_module  # noqa: E402
from backend.db.database import get_session  # noqa: E402
from backend.db.models import CachedEvent, EventDuplicateGroup  # noqa: E402


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
        title="Salsa Night",
        start=start,
        end=start + timedelta(hours=3),
    )
    e2 = CachedEvent(
        event_id="evt-bbb",
        calendar_id="cal-2",
        title="Salsa Night",
        start=start + timedelta(hours=1),
        end=start + timedelta(hours=4),
    )
    session.add_all([e1, e2])
    session.commit()


@pytest.mark.unit
class TestAuthGate:
    @pytest.mark.parametrize(
        "method,path",
        [
            ("get", "/api/admin/duplicates"),
            ("get", "/api/admin/duplicates/history"),
            ("post", "/api/admin/duplicates/scan"),
            ("post", "/api/admin/duplicates/1/keep"),
            ("post", "/api/admin/duplicates/1/dismiss"),
            ("get", "/api/admin/events/evt-aaa/duplicates"),
        ],
    )
    def test_requires_admin(self, client, session, method, path):
        _login(client, "civilian@example.com")
        if method == "post":
            r = client.post(path, json={})
        else:
            r = client.get(path)
        assert r.status_code == 403


@pytest.mark.unit
class TestScanAndList:
    def test_scan_creates_group_and_list_returns_it(self, client, session):
        _seed_pair(session)
        _login(client, "admin@example.com")

        r = client.post("/api/admin/duplicates/scan")
        assert r.status_code == 200, r.text
        assert r.json()["groups_created"] == 1

        r = client.get("/api/admin/duplicates", params={"status": "pending"})
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
        client.post("/api/admin/duplicates/scan")

        r = client.get("/api/admin/duplicates", params={"status": "resolved"})
        assert r.json()["total"] == 0

        r = client.get("/api/admin/duplicates", params={"status": "all"})
        assert r.json()["total"] == 1

    def test_history_lists_scan_log(self, client, session):
        _seed_pair(session)
        _login(client, "admin@example.com")
        client.post("/api/admin/duplicates/scan")

        r = client.get("/api/admin/duplicates/history")
        assert r.status_code == 200
        body = r.json()
        assert body["total"] == 1
        assert body["items"][0]["scan_type"] == "full"
        assert body["items"][0]["status"] == "completed"


@pytest.mark.unit
class TestManualFlagging:
    def test_flags_events_as_duplicates(self, client, session):
        _seed_pair(session)
        _login(client, "admin@example.com")

        r = client.post(
            "/api/admin/duplicates/manual",
            json={"event_ids": ["evt-aaa", "evt-bbb"]},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["source"] == "manual"
        assert body["status"] == "pending"

    def test_rejects_unknown_event_id(self, client, session):
        _seed_pair(session)
        _login(client, "admin@example.com")

        r = client.post(
            "/api/admin/duplicates/manual",
            json={"event_ids": ["evt-aaa", "evt-missing"]},
        )
        assert r.status_code == 404


@pytest.mark.unit
class TestKeepAndDismiss:
    def test_keep_resolves_group_and_rejects_other_member(self, client, session):
        _seed_pair(session)
        _login(client, "admin@example.com")
        client.post("/api/admin/duplicates/scan")
        group_id = session.exec(select(EventDuplicateGroup)).one().id

        r = client.post(
            f"/api/admin/duplicates/{group_id}/keep",
            json={"keep_event_id": "evt-aaa"},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] == "resolved"
        assert body["kept_event_id"] == "evt-aaa"
        rejected = next(e for e in body["events"] if e["event_id"] == "evt-bbb")
        assert rejected["is_hidden"] is True
        assert rejected["is_blocked"] is True
        assert rejected["rejected_duplicate_reason"] is not None

    def test_dismiss_marks_group_dismissed(self, client, session):
        _seed_pair(session)
        _login(client, "admin@example.com")
        client.post("/api/admin/duplicates/scan")
        group_id = session.exec(select(EventDuplicateGroup)).one().id

        r = client.post(f"/api/admin/duplicates/{group_id}/dismiss")
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "dismissed"

    def test_keep_unknown_group_returns_400(self, client, session):
        _login(client, "admin@example.com")
        r = client.post(
            "/api/admin/duplicates/999/keep",
            json={"keep_event_id": "evt-aaa"},
        )
        assert r.status_code == 400


@pytest.mark.unit
class TestEventCandidates:
    def test_returns_pending_groups_for_event(self, client, session):
        _seed_pair(session)
        _login(client, "admin@example.com")
        client.post("/api/admin/duplicates/scan")

        r = client.get("/api/admin/events/evt-aaa/duplicates")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["total"] == 1
