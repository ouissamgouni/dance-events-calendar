"""API tests for the admin Notifications activity endpoint.

Covers ``GET /api/admin/notifications/activity``: ``NotificationDelivery``
rows grouped by (local day, recipient) into outbound messages (a digest is
one message with N items), plus the per-event notification stats.
"""

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

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
    session: Session,
    notification_id: int,
    channel: str,
    delivered_at: datetime,
    mode: str | None = None,
    source: str | None = None,
) -> None:
    session.add(
        NotificationDelivery(
            notification_id=notification_id,
            channel=channel,
            delivered_at=delivered_at,
            mode=mode,
            source=source,
        )
    )


def _seed(engine):
    now = datetime.now(timezone.utc)
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


ACTIVITY_URL = "/api/admin/notifications/activity"


def _window(**extra) -> dict:
    now = datetime.now(timezone.utc)
    return {
        "start": (now - timedelta(days=1)).isoformat(),
        "end": (now + timedelta(hours=1)).isoformat(),
        **extra,
    }


def _seed_digest(engine, sent_at: datetime):
    """Alice gets 3 notifications, each in-app at creation, then one digest
    email + one push carrying all 3 at ``sent_at``."""
    with Session(engine) as s:
        alice = _make_user(s, "alice@example.com", "alice")
        bob = _make_user(s, "bob@example.com", "bob")
        notifs = [
            Notification(
                recipient_user_id=alice.id,
                actor_user_id=bob.id,
                kind=kind,
                event_id=event_id,
                created_at=sent_at - timedelta(hours=3),
            )
            for kind, event_id in (
                ("subscription_going", "evt-a"),
                ("subscription_going", "evt-b"),
                ("interest_event", "evt-c"),
            )
        ]
        s.add_all(notifs)
        s.flush()
        notifs[0].email_clicked_at = sent_at + timedelta(minutes=5)
        for n in notifs:
            _add_delivery(s, n.id, "app", sent_at - timedelta(hours=3))
            _add_delivery(s, n.id, "email", sent_at, mode="digest", source="tick")
            _add_delivery(s, n.id, "push", sent_at, source="tick")
        s.commit()
        return alice.id, bob.id, [n.id for n in notifs]


