"""Tests for ``backend.services.interest_notification_service``.

Covers:
  - haversine distance + area/radius geo matching
  - group-aware tag matching (dance required, reach optional -> match-any
    when empty, reach-filtered otherwise)
  - events missing lat/lng are excluded
  - idempotency: re-running does not duplicate notifications
  - opt-out gating: per-profile ``matches_enabled`` (user-level email/push
    flags do NOT gate row creation post-Phase G)
  - the global ``INTEREST_MATCH_NOTIFICATIONS_ENABLED`` kill switch
  - created notifications are left un-emailed (``emailed_at=None``) so the
    activity digest can pick them up, and their ``context`` renders via
    ``activity_email._render_line``
"""

import os
from datetime import datetime, timedelta

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

os.environ.setdefault("SESSION_SECRET", "test-secret-interest-notify")
os.environ.setdefault("ADMIN_EMAIL", "admin@example.com")

from backend.db import database as database_module  # noqa: E402
from backend.db.models import (  # noqa: E402
    CachedEvent,
    CalendarSetting,
    EventTag,
    Notification,
    SiteSetting,
    Tag,
    TagGroup,
    User,
    UserInterestProfile,
    UserInterestProfileTag,
)
from backend.services import activity_email  # noqa: E402
from backend.services import interest_notification_service as svc  # noqa: E402


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


# --- Helpers ----------------------------------------------------------------


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


def _make_tag_group(session: Session, slug: str) -> TagGroup:
    g = session.exec(select(TagGroup).where(TagGroup.slug == slug)).first()
    if g:
        return g
    g = TagGroup(slug=slug, label=slug.title())
    session.add(g)
    session.commit()
    session.refresh(g)
    return g


def _make_tag(session: Session, group: TagGroup, slug: str) -> Tag:
    t = Tag(group_id=group.id, slug=slug, label=slug.title())
    session.add(t)
    session.commit()
    session.refresh(t)
    return t


def _make_event(
    session: Session,
    event_id: str,
    *,
    lat: float | None = 40.0,
    lng: float | None = -3.0,
    start: datetime | None = None,
    updated_at: datetime | None = None,
    is_hidden: bool = False,
    deleted_at: datetime | None = None,
) -> CachedEvent:
    if session.get(CalendarSetting, "cal") is None:
        session.add(
            CalendarSetting(calendar_id="cal", name="C", color="#abc", enabled=True)
        )
        session.commit()
    e = CachedEvent(
        event_id=event_id,
        calendar_id="cal",
        title=f"Event {event_id}",
        start=start or (datetime.utcnow() + timedelta(hours=6)),
        end=(start or (datetime.utcnow() + timedelta(hours=6))) + timedelta(hours=2),
        all_day=False,
        latitude=lat,
        longitude=lng,
        is_hidden=is_hidden,
        deleted_at=deleted_at,
    )
    if updated_at is not None:
        e.updated_at = updated_at
    session.add(e)
    session.commit()
    session.refresh(e)
    return e


def _tag_event(session: Session, event_id: str, tag: Tag) -> None:
    session.add(EventTag(event_id=event_id, tag_id=tag.id))
    session.commit()


def _make_profile(
    session: Session,
    user: User,
    *,
    label: str = "Home",
    min_lat: float = 39.9,
    min_lng: float = -3.1,
    max_lat: float = 40.1,
    max_lng: float = -2.9,
    matches_enabled: bool = True,
    dance_tags: list[Tag] = (),
    reach_tags: list[Tag] = (),
) -> UserInterestProfile:
    p = UserInterestProfile(
        user_id=user.id,
        label=label,
        min_lat=min_lat,
        min_lng=min_lng,
        max_lat=max_lat,
        max_lng=max_lng,
        matches_enabled=matches_enabled,
    )
    session.add(p)
    session.commit()
    session.refresh(p)
    for t in list(dance_tags) + list(reach_tags):
        session.add(UserInterestProfileTag(profile_id=p.id, tag_id=t.id))
    session.commit()
    return p


# --- geo matching -----------------------------------------------------------


def test_geo_match_bbox_inside_and_outside(session):
    alice = _make_user(session, "a@example.com", "alice")
    area = _make_profile(
        session,
        alice,
        min_lat=0.0,
        min_lng=0.0,
        max_lat=1.0,
        max_lng=1.0,
    )
    assert svc._geo_match(area, 0.5, 0.5) is True
    assert svc._geo_match(area, 1.5, 0.5) is False


# --- run_once matching + idempotency ----------------------------------------


