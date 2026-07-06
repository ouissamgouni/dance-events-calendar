"""API tests for the admin Notifications log endpoint.

Covers ``GET /api/admin/notifications/log``: the read-only audit list
backing the admin Notifications tab (type/channel/recipient filters +
pagination, sorted newest first). Reads from ``NotificationDelivery`` —
one row per actual app/email/push distribution event — so a channel that
was never delivered (e.g. suppressed by a disabled user setting) simply
has no row, rather than being derived from a boolean flag.
"""

from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from backend.api.deps import require_admin
from backend.api.main import app
from backend.db.database import get_session
from backend.db.models import Notification, NotificationDelivery, User


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


def _add_delivery(
    session: Session, notification_id: int, channel: str, delivered_at: datetime
) -> None:
    session.add(
        NotificationDelivery(
            notification_id=notification_id,
            channel=channel,
            delivered_at=delivered_at,
        )
    )


def _seed(engine):
    now = datetime.utcnow()
    with Session(engine) as s:
        alice = _make_user(s, "alice@example.com", "alice")
        bob = _make_user(s, "bob@example.com", "bob")

        digest = Notification(
            recipient_user_id=alice.id,
            actor_user_id=bob.id,
            kind="new_follower",
            created_at=now - timedelta(hours=2),
        )
        s.add(digest)
        s.flush()

        interest = Notification(
            recipient_user_id=bob.id,
            actor_user_id=bob.id,
            kind="interest_event",
            event_id="evt-1",
            created_at=now - timedelta(hours=1),
        )
        s.add(interest)
        s.flush()

        reminder = Notification(
            recipient_user_id=alice.id,
            actor_user_id=alice.id,
            kind="event_reminder",
            event_id="evt-2",
            created_at=now,
        )
        s.add(reminder)
        s.flush()

        # One row per channel-event, deliberately out of created_at order
        # so ordering assertions exercise delivered_at, not created_at.
        _add_delivery(s, digest.id, "app", now - timedelta(hours=2, minutes=10))
        _add_delivery(s, digest.id, "email", now - timedelta(hours=1))
        _add_delivery(s, interest.id, "app", now - timedelta(hours=1, minutes=10))
        _add_delivery(s, interest.id, "push", now - timedelta(minutes=30))
        _add_delivery(s, reminder.id, "app", now)
        s.commit()
    return alice, bob


@pytest.mark.unit
class TestAdminNotificationsLog:
    def test_lists_newest_first_with_type_and_channel_mapping(self, client, engine):
        _seed(engine)

        resp = client.get("/api/admin/notifications/log")
        assert resp.status_code == 200
        body = resp.json()
        assert body["total"] == 5
        items = body["items"]
        assert [i["channel"] for i in items] == ["app", "push", "email", "app", "app"]
        assert [i["kind"] for i in items] == [
            "event_reminder",
            "interest_event",
            "new_follower",
            "interest_event",
            "new_follower",
        ]
        assert [i["type"] for i in items] == [
            "event_reminder",
            "interest_match",
            "activity_digest",
            "interest_match",
            "activity_digest",
        ]
        assert items[2]["recipient_handle"] == "alice"

    def test_filters_by_type_channel_and_recipient_query(self, client, engine):
        _seed(engine)

        resp = client.get(
            "/api/admin/notifications/log", params={"type": "interest_match"}
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["total"] == 2
        assert all(i["kind"] == "interest_event" for i in body["items"])

        resp = client.get("/api/admin/notifications/log", params={"channel": "email"})
        assert resp.status_code == 200
        body = resp.json()
        assert body["total"] == 1
        assert body["items"][0]["kind"] == "new_follower"

        resp = client.get("/api/admin/notifications/log", params={"channel": "app"})
        assert resp.status_code == 200
        body = resp.json()
        assert body["total"] == 3

        resp = client.get("/api/admin/notifications/log", params={"q": "bob"})
        assert resp.status_code == 200
        body = resp.json()
        assert body["total"] == 2
        assert all(i["recipient_handle"] == "bob" for i in body["items"])

    def test_unknown_type_returns_400(self, client, engine):
        _seed(engine)

        resp = client.get("/api/admin/notifications/log", params={"type": "not_a_type"})
        assert resp.status_code == 400

    def test_unknown_channel_returns_400(self, client, engine):
        _seed(engine)

        resp = client.get(
            "/api/admin/notifications/log", params={"channel": "carrier_pigeon"}
        )
        assert resp.status_code == 400

    def test_notification_without_a_channel_delivery_row_is_not_logged_for_it(
        self, client, engine
    ):
        """Regression test for the bug this table fixes: a notification for
        which email/push was never actually attempted/delivered (e.g. the
        recipient had that channel disabled) must not show up when filtering
        by that channel, since no ``NotificationDelivery`` row exists for it.
        """
        _seed(engine)

        resp = client.get("/api/admin/notifications/log", params={"channel": "push"})
        assert resp.status_code == 200
        body = resp.json()
        assert body["total"] == 1
        assert body["items"][0]["kind"] == "interest_event"
        # The "new_follower"/digest notification never got a push delivery
        # row recorded, so it must not appear under the push filter.
        assert all(i["kind"] != "new_follower" for i in body["items"])