@pytest.mark.unit
class TestAdminNotificationsActivity:
    def test_digest_deliveries_merge_into_one_message(self, client, engine):
        sent_at = datetime.now(timezone.utc) - timedelta(minutes=30)
        _seed_digest(engine, sent_at)

        resp = client.get(ACTIVITY_URL, params=_window())
        assert resp.status_code == 200
        body = resp.json()
        assert body["total_groups"] == 1
        group = body["groups"][0]
        assert group["user"]["handle"] == "alice"
        assert group["in_app"] is None
        [message] = group["messages"]
        assert message["channels"] == ["email", "push"]
        assert (message["mode"], message["trigger"]) == ("digest", "auto")
        assert message["item_count"] == 3
        assert message["engaged_count"] == 1
        assert {t["topic"]: t["count"] for t in message["topics"]} == {
            "friends_going": 2,
            "interest_matches": 1,
        }
        item = message["items"][0]
        assert item["app_at"] and item["email_at"] and item["push_at"]
        assert item["latency_seconds"] == pytest.approx(3 * 3600, abs=1)
        summary = body["summary"]
        assert (summary["email_digest"], summary["push"], summary["auto"]) == (1, 1, 1)
        assert (summary["email_items"], summary["email_clicked"]) == (3, 1)
        assert summary["in_app_items"] == 0

    def test_include_in_app_adds_feed_bucket(self, client, engine):
        sent_at = datetime.now(timezone.utc) - timedelta(minutes=30)
        _seed_digest(engine, sent_at)

        body = client.get(ACTIVITY_URL, params=_window(include_in_app=True)).json()
        # Feed rows are 3h before the send, so they may fall on the previous day.
        [in_app] = [g["in_app"] for g in body["groups"] if g["in_app"]]
        assert in_app["item_count"] == 3
        assert body["summary"]["in_app_items"] == 3

    def test_trigger_filter_keeps_only_forced_messages(self, client, engine):
        sent_at = datetime.now(timezone.utc) - timedelta(minutes=30)
        _, _, ids = _seed_digest(engine, sent_at)
        with Session(engine) as s:
            _add_delivery(
                s,
                ids[0],
                "email",
                sent_at + timedelta(minutes=10),
                mode="instant",
                source="admin",
            )
            s.commit()

        body = client.get(
            ACTIVITY_URL, params=_window(trigger="forced", include_in_app=True)
        ).json()
        [message] = body["groups"][0]["messages"]
        assert (message["channels"], message["trigger"]) == (["email"], "forced")
        assert body["groups"][0]["in_app"] is None
        assert (body["summary"]["forced"], body["summary"]["auto"]) == (1, 0)

    def test_day_bucket_follows_requested_timezone(self, client, engine):
        sent_at = datetime(2026, 10, 17, 23, 30, tzinfo=timezone.utc)
        _seed_digest(engine, sent_at)
        params = {"start": "2026-10-17T00:00:00Z", "end": "2026-10-19T00:00:00Z"}

        utc = client.get(ACTIVITY_URL, params={**params, "tz": "UTC"}).json()
        paris = client.get(ACTIVITY_URL, params={**params, "tz": "Europe/Paris"}).json()

        assert utc["groups"][0]["day"] == "2026-10-17"
        assert paris["groups"][0]["day"] == "2026-10-18"

    def test_paginates_groups_and_filters_by_user(self, client, engine):
        _seed(engine)
        with Session(engine) as s:
            bob_id = s.exec(select(User.id).where(User.handle == "bob")).one()

        page = client.get(ACTIVITY_URL, params=_window(limit=1)).json()
        assert page["total_groups"] == 2
        assert len(page["groups"]) == 1

        only_bob = client.get(ACTIVITY_URL, params=_window(user_id=str(bob_id))).json()
        assert [g["user"]["handle"] for g in only_bob["groups"]] == ["bob"]
        assert only_bob["groups"][0]["messages"][0]["trigger"] == "unknown"

    @pytest.mark.parametrize(
        "params",
        [
            {"start": "2026-01-01T00:00:00Z", "end": "2026-03-01T00:00:00Z"},
            _window(tz="Mars/Olympus"),
            _window(trigger="sometimes"),
            _window(channel="carrier_pigeon"),
        ],
    )
    def test_invalid_params_return_400(self, client, engine, params):
        resp = client.get(ACTIVITY_URL, params=params)
        assert resp.status_code == 400

    def test_admin_notif_activity_scenario_covers_every_trigger(
        self, client, engine, monkeypatch
    ):
        from backend.db.seed import SCENARIOS_DIR, DatabaseSeeder

        monkeypatch.setattr(
            "backend.config.loader.get_calendar_service_type", lambda: "mock"
        )
        with Session(engine) as s:
            DatabaseSeeder(s).seed(SCENARIOS_DIR / "admin-notif-activity")

        now = datetime.now(timezone.utc)
        window = {
            "start": (now - timedelta(days=8)).isoformat(),
            "end": (now + timedelta(hours=1)).isoformat(),
            "limit": 100,
        }
        body = client.get(ACTIVITY_URL, params=window).json()

        summary = body["summary"]
        assert {k: summary[k] for k in ("auto", "user", "forced", "unknown")} == {
            "auto": 21,
            "user": 1,
            "forced": 3,
            "unknown": 1,
        }
        assert (summary["email_digest"], summary["email_instant"], summary["push"]) == (
            3,
            17,
            17,
        )
        assert (summary["email_clicked"], summary["push_opened"]) == (3, 4)
        assert body["total_groups"] > 20
        digests = [
            m
            for g in body["groups"]
            for m in g["messages"]
            if m["mode"] == "digest" and g["user"]["handle"] == "maya"
        ]
        assert [(m["item_count"], m["engaged_count"]) for m in digests] == [(4, 1)]


@pytest.mark.unit
class TestAdminEventNotificationStats:
    def test_counts_distinct_notifications_per_kind_and_channel(self, client, engine):
        from backend.db.models import CachedEvent, CalendarSetting

        _seed(engine)
        now = datetime.now(timezone.utc)
        with Session(engine) as s:
            s.add(
                CalendarSetting(calendar_id="cal", name="C", color="#abc", enabled=True)
            )
            s.add(
                CachedEvent(
                    event_id="evt-1",
                    calendar_id="cal",
                    title="Evt",
                    start=now + timedelta(days=3),
                    end=now + timedelta(days=3, hours=2),
                    review_status="reviewed",
                )
            )
            interest = s.exec(
                select(Notification).where(Notification.event_id == "evt-1")
            ).one()
            # A resend adds a second push row for the same notification.
            _add_delivery(s, interest.id, "push", now)
            s.commit()

        resp = client.get("/api/admin/events/evt-1/notification-stats")

        assert resp.status_code == 200
        body = resp.json()
        assert body["by_kind"] == [
            {
                "kind": "interest_event",
                "app": 1,
                "email": 0,
                "push": 1,
                "users": 1,
                "app_reads": 0,
                "push_opens": 0,
                "email_clicks": 0,
            }
        ]
        assert body["total_users"] == 1
        assert body["interest"]["already_notified_users"] == 1
        assert body["interest"]["ineligible_reason"] == "not geolocated"

    def test_unknown_event_returns_404(self, client, engine):
        resp = client.get("/api/admin/events/nope/notification-stats")
        assert resp.status_code == 404
