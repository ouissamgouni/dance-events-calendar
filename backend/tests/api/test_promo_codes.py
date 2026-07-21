"""Happy-path API tests for user-submitted promo codes.

Mirrors the in-memory SQLite + DEV_AUTH approach used by
``test_ratings.py``. Covers:

- Flag gate (404 when ``promo_codes_enabled`` is off).
- Submit a code (creates pending row, sends admin email task).
- Public list only returns approved + viewer's own pending rows.
- Duplicate code on same event (case-insensitive) is rejected.
- Owner edit reverts an approved row back to pending.
- Owner delete only allowed on pending rows.
- Admin list/approve/reject and submitter notification.
"""

import os
from datetime import datetime
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

os.environ.setdefault("SESSION_SECRET", "test-secret-for-promo-codes")
os.environ.setdefault("ADMIN_EMAIL", "admin@example.com")
os.environ["DEV_AUTH"] = "true"

from backend.api.main import app  # noqa: E402
from backend.api.routes import auth as auth_module  # noqa: E402
from backend.api.routes import promo_codes as promo_codes_module  # noqa: E402
from backend.db.database import get_session  # noqa: E402
from backend.db.models import (  # noqa: E402
    CachedEvent,
    EventPromoCode,
    Notification,
    NotificationDelivery,
    SiteSetting,
    User,
    UserEventAttendance,
    UserSavedEvent,
)


# Background task spins up a new engine + emails the admin. In tests we
# stub it out — engine creation needs POSTGRES_PASSWORD or DATABASE_URL,
# neither of which the unit-test runner provides.
promo_codes_module._notify_admin_promo = lambda _id: None
# Same reasoning for the saved-event fan-out email/push background task —
# the in-app fan-out (``_fan_out_saved_event_promo_code``) runs
# synchronously in the request and is covered directly below.
promo_codes_module._send_promo_code_added_notifications = lambda *_a, **_kw: None


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


@pytest.fixture
def event(session):
    ev = CachedEvent(
        event_id="evt-promo-1",
        calendar_id="cal-1",
        title="Promo Event",
        description=None,
        location=None,
        latitude=None,
        longitude=None,
        start=datetime(2099, 1, 1, 20, 0, 0),
        end=datetime(2099, 1, 2, 1, 0, 0),
    )
    session.add(ev)
    session.commit()
    session.refresh(ev)
    return ev


@pytest.fixture
def flag_on(session):
    session.add(SiteSetting(key="promo_codes_enabled", value="true"))
    session.commit()


def _login(client: TestClient, *, email: str):
    return client.post(
        "/api/auth/google",
        json={"credential": "ignored", "mock_email": email},
    )


# ── Flag gate ─────────────────────────────────────────────────────────


@pytest.mark.unit
def test_list_returns_404_when_flag_off(client, event):
    resp = client.get(f"/api/events/{event.event_id}/promo-codes")
    assert resp.status_code == 404


@pytest.mark.unit
def test_submit_returns_404_when_flag_off(client, event):
    assert _login(client, email="user@example.com").status_code == 200
    resp = client.post(
        f"/api/events/{event.event_id}/promo-codes",
        json={"code": "TEST10"},
    )
    assert resp.status_code == 404


# ── Per-event override ───────────────────────────────────────────────


@pytest.mark.unit
def test_list_allowed_when_flag_off_but_event_override_true(client, session, event):
    event.show_promo_override = True
    session.add(event)
    session.commit()
    resp = client.get(f"/api/events/{event.event_id}/promo-codes")
    assert resp.status_code == 200


@pytest.mark.unit
def test_list_returns_404_when_flag_on_but_event_override_false(
    client, session, event, flag_on
):
    event.show_promo_override = False
    session.add(event)
    session.commit()
    resp = client.get(f"/api/events/{event.event_id}/promo-codes")
    assert resp.status_code == 404


@pytest.mark.unit
def test_submit_allowed_when_flag_off_but_event_override_true(client, session, event):
    event.show_promo_override = True
    session.add(event)
    session.commit()
    assert _login(client, email="user@example.com").status_code == 200
    resp = client.post(
        f"/api/events/{event.event_id}/promo-codes",
        json={"code": "OVERRIDE10"},
    )
    assert resp.status_code == 201, resp.text


# ── Submit + list ────────────────────────────────────────────────────


