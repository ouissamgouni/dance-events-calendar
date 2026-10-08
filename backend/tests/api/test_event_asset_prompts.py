"""Ticket & memories nudges (event_asset_prompts) and the ticket-likely rule."""

import os
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

os.environ.setdefault("SESSION_SECRET", "test-secret-asset-prompts")

from backend.api.deps import require_admin, require_user  # noqa: E402
from backend.api.main import app  # noqa: E402
from backend.db import database as database_module  # noqa: E402
from backend.db.database import get_session  # noqa: E402
from backend.db.models import (  # noqa: E402
    CachedEvent,
    CalendarSetting,
    EventUserAsset,
    Notification,
    NotificationDelivery,
    PushSubscription,
    SiteSetting,
    User,
    UserEventAttendance,
)
from backend.services import (  # noqa: E402
    activity_email,
    event_asset_prompts,
    event_assets,
    reminder_service,
)

NOW = datetime.now(timezone.utc)


@pytest.fixture
def engine():
    eng = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(eng)
    prev = database_module._engine
    database_module._engine = eng
    with Session(eng) as s:
        s.add(SiteSetting(key="event_tickets_enabled", value="true"))
        s.add(SiteSetting(key="event_memories_enabled", value="true"))
        s.add(CalendarSetting(calendar_id="cal", name="C", color="#abc", enabled=True))
        s.commit()
    yield eng
    database_module._engine = prev


@pytest.fixture
def session(engine):
    with Session(engine) as s:
        yield s


@pytest.fixture
def sent(monkeypatch):
    log = {"email": [], "push": []}
    monkeypatch.setattr(
        event_asset_prompts,
        "send_event_ticket_prompt_email",
        lambda u, e, **k: log["email"].append(("ticket", e.event_id)) or True,
    )
    monkeypatch.setattr(
        event_asset_prompts,
        "send_event_memories_prompt_email",
        lambda u, e, **k: log["email"].append(("memories", e.event_id)) or True,
    )
    monkeypatch.setattr(
        event_asset_prompts,
        "send_push",
        lambda uid, **k: log["push"].append(k["url"]) or 1,
    )
    return log


def _user(session, name, tz="UTC", **kwargs) -> User:
    u = User(
        email=f"{name}@example.com",
        display_name=name.title(),
        handle=name,
        timezone=tz,
        **kwargs,
    )
    session.add(u)
    session.commit()
    session.refresh(u)
    return u


def _event(session, event_id, start, hours=3, reach=None, override=None) -> CachedEvent:
    e = CachedEvent(
        event_id=event_id,
        calendar_id="cal",
        title=event_id.title(),
        start=start,
        end=start + timedelta(hours=hours),
        review_status="reviewed",
        reach=reach,
        advance_ticket_override=override,
    )
    session.add(e)
    session.commit()
    return e


def _going(session, user, event_id, since=None, **kwargs):
    session.add(
        UserEventAttendance(
            device_id=f"{user.handle}-{event_id}",
            user_id=user.id,
            event_id=event_id,
            attending_since=since or NOW - timedelta(hours=25),
            **kwargs,
        )
    )
    session.commit()


def _kinds(session, kind):
    return sorted(
        n.event_id
        for n in session.exec(
            select(Notification).where(Notification.kind == kind)
        ).all()
    )


# --- ticket_likely ---------------------------------------------------------


@pytest.mark.parametrize(
    ("reach", "hours", "override", "expected"),
    [
        ("international", 3, None, (True, "international")),
        ("local", 30, None, (True, "multi_day")),
        ("local", 3, None, (False, None)),
        (None, 3, True, (True, "admin")),
        ("international", 72, False, (False, "admin")),
    ],
)
def test_ticket_likely(reach, hours, override, expected):
    event = CachedEvent(
        event_id="e",
        calendar_id="c",
        start=NOW,
        end=NOW + timedelta(hours=hours),
        reach=reach,
        advance_ticket_override=override,
    )
    assert event_assets.ticket_likely(event, 20) == expected