def test_run_once_creates_notification_on_dance_tag_and_geo_match(session):
    dance_group = _make_tag_group(session, "dance")
    salsa = _make_tag(session, dance_group, "salsa")

    alice = _make_user(session, "alice@example.com", "alice")
    _make_profile(session, alice, dance_tags=[salsa])

    event = _make_event(session, "ev-1", lat=40.05, lng=-3.02)
    _tag_event(session, event.event_id, salsa)

    stats = svc.run_once()
    assert stats["created"] == 1

    notifs = session.exec(
        select(Notification).where(Notification.kind == svc.INTEREST_EVENT)
    ).all()
    assert len(notifs) == 1
    n = notifs[0]
    assert n.recipient_user_id == alice.id
    assert n.actor_user_id == alice.id  # self-actor
    assert n.event_id == "ev-1"
    assert n.context == "Home"
    assert n.emailed_at is None  # left for activity_email digest


def test_run_once_no_match_without_dance_tag_overlap(session):
    dance_group = _make_tag_group(session, "dance")
    salsa = _make_tag(session, dance_group, "salsa")
    bachata = _make_tag(session, dance_group, "bachata")

    alice = _make_user(session, "alice@example.com", "alice")
    _make_profile(session, alice, dance_tags=[salsa])

    event = _make_event(session, "ev-1")
    _tag_event(session, event.event_id, bachata)  # no overlap

    stats = svc.run_once()
    assert stats["created"] == 0


def test_run_once_reach_filter_excludes_non_matching_reach(session):
    dance_group = _make_tag_group(session, "dance")
    reach_group = _make_tag_group(session, "reach")
    salsa = _make_tag(session, dance_group, "salsa")
    local = _make_tag(session, reach_group, "local")
    regional = _make_tag(session, reach_group, "regional")

    alice = _make_user(session, "alice@example.com", "alice")
    _make_profile(session, alice, dance_tags=[salsa], reach_tags=[local])

    event = _make_event(session, "ev-1")
    _tag_event(session, event.event_id, salsa)
    _tag_event(session, event.event_id, regional)  # reach doesn't overlap

    stats = svc.run_once()
    assert stats["created"] == 0


def test_run_once_empty_reach_selection_matches_any_reach(session):
    dance_group = _make_tag_group(session, "dance")
    reach_group = _make_tag_group(session, "reach")
    salsa = _make_tag(session, dance_group, "salsa")
    regional = _make_tag(session, reach_group, "regional")

    alice = _make_user(session, "alice@example.com", "alice")
    # No reach tags selected -> match any reach (including events with no
    # reach tag at all).
    _make_profile(session, alice, dance_tags=[salsa], reach_tags=[])

    event = _make_event(session, "ev-1")
    _tag_event(session, event.event_id, salsa)
    _tag_event(session, event.event_id, regional)

    stats = svc.run_once()
    assert stats["created"] == 1


def test_run_once_excludes_events_without_coordinates(session):
    dance_group = _make_tag_group(session, "dance")
    salsa = _make_tag(session, dance_group, "salsa")

    alice = _make_user(session, "alice@example.com", "alice")
    _make_profile(session, alice, dance_tags=[salsa])

    event = _make_event(session, "ev-1", lat=None, lng=None)
    _tag_event(session, event.event_id, salsa)

    stats = svc.run_once()
    assert stats["created"] == 0


def test_run_once_is_idempotent_across_ticks(session):
    dance_group = _make_tag_group(session, "dance")
    salsa = _make_tag(session, dance_group, "salsa")

    alice = _make_user(session, "alice@example.com", "alice")
    _make_profile(session, alice, dance_tags=[salsa])

    event = _make_event(session, "ev-1")
    _tag_event(session, event.event_id, salsa)

    first = svc.run_once()
    assert first["created"] == 1
    # Even though the scan window advances, the existing Notification
    # unique-constraint dedup prevents a second row for the same event.
    second = svc.run_once()
    assert second["created"] == 0

    notifs = session.exec(
        select(Notification).where(Notification.kind == svc.INTEREST_EVENT)
    ).all()
    assert len(notifs) == 1


def test_run_once_ignores_user_channel_flags(session):
    """Phase G: user-level email/push flags no longer gate in-app row creation.

    A user with every channel flag off must still receive an ``interest_event``
    Notification when their profile matches — the gating now happens strictly
    at delivery time inside activity_email / push_service.
    """
    dance_group = _make_tag_group(session, "dance")
    salsa = _make_tag(session, dance_group, "salsa")

    alice = _make_user(
        session,
        "alice@example.com",
        "alice",
        email_interest_matches_enabled=False,
        push_interest_matches_enabled=False,
    )
    _make_profile(session, alice, dance_tags=[salsa])

    event = _make_event(session, "ev-1")
    _tag_event(session, event.event_id, salsa)

    stats = svc.run_once()
    assert stats["created"] == 1

    notifs = session.exec(
        select(Notification).where(Notification.kind == svc.INTEREST_EVENT)
    ).all()
    assert len(notifs) == 1


def test_run_once_respects_profile_matches_disabled(session):
    dance_group = _make_tag_group(session, "dance")
    salsa = _make_tag(session, dance_group, "salsa")

    alice = _make_user(session, "alice@example.com", "alice")
    _make_profile(session, alice, dance_tags=[salsa], matches_enabled=False)

    event = _make_event(session, "ev-1")
    _tag_event(session, event.event_id, salsa)

    stats = svc.run_once()
    assert stats["created"] == 0