@pytest.mark.unit
def test_submit_creates_pending_row(client, session, event, flag_on):
    assert _login(client, email="user@example.com").status_code == 200
    resp = client.post(
        f"/api/events/{event.event_id}/promo-codes",
        json={"code": "EARLY10", "description": "10% off"},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["code"] == "EARLY10"
    assert body["status"] == "pending"
    row = session.exec(
        select(EventPromoCode).where(EventPromoCode.code == "EARLY10")
    ).first()
    assert row is not None
    assert row.event_id == event.event_id


@pytest.mark.unit
def test_public_list_hides_other_users_pending(client, session, event, flag_on):
    # User A submits a pending code (visible only to A + admins).
    assert _login(client, email="alice@example.com").status_code == 200
    client.post(
        f"/api/events/{event.event_id}/promo-codes",
        json={"code": "ALICEONLY"},
    )
    # Admin approves an unrelated existing code first to give the list
    # at least one approved row.
    assert _login(client, email="admin@example.com").status_code == 200
    resp = client.post(
        f"/api/events/{event.event_id}/promo-codes",
        json={"code": "GLOBAL"},
    )
    promo_id = resp.json()["id"]
    client.post(f"/api/admin/promo-codes/{promo_id}/approve")

    # Anonymous viewer (clear cookies) only sees GLOBAL.
    client.cookies.clear()
    resp = client.get(f"/api/events/{event.event_id}/promo-codes")
    assert resp.status_code == 200
    codes = {r["code"] for r in resp.json()}
    assert codes == {"GLOBAL"}

    # Alice still sees her own pending row + GLOBAL.
    assert _login(client, email="alice@example.com").status_code == 200
    resp = client.get(f"/api/events/{event.event_id}/promo-codes")
    codes = {r["code"] for r in resp.json()}
    assert codes == {"GLOBAL", "ALICEONLY"}


@pytest.mark.unit
def test_duplicate_code_case_insensitive_rejected(client, event, flag_on):
    assert _login(client, email="user@example.com").status_code == 200
    r1 = client.post(f"/api/events/{event.event_id}/promo-codes", json={"code": "DUPE"})
    assert r1.status_code == 201
    r2 = client.post(f"/api/events/{event.event_id}/promo-codes", json={"code": "dupe"})
    assert r2.status_code == 409


# ── Admin moderation ─────────────────────────────────────────────────


@pytest.mark.unit
def test_admin_approve_creates_submitter_notification(client, session, event, flag_on):
    assert _login(client, email="user@example.com").status_code == 200
    resp = client.post(
        f"/api/events/{event.event_id}/promo-codes", json={"code": "OK20"}
    )
    promo_id = resp.json()["id"]

    assert _login(client, email="admin@example.com").status_code == 200
    resp = client.post(f"/api/admin/promo-codes/{promo_id}/approve")
    assert resp.status_code == 200
    assert resp.json()["status"] == "approved"

    notifs = session.exec(
        select(Notification).where(Notification.kind == "promo_code_approved")
    ).all()
    assert len(notifs) == 1


@pytest.mark.unit
def test_admin_reject_persists_notes_and_notification(client, session, event, flag_on):
    assert _login(client, email="user@example.com").status_code == 200
    resp = client.post(
        f"/api/events/{event.event_id}/promo-codes", json={"code": "BADCODE"}
    )
    promo_id = resp.json()["id"]

    assert _login(client, email="admin@example.com").status_code == 200
    resp = client.post(
        f"/api/admin/promo-codes/{promo_id}/reject",
        json={"admin_notes": "Spam content."},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "rejected"
    assert body["admin_notes"] == "Spam content."

    notifs = session.exec(
        select(Notification).where(Notification.kind == "promo_code_rejected")
    ).all()
    assert len(notifs) == 1


# ── Owner edit + delete ──────────────────────────────────────────────


@pytest.mark.unit
def test_owner_edit_reverts_approved_back_to_pending(client, session, event, flag_on):
    assert _login(client, email="user@example.com").status_code == 200
    resp = client.post(
        f"/api/events/{event.event_id}/promo-codes", json={"code": "ORIG"}
    )
    promo_id = resp.json()["id"]
    assert _login(client, email="admin@example.com").status_code == 200
    client.post(f"/api/admin/promo-codes/{promo_id}/approve")

    assert _login(client, email="user@example.com").status_code == 200
    resp = client.patch(
        f"/api/events/{event.event_id}/promo-codes/{promo_id}",
        json={"description": "Edited copy"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "pending"


@pytest.mark.unit
def test_owner_delete_pending_only(client, event, flag_on):
    assert _login(client, email="user@example.com").status_code == 200
    resp = client.post(
        f"/api/events/{event.event_id}/promo-codes", json={"code": "GONE"}
    )
    promo_id = resp.json()["id"]
    resp = client.delete(f"/api/events/{event.event_id}/promo-codes/{promo_id}")
    assert resp.status_code in (200, 204)


# ── Admin listing ────────────────────────────────────────────────────


@pytest.mark.unit
def test_admin_list_filter_by_status(client, event, flag_on):
    assert _login(client, email="user@example.com").status_code == 200
    client.post(f"/api/events/{event.event_id}/promo-codes", json={"code": "AAA"})
    client.post(f"/api/events/{event.event_id}/promo-codes", json={"code": "BBB"})

    assert _login(client, email="admin@example.com").status_code == 200
    resp = client.get("/api/admin/promo-codes", params={"status": "pending"})
    assert resp.status_code == 200
    codes = {r["code"] for r in resp.json()}
    assert "AAA" in codes and "BBB" in codes


@pytest.mark.unit
def test_admin_list_filter_by_event_id(client, session, event, flag_on):
    other_event = CachedEvent(
        event_id="evt-promo-2",
        calendar_id="cal-1",
        title="Other Event",
        start=datetime(2099, 1, 3, 20, 0, 0),
        end=datetime(2099, 1, 3, 23, 0, 0),
    )
    session.add(other_event)
    session.commit()

    assert _login(client, email="user@example.com").status_code == 200
    client.post(f"/api/events/{event.event_id}/promo-codes", json={"code": "MINE"})
    client.post(
        f"/api/events/{other_event.event_id}/promo-codes", json={"code": "OTHER"}
    )

    assert _login(client, email="admin@example.com").status_code == 200
    resp = client.get("/api/admin/promo-codes", params={"event_id": event.event_id})
    assert resp.status_code == 200
    codes = {r["code"] for r in resp.json()}
    assert codes == {"MINE"}


# ── Saved-event fan-out notification (promo_code_added) ───────────────


def _user_id(session, email: str):
    return session.exec(select(User).where(User.email == email)).one().id


def _save_event(session, *, user_id, event_id, device_id):
    session.add(UserSavedEvent(device_id=device_id, event_id=event_id, user_id=user_id))
    session.commit()


def _mark_going(session, *, user_id, event_id, device_id):
    session.add(
        UserEventAttendance(device_id=device_id, event_id=event_id, user_id=user_id)
    )
    session.commit()


@pytest.mark.unit
def test_approve_notifies_saved_users_excluding_submitter(
    client, session, event, flag_on
):
    assert _login(client, email="submitter@example.com").status_code == 200
    resp = client.post(
        f"/api/events/{event.event_id}/promo-codes", json={"code": "SAVE10"}
    )
    promo_id = resp.json()["id"]

    assert _login(client, email="saver@example.com").status_code == 200
    saver_id = _user_id(session, "saver@example.com")
    submitter_id = _user_id(session, "submitter@example.com")
    _save_event(
        session, user_id=saver_id, event_id=event.event_id, device_id="dev-saver"
    )
    _save_event(
        session,
        user_id=submitter_id,
        event_id=event.event_id,
        device_id="dev-submitter",
    )

    assert _login(client, email="admin@example.com").status_code == 200
    resp = client.post(f"/api/admin/promo-codes/{promo_id}/approve")
    assert resp.status_code == 200

    added = session.exec(
        select(Notification).where(Notification.kind == "promo_code_added")
    ).all()
    recipients = {n.recipient_user_id for n in added}
    assert recipients == {saver_id}
    assert added[0].context == "SAVE10"

    deliveries = session.exec(
        select(NotificationDelivery).where(
            NotificationDelivery.notification_id == added[0].id
        )
    ).all()
    assert [d.channel for d in deliveries] == ["app"]


@pytest.mark.unit
def test_approve_excludes_users_already_going(client, session, event, flag_on):
    assert _login(client, email="submitter2@example.com").status_code == 200
    resp = client.post(
        f"/api/events/{event.event_id}/promo-codes", json={"code": "GOING10"}
    )
    promo_id = resp.json()["id"]

    assert _login(client, email="goer@example.com").status_code == 200
    goer_id = _user_id(session, "goer@example.com")
    _save_event(session, user_id=goer_id, event_id=event.event_id, device_id="dev-goer")
    _mark_going(session, user_id=goer_id, event_id=event.event_id, device_id="dev-goer")

    assert _login(client, email="admin@example.com").status_code == 200
    resp = client.post(f"/api/admin/promo-codes/{promo_id}/approve")
    assert resp.status_code == 200

    added = session.exec(
        select(Notification).where(Notification.kind == "promo_code_added")
    ).all()
    assert added == []


@pytest.mark.unit
def test_second_approved_code_does_not_renotify_same_saver(
    client, session, event, flag_on
):
    """v1 limitation: the dedupe constraint on Notification is keyed by
    (recipient, kind, actor=self, event) — a saved user already notified
    about one approved promo code for an event won't be notified again
    for a second one. This test locks in that accepted behaviour and
    guards against it raising an IntegrityError instead of silently
    skipping. Uses two different submitters so the pre-existing
    ``promo_code_approved`` submitter-notification dedupe (a separate,
    unrelated constraint) isn't what's under test here.
    """
    assert _login(client, email="submitter3a@example.com").status_code == 200
    first = client.post(
        f"/api/events/{event.event_id}/promo-codes", json={"code": "FIRST10"}
    ).json()

    assert _login(client, email="submitter3b@example.com").status_code == 200
    second = client.post(
        f"/api/events/{event.event_id}/promo-codes", json={"code": "SECOND10"}
    ).json()

    assert _login(client, email="repeat-saver@example.com").status_code == 200
    saver_id = _user_id(session, "repeat-saver@example.com")
    _save_event(
        session, user_id=saver_id, event_id=event.event_id, device_id="dev-repeat"
    )

    assert _login(client, email="admin@example.com").status_code == 200
    resp = client.post(f"/api/admin/promo-codes/{first['id']}/approve")
    assert resp.status_code == 200
    resp = client.post(f"/api/admin/promo-codes/{second['id']}/approve")
    assert resp.status_code == 200

    added = session.exec(
        select(Notification).where(Notification.kind == "promo_code_added")
    ).all()
    assert len(added) == 1
    assert added[0].recipient_user_id == saver_id
