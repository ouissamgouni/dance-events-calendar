"""Happy-path API tests for user-submitted organizer claims.

Mirrors the in-memory SQLite + DEV_AUTH approach used by
``test_promo_codes.py`` / ``test_ratings.py``. Covers:

- Flag gate (404 on user endpoints when ``organizer_claims_enabled`` off).
- Admin endpoints are NOT behind the flag.
- Submission gates on bio + at least one social link.
- Pending dedup blocks a second in-flight claim.
- Admin decision: sets organizer_user_id, flips verified badge,
  inserts a Notification, computes a roll-up status (partial/approved).
- Approve/reject overlap rejected (422).
- Overwrite guard refuses to take over events already owned by a
  different organizer unless ``overwrite=true``.
"""

import os
from datetime import datetime
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

os.environ.setdefault("SESSION_SECRET", "test-secret-for-organizer-claims")
os.environ.setdefault("ADMIN_EMAIL", "admin@example.com")
os.environ["DEV_AUTH"] = "true"

from backend.api.main import app  # noqa: E402
from backend.api.routes import auth as auth_module  # noqa: E402
from backend.api.routes import organizer_claims as organizer_claims_module  # noqa: E402
from backend.db.database import get_session  # noqa: E402
from backend.db.models import (  # noqa: E402
    CachedEvent,
    Notification,
    OrganizerClaim,
    OrganizerClaimEvent,
    SiteSetting,
    User,
    UserEventAttendance,
)


# Background task spins up a new engine + emails the admin. In tests we
# stub it out — engine creation needs POSTGRES_PASSWORD or DATABASE_URL,
# neither of which the unit-test runner provides.
organizer_claims_module._notify_admin_claim = lambda _id: None


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
def events(session):
    rows = []
    for i in range(1, 4):
        ev = CachedEvent(
            event_id=f"evt-org-{i}",
            calendar_id="cal-1",
            title=f"Organizer Event {i}",
            description=None,
            location=None,
            latitude=None,
            longitude=None,
            start=datetime(2099, 1, i, 20, 0, 0),
            end=datetime(2099, 1, i, 23, 0, 0),
        )
        session.add(ev)
        rows.append(ev)
    session.commit()
    for r in rows:
        session.refresh(r)
    return rows


@pytest.fixture
def flag_on(session):
    session.add(SiteSetting(key="organizer_claims_enabled", value="true"))
    session.commit()


def _login(client: TestClient, *, email: str):
    return client.post(
        "/api/auth/google",
        json={"credential": "ignored", "mock_email": email},
    )


def _set_profile(
    session: Session,
    email: str,
    *,
    bio: str | None = "I run salsa nights",
    instagram_url: str | None = "https://instagram.com/me",
    facebook_url: str | None = None,
    verified: bool = False,
):
    """Update the freshly created user row with bio + socials."""
    u = session.exec(select(User).where(User.email == email)).first()
    assert u is not None, f"user {email} not found"
    u.bio = bio
    u.instagram_url = instagram_url
    u.facebook_url = facebook_url
    if verified:
        u.is_verified_organizer = True
    session.add(u)
    session.commit()
    session.refresh(u)
    return u


# ── Flag gate ─────────────────────────────────────────────────────────


@pytest.mark.unit
def test_user_list_returns_404_when_flag_off(client):
    assert _login(client, email="user@example.com").status_code == 200
    resp = client.get("/api/me/organizer-claims")
    assert resp.status_code == 404


@pytest.mark.unit
def test_admin_list_not_gated_by_flag(client):
    """Admin endpoints stay reachable even with the flag off."""
    assert _login(client, email="admin@example.com").status_code == 200
    resp = client.get("/api/admin/organizer-claims")
    assert resp.status_code == 200
    assert resp.json() == []


# ── Submission gates ──────────────────────────────────────────────────


@pytest.mark.unit
def test_submit_requires_bio(client, session, events, flag_on):
    assert _login(client, email="nobio@example.com").status_code == 200
    _set_profile(
        session,
        "nobio@example.com",
        bio=None,
        instagram_url="https://instagram.com/me",
    )
    resp = client.post(
        "/api/me/organizer-claims",
        json={"kind": "badge"},
    )
    assert resp.status_code == 422
    assert "bio" in resp.json()["detail"].lower()