def test_run_once_respects_global_kill_switch(session, monkeypatch):
    monkeypatch.setattr(svc, "get_interest_match_notifications_enabled", lambda: False)

    dance_group = _make_tag_group(session, "dance")
    salsa = _make_tag(session, dance_group, "salsa")

    alice = _make_user(session, "alice@example.com", "alice")
    _make_profile(session, alice, dance_tags=[salsa])

    event = _make_event(session, "ev-1")
    _tag_event(session, event.event_id, salsa)

    stats = svc.run_once()
    assert stats == {"skipped": "interest_notifications_disabled"}
    notifs = session.exec(
        select(Notification).where(Notification.kind == svc.INTEREST_EVENT)
    ).all()
    assert notifs == []


def test_run_once_ignores_events_outside_scan_window(session):
    dance_group = _make_tag_group(session, "dance")
    salsa = _make_tag(session, dance_group, "salsa")

    alice = _make_user(session, "alice@example.com", "alice")
    _make_profile(session, alice, dance_tags=[salsa])

    # Seed the last-scan marker so this event's updated_at (long ago) falls
    # outside the (since, now] window.
    old = datetime.utcnow() - timedelta(days=10)
    event = _make_event(session, "ev-old", updated_at=old)
    _tag_event(session, event.event_id, salsa)
    session.add(
        SiteSetting(
            key=svc._LAST_SCAN_KEY,
            value=(datetime.utcnow() - timedelta(days=1)).isoformat(),
        )
    )
    session.commit()

    stats = svc.run_once()
    assert stats["created"] == 0


def test_context_is_comma_joined_across_matching_profiles(session):
    dance_group = _make_tag_group(session, "dance")
    salsa = _make_tag(session, dance_group, "salsa")

    alice = _make_user(session, "alice@example.com", "alice")
    _make_profile(session, alice, label="Home", dance_tags=[salsa])
    _make_profile(
        session,
        alice,
        label="Trip",
        min_lat=39.9,
        min_lng=-3.1,
        max_lat=40.1,
        max_lng=-2.9,
        dance_tags=[salsa],
    )

    event = _make_event(session, "ev-1", lat=40.02, lng=-3.01)
    _tag_event(session, event.event_id, salsa)

    stats = svc.run_once()
    assert stats["created"] == 1
    n = session.exec(
        select(Notification).where(Notification.kind == svc.INTEREST_EVENT)
    ).first()
    assert n.context == "Home, Trip"


def test_activity_email_renders_interest_event_context():
    line = activity_email._render_line("interest_event", None, None, "Home, Trip")
    assert "Home, Trip" in line
    assert "matched your" in line

    plain = activity_email._render_plain("interest_event", None, None, "Home")
    assert "matched your Home alert" in plain


def test_dedup_across_profiles_with_different_dance_tags(session):
    """Two profiles matching same event via DIFFERENT dance tags must
    still collapse to one notification (unique index on
    recipient_user_id/kind/actor/event_id) and list both profile labels
    in ``context``."""
    dance_group = _make_tag_group(session, "dance")
    salsa = _make_tag(session, dance_group, "salsa")
    bachata = _make_tag(session, dance_group, "bachata")

    alice = _make_user(session, "alice@example.com", "alice")
    _make_profile(session, alice, label="Salsa nights", dance_tags=[salsa])
    _make_profile(
        session,
        alice,
        label="Bachata nights",
        min_lat=39.9,
        min_lng=-3.1,
        max_lat=40.1,
        max_lng=-2.9,
        dance_tags=[bachata],
    )

    event = _make_event(session, "ev-1", lat=40.02, lng=-3.01)
    _tag_event(session, event.event_id, salsa)
    _tag_event(session, event.event_id, bachata)

    stats = svc.run_once()
    assert stats["created"] == 1
    notifs = session.exec(
        select(Notification).where(Notification.kind == svc.INTEREST_EVENT)
    ).all()
    assert len(notifs) == 1
    assert "Salsa nights" in notifs[0].context
    assert "Bachata nights" in notifs[0].context


def test_run_once_excludes_deleted_users(session):
    """GDPR: soft-deleted users must not receive interest notifications."""
    dance_group = _make_tag_group(session, "dance")
    salsa = _make_tag(session, dance_group, "salsa")

    alice = _make_user(
        session,
        "alice@example.com",
        "alice",
        deleted_at=datetime.utcnow(),
    )
    _make_profile(session, alice, dance_tags=[salsa])

    event = _make_event(session, "ev-1")
    _tag_event(session, event.event_id, salsa)

    stats = svc.run_once()
    assert stats["created"] == 0
    notifs = session.exec(
        select(Notification).where(Notification.kind == svc.INTEREST_EVENT)
    ).all()
    assert notifs == []
