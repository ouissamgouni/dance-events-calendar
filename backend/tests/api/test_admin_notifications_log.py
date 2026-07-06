"""API tests for the admin Notifications log endpoint.

Covers ``GET /api/admin/notifications/log``: the read-only audit list
backing the admin Notifications tab (type/channel/recipient filters +
pagination, sorted newest first).
"""

from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from backend.api.deps import require_admin
from backend.api.main import app
from backend.db.database import get_session
from backend.db.models import Notification, User


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
def client(engine):
    def _override():
        with Session(engine) as s:
            yield s

    app.dependency_overrides[get_session] = _override
    app.dependency_overrides[require_admin] = _fake_admin
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def _make_user(session: Session, email: str, handle: str) -> User:
    u = User(
        email=email,
        display_name=handle.title(),
        handle=handle,
        provider="google",
        provider_subject=f"mock|{email}",
    )
    session.add(u)
    session.commit()
    session.refresh(u)
    return u


def _seed(engine):
    now = datetime.utcnow()
    with Session(engine) as s:
        alice = _make_user(s, "alice@example.com", "alice")
        bob = _make_user(s, "bob@example.com", "bob")
        # Oldest: activity-digest kind for alice, emailed only.
        s.add(
            Notification(
                recipient_user_id=alice.id,
                actor_user_id=bob.id,
                kind="new_follower",
                created_at=now - timedelta(hours=2),
                emailed_at=now - timedelta(hours=1),
            )
        )
        # Middle: interest-match kind for bob, pushed only.
        s.add(
            Notification(
                recipient_user_id=bob.id,
                actor_user_id=bob.id,
                kind="interest_event",
                event_id="evt-1",
                created_at=now - timedelta(hours=1),
                pushed_at=now - timedelta(minutes=30),
            )
        )
        # Newest: event reminder for alice, neither emailed nor pushed yet.
        s.add(
            Notification(
                recipient_user_id=alice.id,
                actor_user_id=alice.id,
                kind="event_reminder",
                event_id="evt-2",
                created_at=now,
            )
        )
        s.commit()
    return alice, bob


@pytest.mark.unit
class TestAdminNotificationsLog:
    def test_lists_newest_first_with_type_and_channel_mapping(self, client, engine):
        _seed(engine)

        resp = client.get("/api/admin/notifications/log")
        assert resp.status_code == 200
        body = resp.json()
        assert body["total"] == 3
        items = body["items"]
        assert [i["kind"] for i in items] == [
            "event_reminder",
            "interest_event",
            "new_follower",
        ]
        assert [i["type"] for i in items] == [
            "event_reminder",
            "interest_match",
            "activity_digest",
        ]

        reminder, interest, digest = items
        assert reminder["channel_app"] is True
        assert reminder["channel_email"] is False
        assert reminder["channel_push"] is False
        assert interest["channel_push"] is True
        assert interest["channel_email"] is False
        assert digest["channel_email"] is True
        assert digest["channel_push"] is False
        assert digest["recipient_handle"] == "alice"

    def test_filters_by_type_channel_and_recipient_query(self, client, engine):
        _seed(engine)

        resp = client.get(
            "/api/admin/notifications/log", params={"type": "interest_match"}
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["total"] == 1
        assert body["items"][0]["kind"] == "interest_event"

        resp = client.get("/api/admin/notifications/log", params={"channel": "email"})
        assert resp.status_code == 200
        body = resp.json()
        assert body["total"] == 1
        assert body["items"][0]["kind"] == "new_follower"

        resp = client.get("/api/admin/notifications/log", params={"q": "bob"})
        assert resp.status_code == 200
        body = resp.json()
        assert body["total"] == 1
        assert body["items"][0]["recipient_handle"] == "bob"

    def test_unknown_type_returns_400(self, client, engine):
        _seed(engine)

        resp = client.get("/api/admin/notifications/log", params={"type": "not_a_type"})
        assert resp.status_code == 400