# --- ticket prompt -----------------------------------------------------------


def test_ticket_prompt_targets_likely_events_only(session, sent):
    session.add(SiteSetting(key="ticket_prompt_email_instant", value="true"))
    session.commit()
    mia = _user(session, "mia")
    start = NOW + timedelta(days=6)
    _event(session, "intl", start, reach="international")
    _event(session, "festival", start, hours=50)
    _event(session, "local", start, reach="local")
    _event(session, "pinned", start, reach="local", override=True)
    _event(session, "unpinned", start, reach="international", override=False)
    for event_id in ("intl", "festival", "local", "pinned", "unpinned"):
        _going(session, mia, event_id)

    stats = event_asset_prompts.run_ticket_prompts()

    assert stats["prompts"] == 3
    assert _kinds(session, "event_ticket_prompt") == ["festival", "intl", "pinned"]
    assert sorted(e for _, e in sent["email"]) == ["festival", "intl", "pinned"]
    assert all("/ticket" in url for url in sent["push"])
    assert event_asset_prompts.run_ticket_prompts() == {"prompts": 0}


def test_ticket_prompt_skips_by_timing_and_state(session, sent):
    mia = _user(session, "mia")
    curator = _user(session, "cura")
    start = NOW + timedelta(days=6)
    for event_id in ("fresh", "close", "has-ticket", "dismissed", "curated"):
        _event(
            session,
            event_id,
            NOW + timedelta(hours=30) if event_id == "close" else start,
            reach="international",
        )
    _going(session, mia, "fresh", since=NOW - timedelta(hours=2))
    _going(session, mia, "close")
    _going(session, mia, "has-ticket")
    _going(session, mia, "dismissed", ticket_not_needed_at=NOW)
    _going(session, mia, "curated", created_by_admin_user_id=curator.id)
    session.add(
        EventUserAsset(
            user_id=mia.id,
            event_id="has-ticket",
            kind="ticket_link",
            url="https://t.example",
        )
    )
    session.commit()

    assert event_asset_prompts.run_ticket_prompts() == {"prompts": 0}


def test_ticket_prompt_backfills_channel_turned_on_later(session, sent):
    session.add(SiteSetting(key="ticket_prompt_email_instant", value="true"))
    session.commit()
    mia = _user(session, "mia", email_ticket_prompt_enabled=False)
    _event(session, "intl", NOW + timedelta(days=6), reach="international")
    _going(session, mia, "intl")

    event_asset_prompts.run_ticket_prompts()
    assert sent["email"] == []
    mia.email_ticket_prompt_enabled = True
    session.add(mia)
    session.commit()
    event_asset_prompts.run_ticket_prompts()

    assert sent["email"] == [("ticket", "intl")]
    assert len(_kinds(session, "event_ticket_prompt")) == 1


def test_ticket_prompt_respects_site_toggle(session, sent):
    session.add(SiteSetting(key="ticket_prompt_enabled", value="false"))
    session.commit()
    assert event_asset_prompts.run_ticket_prompts() == {
        "skipped": "ticket_prompt_disabled"
    }


def test_prompts_follow_their_own_feature_flag(session, sent):
    session.get(SiteSetting, "event_memories_enabled").value = "false"
    session.commit()
    assert event_asset_prompts.run_memories_prompts() == {"skipped": "feature_disabled"}
    assert "skipped" not in event_asset_prompts.run_ticket_prompts()


# --- admin delivery channels -------------------------------------------------


@pytest.fixture
def digests(monkeypatch):
    calls: list = []
    monkeypatch.setattr(
        activity_email,
        "send_activity_digest_v2_email",
        lambda recipient, sections, **_: (
            calls.append(
                {
                    s["feature"]: [e["primary_html"] for e in s["entries"]]
                    for s in sections
                }
            )
            or True
        ),
    )
    monkeypatch.setattr(activity_email, "send_push", lambda *a, **k: 0)
    return calls


