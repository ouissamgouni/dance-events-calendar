"""API tests for the admin Notifications activity endpoint.

Covers ``GET /api/admin/notifications/activity``: ``NotificationDelivery``
rows rebuilt into outbound sends (a digest is one row with N items), paged
flat or by (local day, recipient), plus the per-event notification stats.
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
    batch_id: str | None = None,
    rendered: bool | None = None,
) -> None:
    session.add(
        NotificationDelivery(
            notification_id=notification_id,
            channel=channel,
            delivered_at=delivered_at,
            mode=mode,
            source=source,
            batch_id=batch_id,
            rendered=rendered,
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
            _add_delivery(
                s, n.id, "email", sent_at, mode="digest", source="tick", batch_id="e1"
            )
            _add_delivery(s, n.id, "push", sent_at, source="tick", batch_id="p1")
        s.commit()
        return alice.id, bob.id, [n.id for n in notifs]


@pytest.mark.unit
class TestAdminNotificationsActivity:
    def test_digest_deliveries_merge_into_one_row(self, client, engine):
        sent_at = datetime.now(timezone.utc) - timedelta(minutes=30)
        _seed_digest(engine, sent_at)

        resp = client.get(ACTIVITY_URL, params=_window())
        assert resp.status_code == 200
        body = resp.json()
        assert body["total"] == 1 and body["groups"] == []
        [row] = body["rows"]
        assert row["user"]["handle"] == "alice"
        assert row["channels"] == ["email", "push"]
        assert (row["mode"], row["trigger"]) == ("digest", "auto")
        assert row["item_count"] == 3
        assert row["engaged_count"] == 1
        assert (row["email_clicked"], row["push_opened"]) == (1, 0)
        assert {t["topic"]: t["count"] for t in row["topics"]} == {
            "friends_going": 2,
            "interest_matches": 1,
        }
        item = row["items"][0]
        assert item["latency_seconds"] == pytest.approx(3 * 3600, abs=1)
        summary = body["summary"]
        assert (summary["email_digest"], summary["push"], summary["auto"]) == (1, 1, 1)
        assert (summary["email_items"], summary["email_clicked"]) == (3, 1)
        assert summary["in_app_items"] == 0

    def test_include_in_app_adds_one_row_per_feed_delivery(self, client, engine):
        sent_at = datetime.now(timezone.utc) - timedelta(minutes=30)
        _seed_digest(engine, sent_at)

        body = client.get(ACTIVITY_URL, params=_window(include_in_app=True)).json()
        assert body["total"] == 4
        assert [r["channels"] for r in body["rows"]] == [
            ["email", "push"],
            ["app"],
            ["app"],
            ["app"],
        ]
        assert {r["trigger"] for r in body["rows"][1:]} == {"auto"}
        assert all(r["item_count"] == 1 for r in body["rows"][1:])
        assert body["summary"]["in_app_items"] == 3

    def test_rows_are_time_ordered_across_recipients(self, client, engine):
        _seed(engine)

        body = client.get(ACTIVITY_URL, params=_window()).json()
        assert [(r["user"]["handle"], r["channels"]) for r in body["rows"]] == [
            ("bob", ["push"]),
            ("alice", ["email"]),
        ]

    def test_group_by_recipient_pages_whole_recipient_days(self, client, engine):
        sent_at = datetime(2026, 10, 17, 12, 0, tzinfo=timezone.utc)
        _, bob_id, _ = _seed_digest(engine, sent_at)
        with Session(engine) as s:
            n = Notification(
                recipient_user_id=bob_id,
                actor_user_id=bob_id,
                kind="event_reminder",
                created_at=sent_at,
            )
            s.add(n)
            s.flush()
            _add_delivery(s, n.id, "push", sent_at - timedelta(hours=1), source="tick")
            s.commit()
        params = {
            "start": "2026-10-17T00:00:00Z",
            "end": "2026-10-18T00:00:00Z",
            "tz": "UTC",
            "include_in_app": True,
        }

        flat = client.get(ACTIVITY_URL, params=params).json()
        assert [r["user"]["handle"] for r in flat["rows"]] == [
            "alice",
            "bob",
            "alice",
            "alice",
            "alice",
        ]

        first = client.get(
            ACTIVITY_URL, params={**params, "group": "recipient", "limit": 1}
        ).json()
        assert first["total"] == 2 and first["rows"] == []
        [alice] = first["groups"]
        assert (alice["day"], alice["user"]["handle"]) == ("2026-10-17", "alice")
        assert [r["channels"] for r in alice["rows"]] == [
            ["email", "push"],
            ["app"],
            ["app"],
            ["app"],
        ]
        second = client.get(
            ACTIVITY_URL,
            params={**params, "group": "recipient", "limit": 1, "offset": 1},
        ).json()
        assert [g["user"]["handle"] for g in second["groups"]] == ["bob"]

    def test_same_tick_pushes_split_by_batch_and_legacy_topic(self, client, engine):
        sent_at = datetime.now(timezone.utc) - timedelta(minutes=30)
        _, _, ids = _seed_digest(engine, sent_at)
        later = sent_at + timedelta(minutes=10)
        with Session(engine) as s:
            # Batched: each item its own push at the same instant.
            for nid in ids:
                _add_delivery(s, nid, "push", later, source="tick", batch_id=f"b{nid}")
            # Legacy (no batch_id): split by topic.
            for nid in ids:
                _add_delivery(
                    s, nid, "push", later + timedelta(minutes=1), source="tick"
                )
            s.commit()

        body = client.get(ACTIVITY_URL, params=_window(channel="push")).json()
        counts = sorted(r["item_count"] for r in body["rows"])
        # 1 original 3-item push + 3 batched singles + legacy 2 (friends_going) + 1.
        assert counts == [1, 1, 1, 1, 2, 3]

    def test_engaged_and_unread_filters_keep_summary(self, client, engine):
        sent_at = datetime.now(timezone.utc) - timedelta(minutes=30)
        _, _, ids = _seed_digest(engine, sent_at)
        with Session(engine) as s:
            _add_delivery(
                s, ids[1], "push", sent_at + timedelta(minutes=5), source="tick"
            )
            n = s.get(Notification, ids[0])
            n.read_at = sent_at
            s.add(n)
            s.commit()

        engaged = client.get(ACTIVITY_URL, params=_window(engaged=True)).json()
        [row] = engaged["rows"]
        assert row["item_count"] == 3 and row["engaged_count"] == 1
        assert engaged["summary"]["push"] == 2

        unread = client.get(ACTIVITY_URL, params=_window(unread=True)).json()
        assert len(unread["rows"]) == 2
        assert unread["rows"][1]["read_count"] == 1

    def test_digest_items_cut_from_email_are_hidden(self, client, engine):
        sent_at = datetime.now(timezone.utc) - timedelta(minutes=30)
        _, _, ids = _seed_digest(engine, sent_at)
        with Session(engine) as s:
            for i, nid in enumerate(ids):
                _add_delivery(
                    s,
                    nid,
                    "email",
                    sent_at + timedelta(hours=1),
                    mode="digest",
                    source="tick",
                    batch_id="e2",
                    rendered=i < 2,
                )
            s.commit()

        body = client.get(ACTIVITY_URL, params=_window(channel="email")).json()
        latest = body["rows"][0]
        assert latest["item_count"] == 2
        assert {i["notification_id"] for i in latest["items"]} == {ids[0], ids[1]}
        assert body["summary"]["email_items"] == 5
        assert "email_overflow" not in body["summary"]

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
        [row] = body["rows"]
        assert (row["channels"], row["trigger"]) == (["email"], "forced")
        assert (body["summary"]["forced"], body["summary"]["auto"]) == (1, 0)

    def test_day_bucket_follows_requested_timezone(self, client, engine):
        sent_at = datetime(2026, 10, 17, 23, 30, tzinfo=timezone.utc)
        _seed_digest(engine, sent_at)
        params = {
            "start": "2026-10-17T00:00:00Z",
            "end": "2026-10-19T00:00:00Z",
            "group": "recipient",
        }

        utc = client.get(ACTIVITY_URL, params={**params, "tz": "UTC"}).json()
        paris = client.get(ACTIVITY_URL, params={**params, "tz": "Europe/Paris"}).json()

        assert utc["groups"][0]["day"] == "2026-10-17"
        assert paris["groups"][0]["day"] == "2026-10-18"

    def test_people_joined_push_has_readable_summary(self, client, engine):
        sent_at = datetime.now(timezone.utc) - timedelta(minutes=30)
        with Session(engine) as s:
            alice = _make_user(s, "alice@example.com", "alice")
            bob = _make_user(s, "bob@example.com", "bob")
            n = Notification(
                recipient_user_id=alice.id,
                actor_user_id=bob.id,
                kind="suggested_person_joined",
                context="3",
                created_at=sent_at,
            )
            s.add(n)
            s.flush()
            _add_delivery(s, n.id, "push", sent_at, mode="instant", source="tick")
            s.commit()

        [row] = client.get(ACTIVITY_URL, params=_window()).json()["rows"]
        assert row["topics"] == [{"topic": "people_suggestions", "count": 1}]
        assert row["items"][0]["summary"] == "Bob joined Movida · 3 mutual connections"

    def test_digest_items_follow_email_section_order(self, client, engine):
        sent_at = datetime.now(timezone.utc) - timedelta(minutes=30)
        with Session(engine) as s:
            alice = _make_user(s, "alice@example.com", "alice")
            bob = _make_user(s, "bob@example.com", "bob")
            notifs = [
                Notification(
                    recipient_user_id=alice.id,
                    actor_user_id=actor,
                    kind=kind,
                    event_id=event_id,
                    created_at=sent_at - timedelta(hours=1),
                )
                for kind, actor, event_id in (
                    ("interest_event", alice.id, "evt-a"),
                    ("subscription_going", bob.id, "evt-b"),
                    ("new_follower", bob.id, None),
                )
            ]
            s.add_all(notifs)
            s.flush()
            for n in notifs:
                _add_delivery(
                    s, n.id, "email", sent_at, mode="digest", source="tick", batch_id="e1"
                )
            s.commit()

        [row] = client.get(ACTIVITY_URL, params=_window()).json()["rows"]
        expected = ["interest_matches", "friends_going", "social_activity"]
        assert [t["topic"] for t in row["topics"]] == expected
        assert [i["topic"] for i in row["items"]] == expected

    def test_unsent_rows_need_outcome_filter(self, client, engine):
        sent_at = datetime.now(timezone.utc) - timedelta(minutes=30)
        with Session(engine) as s:
            alice = _make_user(s, "alice@example.com", "alice")
            bob = _make_user(s, "bob@example.com", "bob")
            n = Notification(
                recipient_user_id=alice.id,
                actor_user_id=bob.id,
                kind="new_follower",
                created_at=sent_at,
            )
            s.add(n)
            s.flush()
            gone = "Device unsubscribed (endpoint gone)"
            s.add_all(
                [
                    NotificationDelivery(
                        notification_id=n.id,
                        channel="push",
                        delivered_at=sent_at,
                        source="tick",
                        batch_id="p1",
                        status="failed",
                        detail=gone,
                    ),
                    NotificationDelivery(
                        notification_id=n.id,
                        channel="email",
                        delivered_at=sent_at,
                        mode="digest",
                        source="tick",
                        batch_id="e1",
                        status="skipped",
                        detail="Digest emails turned off",
                    ),
                    NotificationDelivery(
                        recipient_user_id=alice.id,
                        kind="install_app_invitation",
                        channel="email",
                        delivered_at=sent_at,
                        mode="instant",
                        source="admin",
                        batch_id="i1",
                    ),
                ]
            )
            s.commit()
            alice_id = alice.id

        body = client.get(ACTIVITY_URL, params=_window()).json()
        [row] = body["rows"]
        assert (row["status"], row["trigger"]) == (None, "forced")
        assert row["topics"] == [{"topic": "install_invite", "count": 1}]
        [item] = row["items"]
        assert item["notification_id"] is None
        assert item["summary"] == "Invitation to install the app"
        summary = body["summary"]
        assert (
            summary["push_failed"],
            summary["email_failed"],
            summary["digest_skipped"],
        ) == (1, 0, 1)

        [failed] = client.get(
            ACTIVITY_URL, params=_window(outcome="push_failed")
        ).json()["rows"]
        assert (failed["channels"], failed["status"], failed["detail"]) == (
            ["push"],
            "failed",
            gone,
        )
        [skipped] = client.get(
            ACTIVITY_URL, params=_window(outcome="digest_skipped")
        ).json()["rows"]
        assert (skipped["mode"], skipped["status"]) == ("digest", "skipped")

        by_user = client.get(ACTIVITY_URL, params=_window(user_id=str(alice_id)))
        assert by_user.json()["total"] == 1
        by_query = client.get(ACTIVITY_URL, params=_window(q="alice"))
        assert by_query.json()["total"] == 1

    def test_paginates_rows_and_filters_by_user(self, client, engine):
        _seed(engine)
        with Session(engine) as s:
            bob_id = s.exec(select(User.id).where(User.handle == "bob")).one()

        page = client.get(ACTIVITY_URL, params=_window(limit=1)).json()
        assert page["total"] == 2
        assert len(page["rows"]) == 1

        only_bob = client.get(ACTIVITY_URL, params=_window(user_id=str(bob_id))).json()
        assert [r["user"]["handle"] for r in only_bob["rows"]] == ["bob"]
        assert only_bob["rows"][0]["trigger"] == "unknown"

    @pytest.mark.parametrize(
        "params",
        [
            {"start": "2026-01-01T00:00:00Z", "end": "2026-03-01T00:00:00Z"},
            _window(tz="Mars/Olympus"),
            _window(trigger="sometimes"),
            _window(channel="carrier_pigeon"),
            _window(group="team"),
            _window(outcome="lost"),
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
        assert body["total"] == 26
        times = [r["sent_at"] for r in body["rows"]]
        assert times == sorted(times, reverse=True)
        digests = [
            r
            for r in body["rows"]
            if r["mode"] == "digest" and r["user"]["handle"] == "maya"
        ]
        # The 4th item was cut from the email body, so it is hidden.
        assert [(r["item_count"], r["engaged_count"]) for r in digests] == [(3, 1)]

        with_feed = client.get(
            ACTIVITY_URL, params={**window, "include_in_app": True}
        ).json()
        items = [i for r in with_feed["rows"] for i in r["items"]]
        assert all(
            i["read_at"] for i in items if i["email_clicked_at"] or i["push_opened_at"]
        )
        grouped = client.get(
            ACTIVITY_URL, params={**window, "group": "recipient"}
        ).json()
        assert sum(len(g["rows"]) for g in grouped["groups"]) == 26


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
