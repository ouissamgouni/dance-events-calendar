"""Tests for per-calendar curation rules.

Covers:
- auth gate (require_admin)
- CRUD: list / create / patch / delete
- create against a non-admin-managed target is rejected (409)
- create is upsert-friendly on (calendar, target, kind)
- post-sync hook applies enabled rules and is idempotent
- post-sync hook skips disabled rules and stale targets
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

os.environ.setdefault("SESSION_SECRET", "test-secret-curation-rules")
os.environ.setdefault("ADMIN_EMAIL", "admin@example.com")
os.environ["DEV_AUTH"] = "true"

from backend.api.main import app  # noqa: E402
from backend.api.routes import auth as auth_module  # noqa: E402
from backend.api.routes import social as social_module  # noqa: E402
from backend.db.database import get_session  # noqa: E402
from backend.db.models import (  # noqa: E402
    CachedEvent,
    CalendarCurationRule,
    CalendarSetting,
    User,
    UserEventAttendance,
    UserSavedEvent,
)
from backend.services.curation_hook import apply_curation_rules  # noqa: E402


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
    social_module.limiter.reset()
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


def _seed(session: Session) -> dict:
    """Create admin, curator (managed), civilian, calendar + 2 events."""
    admin = User(
        email="admin@example.com",
        handle="admin",
        display_name="Admin",
        provider="google",
        provider_subject="mock|admin@example.com",
    )
    curator = User(
        email="curator@example.com",
        handle="curator-paris",
        display_name="Curator Paris",
        provider="google",
        provider_subject="mock|curator@example.com",
        is_admin_managed=True,
    )
    civilian = User(
        email="civ@example.com",
        handle="civilian",
        display_name="Civilian",
        provider="google",
        provider_subject="mock|civ@example.com",
        is_admin_managed=False,
    )
    session.add_all([admin, curator, civilian])
    session.commit()

    cal = CalendarSetting(calendar_id="cal-1", name="Paris Salsa", enabled=True)
    session.add(cal)
    session.commit()

    start = datetime.now(timezone.utc) + timedelta(days=3)
    e1 = CachedEvent(
        event_id="evt-aaa",
        title="Salsa Night",
        start=start,
        end=start + timedelta(hours=4),
        calendar_id="cal-1",
    )
    e2 = CachedEvent(
        event_id="evt-bbb",
        title="Bachata Social",
        start=start + timedelta(days=1),
        end=start + timedelta(days=1, hours=4),
        calendar_id="cal-1",
    )
    session.add_all([e1, e2])
    session.commit()
    return {"curator": curator, "civilian": civilian}


# --- CRUD route tests --------------------------------------------------------


@pytest.mark.unit
def test_rules_require_admin(client, session):
    _seed(session)
    _login(client, "curator@example.com")
    r = client.get("/api/admin/calendars/cal-1/curation-rules")
    assert r.status_code == 403


@pytest.mark.unit
def test_create_rule_happy_path(client, session):
    _seed(session)
    _login(client, "admin@example.com")
    r = client.post(
        "/api/admin/calendars/cal-1/curation-rules",
        json={
            "target_handle": "curator-paris",
            "kind": "save",
            "audience": "public",
            "enabled": True,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["calendar_id"] == "cal-1"
    assert body["kind"] == "save"
    assert body["audience"] == "public"
    assert body["enabled"] is True
    assert body["target_handle"] == "curator-paris"


@pytest.mark.unit
def test_create_rule_for_unmanaged_target_rejected(client, session):
    _seed(session)
    _login(client, "admin@example.com")
    r = client.post(
        "/api/admin/calendars/cal-1/curation-rules",
        json={"target_handle": "civilian", "kind": "save"},
    )
    assert r.status_code == 409
    assert r.json()["detail"] == "target_not_admin_managed"


@pytest.mark.unit
def test_create_rule_is_upsert_on_duplicate(client, session):
    _seed(session)
    _login(client, "admin@example.com")
    r1 = client.post(
        "/api/admin/calendars/cal-1/curation-rules",
        json={"target_handle": "curator-paris", "kind": "save", "audience": "public"},
    )
    rid = r1.json()["id"]
    r2 = client.post(
        "/api/admin/calendars/cal-1/curation-rules",
        json={
            "target_handle": "curator-paris",
            "kind": "save",
            "audience": "friends",
            "enabled": False,
        },
    )
    assert r2.json()["id"] == rid
    assert r2.json()["audience"] == "friends"
    assert r2.json()["enabled"] is False
    rows = session.exec(select(CalendarCurationRule)).all()
    assert len(rows) == 1


@pytest.mark.unit
def test_list_patch_delete_rule(client, session):
    _seed(session)
    _login(client, "admin@example.com")
    rid = client.post(
        "/api/admin/calendars/cal-1/curation-rules",
        json={"target_handle": "curator-paris", "kind": "going"},
    ).json()["id"]

    listed = client.get("/api/admin/calendars/cal-1/curation-rules").json()
    assert len(listed) == 1 and listed[0]["id"] == rid

    patched = client.patch(
        f"/api/admin/calendars/cal-1/curation-rules/{rid}",
        json={"enabled": False, "audience": "private"},
    ).json()
    assert patched["enabled"] is False
    assert patched["audience"] == "private"

    d = client.delete(f"/api/admin/calendars/cal-1/curation-rules/{rid}")
    assert d.status_code == 204
    assert client.get("/api/admin/calendars/cal-1/curation-rules").json() == []


@pytest.mark.unit
def test_patch_unknown_rule_404(client, session):
    _seed(session)
    _login(client, "admin@example.com")
    r = client.patch(
        "/api/admin/calendars/cal-1/curation-rules/9999",
        json={"enabled": False},
    )
    assert r.status_code == 404


# --- Post-sync hook tests ----------------------------------------------------


@pytest.mark.unit
def test_hook_applies_enabled_rule_and_audit_stamps(session):
    seeded = _seed(session)
    curator = seeded["curator"]
    admin = session.exec(select(User).where(User.email == "admin@example.com")).first()
    rule = CalendarCurationRule(
        calendar_id="cal-1",
        target_user_id=curator.id,
        kind="save",
        audience="public",
        enabled=True,
    )
    session.add(rule)
    session.commit()

    res = apply_curation_rules(session, ["evt-aaa", "evt-bbb"], admin_user_id=admin.id)
    session.commit()
    assert res.rules_evaluated == 1
    assert res.rows_changed == 2

    rows = session.exec(select(UserSavedEvent)).all()
    assert len(rows) == 2
    assert all(r.created_by_admin_user_id == admin.id for r in rows)
    assert all(r.audience == "public" for r in rows)


@pytest.mark.unit
def test_hook_idempotent_second_run_noop(session):
    seeded = _seed(session)
    curator = seeded["curator"]
    session.add(
        CalendarCurationRule(
            calendar_id="cal-1",
            target_user_id=curator.id,
            kind="going",
            enabled=True,
        )
    )
    session.commit()
    r1 = apply_curation_rules(session, ["evt-aaa"])
    session.commit()
    assert r1.rows_changed == 1
    r2 = apply_curation_rules(session, ["evt-aaa"])
    session.commit()
    assert r2.rows_changed == 0
    assert len(session.exec(select(UserEventAttendance)).all()) == 1


@pytest.mark.unit
def test_hook_skips_disabled_rules(session):
    seeded = _seed(session)
    curator = seeded["curator"]
    session.add(
        CalendarCurationRule(
            calendar_id="cal-1",
            target_user_id=curator.id,
            kind="save",
            enabled=False,
        )
    )
    session.commit()
    res = apply_curation_rules(session, ["evt-aaa"])
    session.commit()
    assert res.rules_evaluated == 0
    assert res.rows_changed == 0


@pytest.mark.unit
def test_hook_skips_target_that_lost_managed_flag(session):
    seeded = _seed(session)
    curator = seeded["curator"]
    session.add(
        CalendarCurationRule(
            calendar_id="cal-1",
            target_user_id=curator.id,
            kind="save",
            enabled=True,
        )
    )
    session.commit()
    # Admin un-flagged the curator after creating the rule.
    curator.is_admin_managed = False
    session.add(curator)
    session.commit()

    res = apply_curation_rules(session, ["evt-aaa"])
    session.commit()
    assert res.rules_skipped_target_invalid == 1
    assert res.rows_changed == 0
    assert session.exec(select(UserSavedEvent)).all() == []


@pytest.mark.unit
def test_hook_only_touches_events_for_rule_calendar(session):
    seeded = _seed(session)
    curator = seeded["curator"]
    # Add a second calendar + event; rule is for cal-1 only.
    cal2 = CalendarSetting(calendar_id="cal-2", name="Other", enabled=True)
    session.add(cal2)
    start = datetime.now(timezone.utc) + timedelta(days=5)
    other_event = CachedEvent(
        event_id="evt-ccc",
        title="Other",
        start=start,
        end=start + timedelta(hours=2),
        calendar_id="cal-2",
    )
    session.add(other_event)
    session.add(
        CalendarCurationRule(
            calendar_id="cal-1",
            target_user_id=curator.id,
            kind="save",
            enabled=True,
        )
    )
    session.commit()

    res = apply_curation_rules(session, ["evt-aaa", "evt-ccc"])
    session.commit()
    assert res.rows_changed == 1
    saved = session.exec(select(UserSavedEvent)).all()
    assert {s.event_id for s in saved} == {"evt-aaa"}