def _digest_mode(session, feature):
    session.add(SiteSetting(key=f"{feature}_email_instant", value="false"))
    session.add(SiteSetting(key=f"{feature}_email_digest", value="true"))
    session.commit()


def test_ticket_prompt_digest_mode(session, sent, digests):
    _digest_mode(session, "ticket_prompt")
    mia = _user(session, "mia")
    _event(session, "intl", NOW + timedelta(days=6), reach="international")
    _going(session, mia, "intl")

    stats = event_asset_prompts.run_ticket_prompts()

    assert stats == {"prompts": 1, "emailed": 0, "pushed": 1}
    assert sent["email"] == []
    assert event_asset_prompts.run_ticket_prompts() == {"prompts": 0}
    assert activity_email.run_once(force=True)["digests"] == 1
    assert list(digests[0]) == ["ticket_prompt"]
    assert "/event/intl/ticket" in digests[0]["ticket_prompt"][0]
    notif = session.exec(
        select(Notification).where(Notification.kind == "event_ticket_prompt")
    ).one()
    session.refresh(notif)
    assert notif.emailed_at is not None


def test_ticket_prompt_digest_drops_stale_rows(session, sent, digests):
    _digest_mode(session, "ticket_prompt")
    mia = _user(session, "mia")
    for event_id, start in (
        ("soon", NOW + timedelta(hours=20)),
        ("has-ticket", NOW + timedelta(days=6)),
        ("dismissed", NOW + timedelta(days=6)),
        ("not-going", NOW + timedelta(days=6)),
        ("fine", NOW + timedelta(days=6)),
    ):
        _event(session, event_id, start, reach="international")
        session.add(
            Notification(
                recipient_user_id=mia.id,
                actor_user_id=mia.id,
                kind="event_ticket_prompt",
                event_id=event_id,
            )
        )
    session.commit()
    _going(session, mia, "soon")
    _going(session, mia, "has-ticket")
    _going(session, mia, "dismissed", ticket_not_needed_at=NOW)
    _going(session, mia, "fine")
    session.add(
        EventUserAsset(
            user_id=mia.id, event_id="has-ticket", kind="ticket_link", url="https://t"
        )
    )
    session.commit()

    activity_email.run_once(force=True)

    assert len(digests) == 1
    assert len(digests[0]["ticket_prompt"]) == 1
    assert "/event/fine/ticket" in digests[0]["ticket_prompt"][0]
    rows = session.exec(
        select(Notification).where(Notification.kind == "event_ticket_prompt")
    ).all()
    assert all(r.emailed_at is not None for r in rows)


def test_memories_prompt_digest_drops_row_once_memory_added(session, sent, digests):
    _digest_mode(session, "memories_prompt")
    mia = _user(session, "mia")
    ana = _user(session, "ana")
    _event(session, "last-night", NOW - timedelta(hours=30))
    for user in (mia, ana):
        _going(session, user, "last-night")
        session.add(
            Notification(
                recipient_user_id=user.id,
                actor_user_id=user.id,
                kind="event_memories_prompt",
                event_id="last-night",
            )
        )
    session.add(EventUserAsset(user_id=ana.id, event_id="last-night", kind="memory"))
    session.commit()

    assert activity_email.run_once(force=True)["digests"] == 1
    assert "/event/last-night/memories" in digests[0]["memories_prompt"][0]


def test_prompt_admin_push_switch(session, sent):
    session.add(SiteSetting(key="ticket_prompt_email_instant", value="true"))
    session.add(SiteSetting(key="ticket_prompt_push_enabled", value="false"))
    session.commit()
    mia = _user(session, "mia")
    _event(session, "intl", NOW + timedelta(days=6), reach="international")
    _going(session, mia, "intl")

    stats = event_asset_prompts.run_ticket_prompts()

    assert stats == {"prompts": 1, "emailed": 1, "pushed": 0}
    assert sent["push"] == []
    assert event_asset_prompts.run_ticket_prompts() == {"prompts": 0}


