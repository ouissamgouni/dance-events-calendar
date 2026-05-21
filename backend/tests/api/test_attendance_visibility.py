"""Tests for the privacy contract of the "Who's going" feature.

These five tests pin the security/privacy invariants:
1. Counts split correctly into public / private / anonymous.
2. /attendees requires authentication only (no reciprocity).
3. Private and anonymous rows never leak into /attendees.
4. Logged-out summary hides the public/private breakdown.
5. POST /track/event-attendance honours share_publicly.
"""

import os
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

os.environ.setdefault("SESSION_SECRET", "test-secret-attendance-visibility")
os.environ.setdefault("ADMIN_EMAIL", "admin@example.com")
os.environ["DEV_AUTH"] = "true"

from backend.api.main import app  # noqa: E402
from backend.api.routes import auth as auth_module  # noqa: E402
from backend.api.routes import tracking as tracking_module  # noqa: E402
from backend.db.database import get_session  # noqa: E402
from backend.db.models import User, UserEventAttendance, UserSavedEvent  # noqa: E402


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
    tracking_module.limiter.reset()
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def _login(client: TestClient, email: str, *, device_id: str | None = None):
    body: dict = {"credential": "ignored", "mock_email": email}
    if device_id is not None:
        body["device_id"] = device_id
    r = client.post("/api/auth/google", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def _make_user(session: Session, email: str, name: str) -> User:
    u = User(
        email=email,
        display_name=name,
        provider="google",
        provider_subject=f"mock|{email}",
    )
    session.add(u)
    session.commit()
    session.refresh(u)
    return u


def _seed(
    session: Session,
    *,
    event_id: str,
    user: User | None,
    device_id: str,
    share_publicly: bool,
):
    session.add(
        UserEventAttendance(
            event_id=event_id,
            device_id=device_id,
            user_id=user.id if user else None,
            share_publicly=share_publicly,
            share_audience="public" if share_publicly else "private",
        )
    )
    session.commit()


@pytest.mark.unit
def test_summary_counts_public_private_anonymous(client, session):
    """Authenticated viewer sees the full public/private/anonymous breakdown."""
    alice = _make_user(session, "alice@example.com", "Alice")
    bob = _make_user(session, "bob@example.com", "Bob")
    _make_user(session, "viewer@example.com", "Viewer")

    event_id = "evt-1"
    _seed(session, event_id=event_id, user=alice, device_id="d-a", share_publicly=True)
    _seed(session, event_id=event_id, user=bob, device_id="d-b", share_publicly=False)
    _seed(
        session, event_id=event_id, user=None, device_id="d-anon", share_publicly=False
    )

    _login(client, "viewer@example.com")
    r = client.get(f"/api/events/{event_id}/attendance-summary")
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["total_going"] == 3
    assert data["public_going"] == 1
    assert data["anonymous_going"] == 2
    assert data["can_view_attendees"] is True


@pytest.mark.unit
def test_attendees_requires_only_authentication(client, session):
    """Unauthenticated -> 401. Authenticated viewer (whether or not they are
    going) -> 200 with the public list."""
    alice = _make_user(session, "alice@example.com", "Alice")
    _make_user(session, "viewer@example.com", "Viewer")
    event_id = "evt-1"
    _seed(session, event_id=event_id, user=alice, device_id="d-a", share_publicly=True)

    # Unauthenticated -> 401.
    r_anon = client.get(f"/api/events/{event_id}/attendees")
    assert r_anon.status_code == 401

    # Authenticated viewer who is NOT going -> 200.
    _login(client, "viewer@example.com")
    r = client.get(f"/api/events/{event_id}/attendees")
    assert r.status_code == 200
    body = r.json()
    assert len(body) == 1
    assert body[0]["display_name"] == "Alice"


@pytest.mark.unit
def test_attendees_excludes_private_and_anonymous(client, session):
    """Only rows with share_publicly=True AND user_id IS NOT NULL appear."""
    alice = _make_user(session, "alice@example.com", "Alice")
    bob = _make_user(session, "bob@example.com", "Bob")
    carol = _make_user(session, "carol@example.com", "Carol")
    _make_user(session, "viewer@example.com", "Viewer")

    event_id = "evt-1"
    _seed(session, event_id=event_id, user=alice, device_id="d-a", share_publicly=True)
    _seed(session, event_id=event_id, user=bob, device_id="d-b", share_publicly=False)
    _seed(session, event_id=event_id, user=carol, device_id="d-c", share_publicly=True)
    _seed(
        session, event_id=event_id, user=None, device_id="d-anon", share_publicly=False
    )

    _login(client, "viewer@example.com")
    r = client.get(f"/api/events/{event_id}/attendees")
    assert r.status_code == 200
    names = sorted(a["display_name"] for a in r.json())
    assert names == ["Alice", "Carol"]


@pytest.mark.unit
def test_logged_out_summary_hides_breakdown(client, session):
    """Anon /attendance-summary returns total only; /attendees -> 401."""
    alice = _make_user(session, "alice@example.com", "Alice")
    event_id = "evt-1"
    _seed(session, event_id=event_id, user=alice, device_id="d-a", share_publicly=True)
    _seed(
        session, event_id=event_id, user=None, device_id="d-anon", share_publicly=False
    )

    r = client.get(f"/api/events/{event_id}/attendance-summary")
    assert r.status_code == 200
    data = r.json()
    assert data["total_going"] == 2
    assert data["can_view_attendees"] is False
    # Breakdown is not telegraphed to anonymous viewers.
    assert data["public_going"] == 0
    assert data["anonymous_going"] == 0
    assert data["preview_attendees"] == []

    r2 = client.get(f"/api/events/{event_id}/attendees")
    assert r2.status_code == 401


@pytest.mark.unit
def test_track_event_attendance_persists_share_publicly(client, session):
    """share_publicly is set on insert, updated on subsequent calls, and
    ignored for logged-out callers (their rows always have user_id=NULL)."""
    _make_user(session, "alice@example.com", "Alice")
    event_id = "evt-1"

    _login(client, "alice@example.com", device_id="d-alice")
    r = client.post(
        "/api/track/event-attendance",
        json={
            "event_id": event_id,
            "device_id": "d-alice",
            "action": "going",
            "share_publicly": True,
        },
    )
    assert r.status_code == 201
    row = session.exec(
        select(UserEventAttendance).where(UserEventAttendance.device_id == "d-alice")
    ).first()
    assert row is not None
    assert row.user_id is not None
    assert row.share_publicly is True

    # Toggle to private without re-marking.
    r2 = client.post(
        "/api/track/event-attendance",
        json={
            "event_id": event_id,
            "device_id": "d-alice",
            "action": "going",
            "share_publicly": False,
        },
    )
    assert r2.status_code == 201
    session.expire_all()
    row2 = session.exec(
        select(UserEventAttendance).where(UserEventAttendance.device_id == "d-alice")
    ).first()
    assert row2.share_publicly is False

    # Logged-out caller: share_publicly is ignored, user_id stays NULL.
    client.post("/api/auth/logout")
    r3 = client.post(
        "/api/track/event-attendance",
        json={
            "event_id": event_id,
            "device_id": "d-anon",
            "action": "going",
            "share_publicly": True,
        },
    )
    assert r3.status_code == 201
    anon = session.exec(
        select(UserEventAttendance).where(UserEventAttendance.device_id == "d-anon")
    ).first()
    assert anon.user_id is None
    assert anon.share_publicly is False


@pytest.mark.unit
def test_track_event_attendance_updates_admin_curated_row(client, session):
    admin = _make_user(session, "admin@example.com", "Admin")
    alice = _make_user(session, "alice@example.com", "Alice")
    event_id = "evt-curated-going"
    session.add(
        UserEventAttendance(
            event_id=event_id,
            device_id=f"admin:{alice.id}",
            user_id=alice.id,
            share_publicly=True,
            share_audience="public",
            created_by_admin_user_id=admin.id,
        )
    )
    session.commit()

    _login(client, "alice@example.com", device_id="d-alice")
    r = client.post(
        "/api/track/event-attendance",
        json={
            "event_id": event_id,
            "device_id": "d-alice",
            "action": "going",
            "share_audience": "private",
        },
    )
    assert r.status_code == 201, r.text

    rows = session.exec(
        select(UserEventAttendance).where(UserEventAttendance.event_id == event_id)
    ).all()
    assert len(rows) == 1
    assert rows[0].device_id == f"admin:{alice.id}"
    assert rows[0].created_by_admin_user_id == admin.id
    assert rows[0].share_audience == "private"
    assert rows[0].share_publicly is False

    summary = client.get(f"/api/events/{event_id}/attendance-summary")
    assert summary.status_code == 200, summary.text
    assert summary.json()["total_going"] == 1


def _save(session: Session, *, event_id: str, device_id: str, user: User | None = None):
    session.add(
        UserSavedEvent(
            event_id=event_id,
            device_id=device_id,
            user_id=user.id if user else None,
        )
    )
    session.commit()


@pytest.mark.unit
def test_attendance_summary_includes_total_saved_anonymous(client, session):
    """Anonymous viewer sees total_saved alongside total_going."""
    alice = _make_user(session, "alice@example.com", "Alice")
    event_id = "evt-saved-1"
    _seed(session, event_id=event_id, user=alice, device_id="d-a", share_publicly=True)
    _save(session, event_id=event_id, device_id="d-anon-1")
    _save(session, event_id=event_id, device_id="d-anon-2", user=alice)

    r = client.get(f"/api/events/{event_id}/attendance-summary")
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["total_going"] == 1
    assert data["total_saved"] == 2
    assert data["can_view_attendees"] is False


@pytest.mark.unit
def test_attendance_summary_includes_total_saved_authenticated(client, session):
    """Authenticated viewer sees total_saved alongside the going breakdown."""
    alice = _make_user(session, "alice@example.com", "Alice")
    _make_user(session, "viewer@example.com", "Viewer")

    event_id = "evt-saved-2"
    _seed(session, event_id=event_id, user=alice, device_id="d-a", share_publicly=True)
    _save(session, event_id=event_id, device_id="d-s1")
    _save(session, event_id=event_id, device_id="d-s2")
    _save(session, event_id=event_id, device_id="d-s3")

    _login(client, "viewer@example.com")
    r = client.get(f"/api/events/{event_id}/attendance-summary")
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["total_going"] == 1
    assert data["public_going"] == 1
    assert data["total_saved"] == 3


@pytest.mark.unit
def test_attendance_summary_total_saved_zero_when_no_saves(client, session):
    """total_saved defaults to 0 when there are no UserSavedEvent rows."""
    event_id = "evt-saved-empty"
    r = client.get(f"/api/events/{event_id}/attendance-summary")
    assert r.status_code == 200
    data = r.json()
    assert data["total_going"] == 0
    assert data["total_saved"] == 0


@pytest.mark.unit
def test_attendance_summary_batch_includes_total_saved(client, session):
    """Batch endpoint returns total_saved per event in one round-trip,
    independently of total_going."""
    alice = _make_user(session, "alice@example.com", "Alice")

    event_a = "evt-batch-saved-a"
    event_b = "evt-batch-saved-b"  # has saves but no goings
    event_c = "evt-batch-saved-c"  # has neither

    _seed(session, event_id=event_a, user=alice, device_id="d-a", share_publicly=True)
    _save(session, event_id=event_a, device_id="d-sa1")
    _save(session, event_id=event_b, device_id="d-sb1")
    _save(session, event_id=event_b, device_id="d-sb2")

    r = client.post(
        "/api/events/attendance-summary",
        json={"event_ids": [event_a, event_b, event_c]},
    )
    assert r.status_code == 200, r.text
    by_id = {row["event_id"]: row for row in r.json()}
    assert by_id[event_a]["total_going"] == 1
    assert by_id[event_a]["total_saved"] == 1
    assert by_id[event_b]["total_going"] == 0
    assert by_id[event_b]["total_saved"] == 2
    assert by_id[event_c]["total_going"] == 0
    assert by_id[event_c]["total_saved"] == 0
