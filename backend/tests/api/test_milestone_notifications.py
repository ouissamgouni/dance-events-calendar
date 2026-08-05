"""Tests for milestone-unlock notifications (Dance Passport Phase C).

Covers milestone_notification_service.run_once: in-app notification creation
keyed by subject_key, idempotency across runs, per-channel (email/push)
gating, distinct notifications per milestone, and the admin global kill
switch.
"""

import os
from datetime import datetime, timedelta

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

os.environ.setdefault("SESSION_SECRET", "test-secret-milestone")
os.environ.setdefault("ADMIN_EMAIL", "admin@example.com")

from backend.db import database as database_module  # noqa: E402
from backend.db.models import (  # noqa: E402
    CachedEvent,
    CalendarSetting,
    Notification,
    NotificationDelivery,
    SiteSetting,
    User,
    UserEventAttendance,
)
from backend.services import milestone_notification_service  # noqa: E402


@pytest.fixture
def engine():
    eng = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(eng)
    prev = database_module._engine
    database_module._engine = eng
    yield eng
    database_module._engine = prev
    SQLModel.metadata.drop_all(eng)


@pytest.fixture
def session(engine):
    with Session(engine) as s:
        yield s


@pytest.fixture(autouse=True)
def _no_send(monkeypatch):
    """Stub email/push so run_once never touches the network by default."""
    monkeypatch.setattr(
        milestone_notification_service,
        "send_milestone_unlocked_email",
        lambda *a, **k: True,
    )
    monkeypatch.setattr(milestone_notification_service, "send_push", lambda *a, **k: 0)


def _make_user(session: Session, email: str, handle: str, **kwargs) -> User:
    u = User(
        email=email,
        display_name=handle.title(),
        handle=handle,
        provider="google",
        provider_subject=f"mock|{email}",
        **kwargs,
    )
    session.add(u)
    session.commit()
    session.refresh(u)
    return u


def _attend_past_event(
    session: Session, user: User, event_id: str, days_ago: int
) -> None:
    if session.get(CalendarSetting, "cal") is None:
        session.add(
            CalendarSetting(calendar_id="cal", name="C", color="#abc", enabled=True)
        )
        session.commit()
    start = datetime.utcnow() - timedelta(days=days_ago)
    session.add(
        CachedEvent(
            event_id=event_id,
            calendar_id="cal",
            title=f"Salsa {event_id}",
            start=start,
            end=start + timedelta(hours=2),
            all_day=False,
        )
    )
    session.add(
        UserEventAttendance(
            device_id=str(user.id).replace("-", "")[:20] + event_id[:8],
            user_id=user.id,
            event_id=event_id,
            attending_since=datetime.utcnow(),
        )
    )
    session.commit()


def test_notification_created_and_idempotent(session):
    alice = _make_user(session, "alice@example.com", "alice")
    _attend_past_event(session, alice, "ev-1", days_ago=10)

    stats = milestone_notification_service.run_once()
    assert stats["milestones"] == 1

    notifs = session.exec(
        select(Notification).where(Notification.kind == "milestone_unlocked")
    ).all()
    assert len(notifs) == 1
    assert notifs[0].subject_key == "first_event"
    assert notifs[0].recipient_user_id == alice.id
    assert notifs[0].actor_user_id == alice.id
    assert notifs[0].event_id is None

    app_deliveries = session.exec(
        select(NotificationDelivery).where(NotificationDelivery.channel == "app")
    ).all()
    assert len(app_deliveries) == 1

    # Re-running does not duplicate the notification.
    assert milestone_notification_service.run_once() == {
        "milestones": 0,
        "emailed": 0,
        "pushed": 0,
    }
    notifs = session.exec(
        select(Notification).where(Notification.kind == "milestone_unlocked")
    ).all()
    assert len(notifs) == 1


def test_distinct_milestones_get_distinct_notifications(session):
    bob = _make_user(session, "bob@example.com", "bob")
    for i in range(10):
        _attend_past_event(session, bob, f"ev-{i}", days_ago=100 - i)

    stats = milestone_notification_service.run_once()
    # first_event + events_10 both unlock on the same run.
    assert stats["milestones"] == 2
    keys = {
        n.subject_key
        for n in session.exec(
            select(Notification).where(Notification.kind == "milestone_unlocked")
        ).all()
    }
    assert {"first_event", "events_10"} <= keys


def test_email_gated_off_still_creates_in_app(session, monkeypatch):
    emailed: list = []
    pushed: list = []
    monkeypatch.setattr(
        milestone_notification_service,
        "send_milestone_unlocked_email",
        lambda u, m: emailed.append(m.key) or True,
    )
    monkeypatch.setattr(
        milestone_notification_service,
        "send_push",
        lambda *a, **k: pushed.append(k.get("tag")) or 1,
    )
    carol = _make_user(
        session,
        "carol@example.com",
        "carol",
        email_milestone_unlocked_enabled=False,
    )
    _attend_past_event(session, carol, "ev-1", days_ago=5)

    stats = milestone_notification_service.run_once()
    assert stats["milestones"] == 1
    assert emailed == []  # email gated off
    assert stats["pushed"] == 1  # push still fired
    # In-app notification always created.
    assert (
        session.exec(
            select(Notification).where(Notification.kind == "milestone_unlocked")
        ).first()
        is not None
    )


def test_email_backfilled_after_toggle_flip(session, monkeypatch):
    """An in-app notice created while email was off must still email once the
    user opts in later — without re-creating the in-app row."""
    emailed: list = []
    monkeypatch.setattr(
        milestone_notification_service,
        "send_milestone_unlocked_email",
        lambda u, m: emailed.append(m.key) or True,
    )
    monkeypatch.setattr(milestone_notification_service, "send_push", lambda *a, **k: 0)
    erin = _make_user(
        session,
        "erin@example.com",
        "erin",
        email_milestone_unlocked_enabled=False,
    )
    _attend_past_event(session, erin, "ev-1", days_ago=7)

    # First pass: in-app created, email gated off.
    milestone_notification_service.run_once()
    assert emailed == []
    notif = session.exec(
        select(Notification).where(Notification.kind == "milestone_unlocked")
    ).one()
    assert notif.emailed_at is None

    # User opts into milestone emails, then a later pass runs.
    erin.email_milestone_unlocked_enabled = True
    session.add(erin)
    session.commit()

    stats = milestone_notification_service.run_once()
    assert stats["milestones"] == 0  # no new in-app row
    assert emailed == ["first_event"]  # email backfilled
    notifs = session.exec(
        select(Notification).where(Notification.kind == "milestone_unlocked")
    ).all()
    assert len(notifs) == 1  # in-app row not duplicated
    session.refresh(notifs[0])
    assert notifs[0].emailed_at is not None


def test_global_kill_switch_skips(session):
    session.add(SiteSetting(key="milestone_notifications_enabled", value="false"))
    session.commit()
    dave = _make_user(session, "dave@example.com", "dave")
    _attend_past_event(session, dave, "ev-1", days_ago=3)

    assert milestone_notification_service.run_once() == {
        "skipped": "milestone_notifications_disabled"
    }
    assert (
        session.exec(
            select(Notification).where(Notification.kind == "milestone_unlocked")
        ).first()
        is None
    )