@pytest.mark.unit
def test_submit_requires_social_link(client, session, events, flag_on):
    assert _login(client, email="nosocial@example.com").status_code == 200
    _set_profile(
        session,
        "nosocial@example.com",
        bio="I run salsa nights",
        instagram_url=None,
        facebook_url=None,
    )
    resp = client.post(
        "/api/me/organizer-claims",
        json={"kind": "badge"},
    )
    assert resp.status_code == 422
    assert "social" in resp.json()["detail"].lower()


@pytest.mark.unit
def test_submit_creates_pending_claim(client, session, events, flag_on):
    assert _login(client, email="org@example.com").status_code == 200
    _set_profile(session, "org@example.com", verified=True)
    resp = client.post(
        "/api/me/organizer-claims",
        json={
            "kind": "events",
            "event_ids": [events[0].event_id, events[1].event_id],
        },
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["status"] == "pending"
    assert body["kind"] == "events"
    assert len(body["events"]) == 2
    assert {e["decision"] for e in body["events"]} == {"pending"}


@pytest.mark.unit
def test_pending_dedup_blocks_second_claim(client, session, events, flag_on):
    assert _login(client, email="org@example.com").status_code == 200
    _set_profile(session, "org@example.com", verified=True)
    first = client.post(
        "/api/me/organizer-claims",
        json={"kind": "events", "event_ids": [events[0].event_id]},
    )
    assert first.status_code == 201
    second = client.post(
        "/api/me/organizer-claims",
        json={"kind": "events", "event_ids": [events[1].event_id]},
    )
    assert second.status_code == 409


@pytest.mark.unit
def test_submit_rejects_unknown_event(client, session, flag_on):
    assert _login(client, email="org@example.com").status_code == 200
    _set_profile(session, "org@example.com", verified=True)
    resp = client.post(
        "/api/me/organizer-claims",
        json={"kind": "events", "event_ids": ["evt-does-not-exist"]},
    )
    assert resp.status_code == 404


@pytest.mark.unit
def test_submit_badge_when_already_verified_returns_409(
    client, session, events, flag_on
):
    assert _login(client, email="org@example.com").status_code == 200
    _set_profile(session, "org@example.com", verified=True)
    resp = client.post(
        "/api/me/organizer-claims",
        json={"kind": "badge"},
    )
    assert resp.status_code == 409
    assert "verified" in resp.json()["detail"].lower()


@pytest.mark.unit
def test_submit_events_when_not_verified_returns_409(client, session, events, flag_on):
    assert _login(client, email="org@example.com").status_code == 200
    _set_profile(session, "org@example.com")  # verified=False
    resp = client.post(
        "/api/me/organizer-claims",
        json={"kind": "events", "event_ids": [events[0].event_id]},
    )
    assert resp.status_code == 409
    assert "verified" in resp.json()["detail"].lower()


@pytest.mark.unit
def test_submit_badge_rejects_event_ids(client, session, events, flag_on):
    assert _login(client, email="org@example.com").status_code == 200
    _set_profile(session, "org@example.com")  # not verified, can submit badge
    resp = client.post(
        "/api/me/organizer-claims",
        json={"kind": "badge", "event_ids": [events[0].event_id]},
    )
    assert resp.status_code == 422


@pytest.mark.unit
def test_submit_badge_happy_path(client, session, flag_on):
    assert _login(client, email="org@example.com").status_code == 200
    _set_profile(session, "org@example.com")
    resp = client.post(
        "/api/me/organizer-claims",
        json={"kind": "badge"},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["kind"] == "badge"
    assert body["status"] == "pending"
    assert body["events"] == []


# ── Admin decisions ───────────────────────────────────────────────────


def _submit_two_event_claim(client, session, events) -> str:
    assert _login(client, email="org@example.com").status_code == 200
    _set_profile(session, "org@example.com", verified=True)
    resp = client.post(
        "/api/me/organizer-claims",
        json={
            "kind": "events",
            "event_ids": [events[0].event_id, events[1].event_id],
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


@pytest.mark.unit
def test_admin_full_approve_sets_organizer_and_badge(client, session, events, flag_on):
    claim_id = _submit_two_event_claim(client, session, events)

    assert _login(client, email="admin@example.com").status_code == 200
    resp = client.post(
        f"/api/admin/organizer-claims/{claim_id}/decide",
        json={
            "grant_badge": True,
            "approved_event_ids": [events[0].event_id, events[1].event_id],
            "rejected_event_ids": [],
            "admin_notes": "Verified IG presence.",
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "approved"
    assert body["admin_notes"] == "Verified IG presence."

    user = session.exec(select(User).where(User.email == "org@example.com")).first()
    session.refresh(user)
    assert user.is_verified_organizer is True

    for ev in events[:2]:
        session.refresh(ev)
        assert ev.organizer_user_id == user.id

    notif = session.exec(
        select(Notification).where(Notification.recipient_user_id == user.id)
    ).first()
    assert notif is not None
    assert notif.kind == "organizer_claim_decided"


@pytest.mark.unit
def test_admin_mixed_decision_is_approved(client, session, events, flag_on):
    claim_id = _submit_two_event_claim(client, session, events)
    assert _login(client, email="admin@example.com").status_code == 200
    resp = client.post(
        f"/api/admin/organizer-claims/{claim_id}/decide",
        json={
            "grant_badge": False,
            "approved_event_ids": [events[0].event_id],
            "rejected_event_ids": [events[1].event_id],
        },
    )
    assert resp.status_code == 200, resp.text
    # Anything granted (at least one event) rolls up to "approved".
    assert resp.json()["status"] == "approved"


@pytest.mark.unit
def test_admin_decision_must_cover_every_event(client, session, events, flag_on):
    """Admin can't leave any line item pending."""
    claim_id = _submit_two_event_claim(client, session, events)
    assert _login(client, email="admin@example.com").status_code == 200
    resp = client.post(
        f"/api/admin/organizer-claims/{claim_id}/decide",
        json={
            "grant_badge": True,
            "approved_event_ids": [events[0].event_id],  # events[1] left pending
            "rejected_event_ids": [],
        },
    )
    assert resp.status_code == 422


@pytest.mark.unit
def test_admin_reject_all_is_rejected(client, session, events, flag_on):
    claim_id = _submit_two_event_claim(client, session, events)
    assert _login(client, email="admin@example.com").status_code == 200
    resp = client.post(
        f"/api/admin/organizer-claims/{claim_id}/decide",
        json={
            "grant_badge": False,
            "approved_event_ids": [],
            "rejected_event_ids": [events[0].event_id, events[1].event_id],
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "rejected"


@pytest.mark.unit
def test_admin_decision_rejects_overlap(client, session, events, flag_on):
    claim_id = _submit_two_event_claim(client, session, events)
    assert _login(client, email="admin@example.com").status_code == 200
    resp = client.post(
        f"/api/admin/organizer-claims/{claim_id}/decide",
        json={
            "grant_badge": True,
            "approved_event_ids": [events[0].event_id],
            "rejected_event_ids": [events[0].event_id],
        },
    )
    assert resp.status_code == 422


@pytest.mark.unit
def test_admin_decision_rejects_events_outside_claim(client, session, events, flag_on):
    claim_id = _submit_two_event_claim(client, session, events)
    assert _login(client, email="admin@example.com").status_code == 200
    resp = client.post(
        f"/api/admin/organizer-claims/{claim_id}/decide",
        json={
            "grant_badge": True,
            "approved_event_ids": [events[2].event_id],  # not in claim
            "rejected_event_ids": [],
        },
    )
    assert resp.status_code == 422


@pytest.mark.unit
def test_overwrite_guard_blocks_takeover(client, session, events, flag_on):
    # Pre-assign events[0] to a different organizer.
    other_id = uuid4()
    events[0].organizer_user_id = other_id
    session.add(events[0])
    session.commit()

    claim_id = _submit_two_event_claim(client, session, events)
    assert _login(client, email="admin@example.com").status_code == 200
    resp = client.post(
        f"/api/admin/organizer-claims/{claim_id}/decide",
        json={
            "grant_badge": True,
            "approved_event_ids": [events[0].event_id],
            "rejected_event_ids": [],
        },
    )
    assert resp.status_code == 409


@pytest.mark.unit
def test_overwrite_true_allows_takeover(client, session, events, flag_on):
    other_id = uuid4()
    events[0].organizer_user_id = other_id
    session.add(events[0])
    session.commit()

    claim_id = _submit_two_event_claim(client, session, events)
    assert _login(client, email="admin@example.com").status_code == 200
    resp = client.post(
        f"/api/admin/organizer-claims/{claim_id}/decide",
        json={
            "grant_badge": True,
            "approved_event_ids": [events[0].event_id],
            "rejected_event_ids": [events[1].event_id],
            "overwrite": True,
        },
    )
    assert resp.status_code == 200
    session.refresh(events[0])
    user = session.exec(select(User).where(User.email == "org@example.com")).first()
    assert events[0].organizer_user_id == user.id


@pytest.mark.unit
def test_cancel_my_pending_claim(client, session, events, flag_on):
    claim_id = _submit_two_event_claim(client, session, events)
    resp = client.delete(f"/api/me/organizer-claims/{claim_id}")
    assert resp.status_code == 204
    remaining = session.exec(select(OrganizerClaim)).all()
    assert remaining == []
    # NOTE: line items cascade-delete via FK in Postgres; SQLite ignores
    # ON DELETE CASCADE unless ``PRAGMA foreign_keys=ON`` is set on the
    # connection, so we don't assert on OrganizerClaimEvent here.


@pytest.mark.unit
def test_admin_redecide_does_not_violate_uq_notif_no_event(
    client, session, events, flag_on
):
    """Re-deciding the same claim must not raise IntegrityError on the
    ``uq_notif_no_event`` partial unique index. The route deletes any
    prior organizer_claim_decided notification before inserting the new
    one, so the latest decision is what the user sees.
    """
    claim_id = _submit_two_event_claim(client, session, events)
    assert _login(client, email="admin@example.com").status_code == 200
    body = {
        "grant_badge": True,
        "approved_event_ids": [events[0].event_id, events[1].event_id],
        "rejected_event_ids": [],
    }
    r1 = client.post(f"/api/admin/organizer-claims/{claim_id}/decide", json=body)
    assert r1.status_code == 200, r1.text
    r2 = client.post(f"/api/admin/organizer-claims/{claim_id}/decide", json=body)
    assert r2.status_code == 200, r2.text
    user = session.exec(select(User).where(User.email == "org@example.com")).first()
    notifs = session.exec(
        select(Notification).where(
            Notification.recipient_user_id == user.id,
            Notification.kind == "organizer_claim_decided",
        )
    ).all()
    assert len(notifs) == 1


# ── Auto-going on events-claim approval ───────────────────────────────


@pytest.mark.unit
def test_decide_events_marks_organizer_going_public(client, session, events, flag_on):
    """Approving an events claim should add a public Going attendance
    for the organizer on each approved event."""
    claim_id = _submit_two_event_claim(client, session, events)
    assert _login(client, email="admin@example.com").status_code == 200
    resp = client.post(
        f"/api/admin/organizer-claims/{claim_id}/decide",
        json={
            "grant_badge": False,  # ignored for events claims
            "approved_event_ids": [events[0].event_id, events[1].event_id],
            "rejected_event_ids": [],
        },
    )
    assert resp.status_code == 200, resp.text

    user = session.exec(select(User).where(User.email == "org@example.com")).first()
    rows = session.exec(
        select(UserEventAttendance).where(UserEventAttendance.user_id == user.id)
    ).all()
    assert len(rows) == 2
    for r in rows:
        assert r.event_id in {events[0].event_id, events[1].event_id}
        assert r.share_audience == "public"
        assert r.share_publicly is True


@pytest.mark.unit
def test_decide_events_rejected_event_not_marked_going(
    client, session, events, flag_on
):
    claim_id = _submit_two_event_claim(client, session, events)
    assert _login(client, email="admin@example.com").status_code == 200
    resp = client.post(
        f"/api/admin/organizer-claims/{claim_id}/decide",
        json={
            "grant_badge": False,
            "approved_event_ids": [events[0].event_id],
            "rejected_event_ids": [events[1].event_id],
        },
    )
    assert resp.status_code == 200, resp.text

    user = session.exec(select(User).where(User.email == "org@example.com")).first()
    rows = session.exec(
        select(UserEventAttendance).where(UserEventAttendance.user_id == user.id)
    ).all()
    assert len(rows) == 1
    assert rows[0].event_id == events[0].event_id


@pytest.mark.unit
def test_decide_badge_does_not_create_attendance(client, session, flag_on):
    """Badge claims have no events and must not create any attendance rows."""
    assert _login(client, email="org@example.com").status_code == 200
    _set_profile(session, "org@example.com")
    submit = client.post(
        "/api/me/organizer-claims",
        json={"kind": "badge"},
    )
    assert submit.status_code == 201
    claim_id = submit.json()["id"]

    assert _login(client, email="admin@example.com").status_code == 200
    resp = client.post(
        f"/api/admin/organizer-claims/{claim_id}/decide",
        json={
            "grant_badge": True,
            "approved_event_ids": [],
            "rejected_event_ids": [],
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "approved"

    user = session.exec(select(User).where(User.email == "org@example.com")).first()
    session.refresh(user)
    assert user.is_verified_organizer is True
    rows = session.exec(
        select(UserEventAttendance).where(UserEventAttendance.user_id == user.id)
    ).all()
    assert rows == []