# --- memories prompt ---------------------------------------------------------


def test_memories_due_at_uses_user_timezone():
    user = User(email="x@example.com", timezone="America/New_York")
    end = datetime(2026, 10, 4, 3, 0, tzinfo=timezone.utc)  # Oct 3 23:00 in New York
    due = event_asset_prompts.memories_prompt_due_at(end, user, 11)
    assert due.astimezone(timezone.utc) == datetime(
        2026, 10, 4, 15, 0, tzinfo=timezone.utc
    )


def test_memories_prompt_next_day_without_memory(session, sent):
    session.add(SiteSetting(key="memories_prompt_local_hour", value="0"))
    mia = _user(session, "mia")
    ana = _user(session, "ana")
    _event(session, "last-night", NOW - timedelta(hours=30))
    _event(session, "tonight", NOW - timedelta(hours=4), hours=2)
    _going(session, mia, "last-night")
    _going(session, mia, "tonight")
    _going(session, ana, "last-night")
    session.add(EventUserAsset(user_id=ana.id, event_id="last-night", kind="memory"))
    session.commit()

    stats = event_asset_prompts.run_memories_prompts()

    assert stats["prompts"] == 1
    rows = session.exec(
        select(Notification).where(Notification.kind == "event_memories_prompt")
    ).all()
    assert [(r.recipient_user_id, r.event_id) for r in rows] == [(mia.id, "last-night")]
    assert sent["push"] and "/memories" in sent["push"][0]


def test_memories_prompt_waits_for_local_hour(session, sent):
    hour = (datetime.now(timezone.utc) + timedelta(hours=1)).hour
    if hour == 0:
        pytest.skip("next hour wraps to the following day")
    session.add(SiteSetting(key="memories_prompt_local_hour", value=str(hour)))
    mia = _user(session, "mia")
    _event(
        session,
        "yesterday",
        NOW.replace(hour=0, minute=30) - timedelta(hours=20),
        hours=2,
    )
    _going(session, mia, "yesterday")

    assert event_asset_prompts.run_memories_prompts() == {"prompts": 0}


# --- reminder ticket line ----------------------------------------------------


def test_reminder_carries_ticket_line_for_likely_events(session, monkeypatch):
    calls = {}
    monkeypatch.setattr(
        reminder_service,
        "send_event_reminder_email",
        lambda u, e, w, **k: (
            calls.__setitem__(e.event_id, k["include_ticket_cta"]) or True
        ),
    )
    monkeypatch.setattr(reminder_service, "send_push", lambda *a, **k: 0)
    mia = _user(session, "mia")
    soon = NOW + timedelta(hours=5)
    _event(session, "intl", soon, reach="international")
    _event(session, "local", soon, reach="local")
    _event(session, "has-ticket", soon, reach="international")
    for event_id in ("intl", "local", "has-ticket"):
        _going(session, mia, event_id)
    session.add(
        EventUserAsset(
            user_id=mia.id,
            event_id="has-ticket",
            kind="ticket_link",
            url="https://t.example",
        )
    )
    session.commit()

    reminder_service.run_once()

    assert calls == {"intl": True, "local": False, "has-ticket": False}


# --- API ---------------------------------------------------------------------


@pytest.fixture
def client(engine):
    current: dict = {}

    def _session_override():
        with Session(engine) as s:
            yield s

    def _user_override():
        with Session(engine) as s:
            return s.get(User, current["id"])

    app.dependency_overrides[get_session] = _session_override
    app.dependency_overrides[require_user] = _user_override
    try:
        yield TestClient(app), current
    finally:
        app.dependency_overrides.clear()


def test_ticket_not_needed_round_trip(session, client):
    http, current = client
    mia = _user(session, "mia")
    current["id"] = mia.id
    _event(session, "intl", NOW + timedelta(days=6), reach="international")
    _going(session, mia, "intl")

    r = http.put("/api/events/intl/ticket-not-needed")
    assert r.status_code == 200, r.text
    assert r.json()["ticket_not_needed"] is True
    assert r.json()["ticket_likely"] is True
    summary = http.post(
        "/api/me/event-assets/summary", json={"event_ids": ["intl"]}
    ).json()
    assert summary["intl"]["ticket_not_needed"] is True

    r = http.delete("/api/events/intl/ticket-not-needed")
    assert r.json()["ticket_not_needed"] is False


