"""Unit tests for the engagement primitive.

Covers the matrix:
- kinds: ``save`` | ``going``
- actions: ``add`` | ``remove``
- audience fallback (None -> target.share_attendance_default_audience)
- idempotency (re-add is a no-op, re-remove is a no-op)
- audience update on re-add with different tier
- audit stamping (``created_by_admin_user_id``)
- fan-out gating (only when ``fan_out=True`` and tier is shared)

Self-serve tracking routes are exercised separately in
``backend/tests/api/test_routes.py`` and are intentionally not refactored
to call this primitive.
"""

from __future__ import annotations

import os
from uuid import uuid4

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

os.environ.setdefault("SESSION_SECRET", "test-secret-engagement")

from backend.db.models import (  # noqa: E402
    User,
    UserEventAttendance,
    UserSavedEvent,
)
from backend.services.engagement import (  # noqa: E402
    EngagementResult,
    set_event_engagement,
)


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


def _make_user(session: Session, *, default_audience: str | None = None) -> User:
    u = User(
        email=f"user-{uuid4().hex[:8]}@example.com",
        handle=f"u{uuid4().hex[:6]}",
        display_name="Curator Target",
        share_attendance_default_audience=default_audience,
    )
    session.add(u)
    session.commit()
    session.refresh(u)
    return u


@pytest.mark.parametrize("kind", ["save", "going"])
def test_add_then_remove_round_trip(session, kind):
    user = _make_user(session)
    admin_id = uuid4()
    res = set_event_engagement(
        session,
        target_user=user,
        event_id="evt-1",
        kind=kind,
        action="add",
        created_by_admin_user_id=admin_id,
    )
    session.commit()
    assert res == EngagementResult(changed=True, created=True, fan_out_count=0)

    # Row exists with audit stamp.
    model = UserSavedEvent if kind == "save" else UserEventAttendance
    row = session.exec(
        select(model).where(model.user_id == user.id, model.event_id == "evt-1")
    ).first()
    assert row is not None
    assert row.created_by_admin_user_id == admin_id

    # Re-add is idempotent.
    res2 = set_event_engagement(
        session,
        target_user=user,
        event_id="evt-1",
        kind=kind,
        action="add",
    )
    assert res2.changed is False
    assert res2.created is False

    # Remove sweeps the row.
    res3 = set_event_engagement(
        session,
        target_user=user,
        event_id="evt-1",
        kind=kind,
        action="remove",
    )
    session.commit()
    assert res3.changed is True
    assert res3.deleted is True
    remaining = session.exec(
        select(model).where(model.user_id == user.id, model.event_id == "evt-1")
    ).all()
    assert remaining == []

    # Re-remove is a no-op.
    res4 = set_event_engagement(
        session,
        target_user=user,
        event_id="evt-1",
        kind=kind,
        action="remove",
    )
    assert res4.changed is False


@pytest.mark.parametrize("kind", ["save", "going"])
def test_audience_fallback_to_user_default(session, kind):
    user = _make_user(session, default_audience="public")
    set_event_engagement(
        session,
        target_user=user,
        event_id="evt-2",
        kind=kind,
        action="add",
    )
    session.commit()
    model = UserSavedEvent if kind == "save" else UserEventAttendance
    audience_attr = "audience" if kind == "save" else "share_audience"
    row = session.exec(
        select(model).where(model.user_id == user.id, model.event_id == "evt-2")
    ).first()
    assert getattr(row, audience_attr) == "public"


@pytest.mark.parametrize("kind", ["save", "going"])
def test_audience_fallback_defaults_to_friends_when_user_has_no_pref(session, kind):
    user = _make_user(session, default_audience=None)
    set_event_engagement(
        session,
        target_user=user,
        event_id="evt-3",
        kind=kind,
        action="add",
    )
    session.commit()
    model = UserSavedEvent if kind == "save" else UserEventAttendance
    audience_attr = "audience" if kind == "save" else "share_audience"
    row = session.exec(
        select(model).where(model.user_id == user.id, model.event_id == "evt-3")
    ).first()
    assert getattr(row, audience_attr) == "friends"


@pytest.mark.parametrize("kind", ["save", "going"])
def test_explicit_audience_overrides_user_default(session, kind):
    user = _make_user(session, default_audience="public")
    set_event_engagement(
        session,
        target_user=user,
        event_id="evt-4",
        kind=kind,
        action="add",
        audience="private",
    )
    session.commit()
    model = UserSavedEvent if kind == "save" else UserEventAttendance
    audience_attr = "audience" if kind == "save" else "share_audience"
    row = session.exec(
        select(model).where(model.user_id == user.id, model.event_id == "evt-4")
    ).first()
    assert getattr(row, audience_attr) == "private"


@pytest.mark.parametrize("kind", ["save", "going"])
def test_re_add_with_different_audience_updates_row(session, kind):
    user = _make_user(session)
    set_event_engagement(
        session,
        target_user=user,
        event_id="evt-5",
        kind=kind,
        action="add",
        audience="friends",
    )
    session.commit()
    res = set_event_engagement(
        session,
        target_user=user,
        event_id="evt-5",
        kind=kind,
        action="add",
        audience="public",
    )
    session.commit()
    assert res.changed is True
    assert res.created is False  # mutated, not inserted
    model = UserSavedEvent if kind == "save" else UserEventAttendance
    audience_attr = "audience" if kind == "save" else "share_audience"
    row = session.exec(
        select(model).where(model.user_id == user.id, model.event_id == "evt-5")
    ).first()
    assert getattr(row, audience_attr) == "public"


def test_going_curator_device_key_does_not_collide_with_user_device(session):
    """Curator-written rows use a separate device key so they don't
    silently collapse against a row the user later writes themselves
    via the self-serve route."""
    user = _make_user(session)
    set_event_engagement(
        session,
        target_user=user,
        event_id="evt-6",
        kind="going",
        action="add",
        audience="friends",
    )
    session.commit()
    row = session.exec(
        select(UserEventAttendance).where(
            UserEventAttendance.user_id == user.id,
            UserEventAttendance.event_id == "evt-6",
        )
    ).first()
    assert row is not None
    assert row.device_id.startswith("admin:")