def test_ticket_not_needed_requires_going(session, client):
    http, current = client
    mia = _user(session, "mia")
    current["id"] = mia.id
    _event(session, "intl", NOW + timedelta(days=6), reach="international")

    assert http.put("/api/events/intl/ticket-not-needed").status_code == 403


def test_event_payload_exposes_ticket_likely(session, client):
    http, _ = client
    _event(session, "fest", NOW + timedelta(days=6), hours=48)

    body = http.get("/api/events/fest").json()

    assert body["ticket_likely"] is True
    assert body["ticket_likely_reason"] == "multi_day"
    assert body["advance_ticket_override"] is None


# --- Admin send-now ----------------------------------------------------------


@pytest.fixture
def admin(client):
    http, _ = client
    app.dependency_overrides[require_admin] = lambda: {"email": "admin@example.com"}
    return http


def _send_now(http, kind, event_id, users, **extra):
    return http.post(
        "/api/admin/notifications/asset-prompt/send-now",
        json={
            "kind": kind,
            "event_id": event_id,
            "user_ids": [str(u.id) for u in users],
            **extra,
        },
    )


def test_ticket_candidates_report_status_and_blockers(session, admin, sent):
    mia = _user(session, "mia", push_ticket_prompt_enabled=False)
    ana = _user(session, "ana")
    leo = _user(session, "leo")
    _user(session, "ned")
    _event(session, "local", NOW + timedelta(days=6), reach="local")
    _going(session, mia, "local")
    _going(session, ana, "local", ticket_not_needed_at=NOW)
    _going(session, leo, "local")
    session.add(
        EventUserAsset(
            user_id=leo.id, event_id="local", kind="ticket_link", url="https://t"
        )
    )
    session.add(PushSubscription(user_id=mia.id, endpoint="e", p256dh="p", auth="a"))
    session.add(
        Notification(
            recipient_user_id=mia.id,
            actor_user_id=mia.id,
            kind="event_ticket_prompt",
            event_id="local",
            emailed_at=NOW,
        )
    )
    session.commit()

    r = admin.get("/api/admin/events/local/asset-prompt-candidates?kind=ticket")

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ticket_likely"] is False
    assert body["ineligible_reason"] is None
    rows = {c["handle"]: c for c in body["candidates"]}
    assert set(rows) == {"mia", "ana", "leo"}
    assert rows["mia"]["blocker"] is None
    assert rows["mia"]["push_enabled"] is False
    assert rows["mia"]["has_push_subscription"] is True
    assert rows["mia"]["notification"]["emailed_at"] is not None
    assert rows["mia"]["notification"]["pushed_at"] is None
    assert rows["ana"]["blocker"] == "ticket_not_needed"
    assert rows["leo"]["blocker"] == "has_ticket"
    assert rows["leo"]["notification"] is None


def test_ticket_send_now_bypasses_toggle_and_likely_rule(session, admin, sent):
    session.add(SiteSetting(key="ticket_prompt_enabled", value="false"))
    mia = _user(session, "mia")
    ana = _user(session, "ana")
    ned = _user(session, "ned")
    off = _user(
        session,
        "off",
        email_ticket_prompt_enabled=False,
        push_ticket_prompt_enabled=False,
    )
    _event(session, "local", NOW + timedelta(hours=3), reach="local")
    for u in (mia, off):
        _going(session, u, "local")
    _going(session, ana, "local", ticket_not_needed_at=NOW)

    r = _send_now(
        admin, "ticket", "local", [mia, ana, ned, off], channels=["email", "push"]
    )

    assert r.status_code == 200, r.text
    data = r.json()
    status = {row["email"].split("@")[0]: row["status"] for row in data["results"]}
    assert status == {
        "mia": "sent",
        "ana": "skipped_not_needed",
        "ned": "skipped_not_attended",
        "off": "skipped_disabled",
    }
    assert (data["emailed"], data["pushed"], data["in_app_created"]) == (1, 1, 0)
    notif = session.exec(
        select(Notification).where(Notification.recipient_user_id == mia.id)
    ).one()
    # In-app unchecked: row exists for dedupe/tracking but is already read.
    assert notif.read_at is not None
    deliveries = session.exec(select(NotificationDelivery)).all()
    assert {(d.channel, d.source) for d in deliveries} == {
        ("email", "admin"),
        ("push", "admin"),
    }


def test_send_now_only_missing_channels_then_resend(session, admin, sent):
    mia = _user(session, "mia")
    _event(session, "intl", NOW + timedelta(days=6), reach="international")
    _going(session, mia, "intl")

    first = _send_now(admin, "ticket", "intl", [mia], channels=["app", "email"]).json()
    assert (
        first["in_app_created"] == 1 and first["emailed"] == 1 and first["pushed"] == 0
    )

    again = _send_now(admin, "ticket", "intl", [mia]).json()
    assert again["results"][0]["status"] == "sent"
    assert (again["emailed"], again["pushed"]) == (0, 1)

    idle = _send_now(admin, "ticket", "intl", [mia]).json()
    assert idle["results"][0]["status"] == "already_sent"

    notif = session.exec(select(Notification)).one()
    notif.read_at = NOW
    session.add(notif)
    session.commit()

    resent = _send_now(admin, "ticket", "intl", [mia], resend=True).json()
    assert resent["in_app_resurfaced"] == 1
    assert (resent["emailed"], resent["pushed"]) == (1, 1)
    session.refresh(notif)
    assert notif.read_at is None
    assert len(session.exec(select(Notification)).all()) == 1


def test_memories_send_now_eligibility(session, admin, sent):
    mia = _user(session, "mia")
    ana = _user(session, "ana")
    _event(session, "past", NOW - timedelta(days=2))
    _event(session, "soon", NOW + timedelta(days=2))
    _event(session, "old", NOW - timedelta(days=60))
    for event_id in ("past", "soon", "old"):
        _going(session, mia, event_id)
    _going(session, ana, "past")
    session.add(EventUserAsset(user_id=ana.id, event_id="past", kind="memory"))
    session.commit()

    assert _send_now(admin, "memories", "soon", [mia]).json()["detail"] == "not_ended"
    assert (
        _send_now(admin, "memories", "old", [mia]).json()["detail"] == "window_closed"
    )
    assert _send_now(admin, "ticket", "past", [mia]).json()["detail"] == "not_upcoming"

    data = _send_now(admin, "memories", "past", [mia, ana]).json()
    assert [r["status"] for r in data["results"]] == ["sent", "skipped_has_memory"]
    assert sent["email"] == [("memories", "past")]
    assert "/memories" in sent["push"][0]


def test_send_now_requires_feature(session, admin):
    session.get(SiteSetting, "event_tickets_enabled").value = "false"
    session.commit()
    mia = _user(session, "mia")
    _event(session, "intl", NOW + timedelta(days=6), reach="international")

    assert _send_now(admin, "ticket", "intl", [mia]).status_code == 409
    r = admin.get("/api/admin/events/intl/asset-prompt-candidates?kind=ticket")
    assert r.status_code == 409
    r = admin.get("/api/admin/events/intl/asset-prompt-candidates?kind=memories")
    assert r.status_code == 200


def test_toggle_counts_include_asset_prompts(session, admin):
    _user(session, "mia", push_memories_prompt_enabled=False)

    body = admin.get("/api/admin/notifications/toggle-counts").json()

    assert body["ticket_prompt"] == {"email": 1, "push": 1}
    assert body["memories_prompt"] == {"email": 1, "push": 0}
