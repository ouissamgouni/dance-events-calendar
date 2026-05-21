"""Tests for the user-preferences feature: PATCH /api/auth/preferences,
the anon-prefs merge in POST /api/auth/google, and the bbox/tag filter on
GET /api/events.
"""

import os
from datetime import datetime
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

# Stable session secret + dev auth so the test client can sign in via the
# mock-Google path without a real ID token (matches test_auth_routes.py).
os.environ.setdefault("SESSION_SECRET", "test-secret-for-preferences")
os.environ.setdefault("ADMIN_EMAIL", "admin@example.com")
os.environ["DEV_AUTH"] = "true"

from backend.api.main import app  # noqa: E402
from backend.api.routes import auth as auth_module  # noqa: E402
from backend.db.database import get_session  # noqa: E402
from backend.db.models import (  # noqa: E402
    CachedEvent,
    CalendarSetting,
    EventTag,
    Tag,
    TagGroup,
    User,
    UserPreferredTag,
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


def _login(client: TestClient, *, email: str, anon_prefs: dict | None = None):
    body: dict = {"credential": "ignored-in-mock", "mock_email": email}
    if anon_prefs is not None:
        body["anon_preferences"] = anon_prefs
    return client.post("/api/auth/google", json=body)


@pytest.fixture
def tags(session):
    """Two enabled dance-style tags + one disabled, returned as (t1, t2, t_disabled)."""
    grp = TagGroup(
        slug="dance",
        label="Dance",
        ordinal=0,
        allow_multiple=True,
    )
    session.add(grp)
    session.commit()
    session.refresh(grp)
    t1 = Tag(group_id=grp.id, slug="salsa", label="Salsa", ordinal=0, enabled=True)
    t2 = Tag(group_id=grp.id, slug="bachata", label="Bachata", ordinal=1, enabled=True)
    t_off = Tag(group_id=grp.id, slug="forro", label="Forró", ordinal=2, enabled=False)
    for t in (t1, t2, t_off):
        session.add(t)
    session.commit()
    for t in (t1, t2, t_off):
        session.refresh(t)
    return t1, t2, t_off


# --- PATCH /api/auth/preferences --------------------------------------------


@pytest.mark.unit
def test_patch_preferences_round_trip(client, session, tags):
    t1, t2, _ = tags
    _login(client, email="alice@example.com")

    payload = {
        "preferred_area": {
            "min_lat": 35.0,
            "min_lng": -10.0,
            "max_lat": 71.0,
            "max_lng": 60.0,
            "label": "Europe & nearby",
        },
        "preferred_tag_ids": [t1.id, t2.id],
    }
    resp = client.patch("/api/auth/preferences", json=payload)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["preferred_area"]["label"] == "Europe & nearby"
    assert sorted(data["preferred_tag_ids"]) == sorted([t1.id, t2.id])
    assert data["set_at"] is not None

    user = session.exec(select(User).where(User.email == "alice@example.com")).one()
    assert user.preferred_area_min_lat == 35.0
    assert user.preferred_area_max_lng == 60.0
    assert user.preferred_area_label == "Europe & nearby"
    assert user.preferences_set_at is not None
    rows = session.exec(
        select(UserPreferredTag).where(UserPreferredTag.user_id == user.id)
    ).all()
    assert sorted(r.tag_id for r in rows) == sorted([t1.id, t2.id])


@pytest.mark.unit
def test_patch_preferences_explicit_clear_keeps_set_at(client, session, tags):
    t1, _, _ = tags
    _login(client, email="alice@example.com")
    client.patch(
        "/api/auth/preferences",
        json={
            "preferred_area": {
                "min_lat": 1.0,
                "min_lng": 1.0,
                "max_lat": 2.0,
                "max_lng": 2.0,
                "label": "Tiny",
            },
            "preferred_tag_ids": [t1.id],
        },
    )
    # Explicit clear: empty tags + null area.
    resp = client.patch(
        "/api/auth/preferences",
        json={"preferred_area": None, "preferred_tag_ids": []},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["preferred_area"] is None
    assert data["preferred_tag_ids"] == []
    assert data["set_at"] is not None  # bumped, not cleared

    user = session.exec(select(User).where(User.email == "alice@example.com")).one()
    assert user.preferred_area_min_lat is None
    assert user.preferred_area_label is None


@pytest.mark.unit
def test_patch_preferences_partial_omit_leaves_untouched(client, session, tags):
    t1, _, _ = tags
    _login(client, email="alice@example.com")
    client.patch(
        "/api/auth/preferences",
        json={
            "preferred_area": {
                "min_lat": 10.0,
                "min_lng": 10.0,
                "max_lat": 20.0,
                "max_lng": 20.0,
                "label": "Region A",
            },
            "preferred_tag_ids": [t1.id],
        },
    )
    # Update only share_attendance_default; area + tags must stay.
    resp = client.patch(
        "/api/auth/preferences", json={"share_attendance_default": False}
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["preferred_area"]["label"] == "Region A"
    assert data["preferred_tag_ids"] == [t1.id]
    assert data["share_attendance_default"] is False


@pytest.mark.unit
def test_patch_preferences_rejects_invalid_bbox(client, session, tags):
    _login(client, email="alice@example.com")
    resp = client.patch(
        "/api/auth/preferences",
        json={
            "preferred_area": {
                "min_lat": 50.0,
                "min_lng": 10.0,
                "max_lat": 40.0,  # min > max
                "max_lng": 20.0,
                "label": "Bad",
            }
        },
    )
    assert resp.status_code == 400


@pytest.mark.unit
def test_patch_preferences_rejects_unknown_tag(client, session, tags):
    _login(client, email="alice@example.com")
    resp = client.patch("/api/auth/preferences", json={"preferred_tag_ids": [99999]})
    assert resp.status_code == 400


@pytest.mark.unit
def test_patch_preferences_rejects_disabled_tag(client, session, tags):
    _, _, t_off = tags
    _login(client, email="alice@example.com")
    resp = client.patch("/api/auth/preferences", json={"preferred_tag_ids": [t_off.id]})
    assert resp.status_code == 400


# --- Anon prefs merge on sign-in --------------------------------------------


@pytest.mark.unit
def test_anon_preferences_applied_when_user_has_none(client, session, tags):
    t1, _, _ = tags
    anon = {
        "preferred_area": {
            "min_lat": 0.0,
            "min_lng": 0.0,
            "max_lat": 10.0,
            "max_lng": 10.0,
            "label": "Anon area",
        },
        "preferred_tag_ids": [t1.id],
    }
    resp = _login(client, email="alice@example.com", anon_prefs=anon)
    assert resp.status_code == 200
    prefs = resp.json()["preferences"]
    assert prefs["preferred_area"]["label"] == "Anon area"
    assert prefs["preferred_tag_ids"] == [t1.id]
    assert prefs["set_at"] is not None


@pytest.mark.unit
def test_anon_preferences_ignored_when_user_already_has_prefs(client, session, tags):
    t1, t2, _ = tags
    # First sign-in: set server-side prefs.
    _login(client, email="alice@example.com")
    client.patch(
        "/api/auth/preferences",
        json={
            "preferred_area": {
                "min_lat": 35.0,
                "min_lng": -10.0,
                "max_lat": 71.0,
                "max_lng": 60.0,
                "label": "Europe & nearby",
            },
            "preferred_tag_ids": [t1.id],
        },
    )
    # Sign out by clearing cookies.
    client.cookies.clear()

    # New device sign-in with conflicting anon prefs — server prefs win.
    anon = {
        "preferred_area": {
            "min_lat": 1.0,
            "min_lng": 1.0,
            "max_lat": 2.0,
            "max_lng": 2.0,
            "label": "Other area",
        },
        "preferred_tag_ids": [t2.id],
    }
    resp = _login(client, email="alice@example.com", anon_prefs=anon)
    assert resp.status_code == 200
    prefs = resp.json()["preferences"]
    assert prefs["preferred_area"]["label"] == "Europe & nearby"
    assert prefs["preferred_tag_ids"] == [t1.id]


@pytest.mark.unit
def test_anon_preferences_with_stale_tag_ids_does_not_block_signin(
    client, session, tags
):
    """Stale tag IDs in localStorage (e.g. tag was deleted server-side)
    must not prevent sign-in — they are silently dropped."""
    anon = {
        "preferred_area": None,
        "preferred_tag_ids": [99999],  # nonexistent
    }
    resp = _login(client, email="alice@example.com", anon_prefs=anon)
    assert resp.status_code == 200
    prefs = resp.json()["preferences"]
    assert prefs["preferred_tag_ids"] == []


# --- /api/events bbox filter ------------------------------------------------


@pytest.fixture
def events_with_coords(session):
    """Three events spread across Europe + one without coords (excluded)."""
    cal = CalendarSetting(calendar_id="cal-1", name="Cal", enabled=True, color="#000")
    session.add(cal)
    now = datetime.utcnow()
    rows = [
        CachedEvent(
            event_id="paris",
            calendar_id="cal-1",
            title="Paris socials",
            start=now,
            end=now,
            latitude=48.85,
            longitude=2.35,
        ),
        CachedEvent(
            event_id="berlin",
            calendar_id="cal-1",
            title="Berlin congress",
            start=now,
            end=now,
            latitude=52.52,
            longitude=13.40,
        ),
        CachedEvent(
            event_id="madrid",
            calendar_id="cal-1",
            title="Madrid bachata",
            start=now,
            end=now,
            latitude=40.42,
            longitude=-3.70,
        ),
        CachedEvent(
            event_id="no-coords",
            calendar_id="cal-1",
            title="Online",
            start=now,
            end=now,
            latitude=None,
            longitude=None,
        ),
    ]
    for r in rows:
        session.add(r)
    session.commit()
    return rows


@pytest.mark.unit
def test_events_bbox_filters_out_outside(client, session, events_with_coords):
    # Bbox around France: should keep Paris + Madrid, drop Berlin + no-coords.
    resp = client.get(
        "/api/events",
        params={
            "min_lat": 35.0,
            "min_lng": -10.0,
            "max_lat": 51.0,
            "max_lng": 10.0,
        },
    )
    assert resp.status_code == 200, resp.text
    ids = sorted(e["event_id"] for e in resp.json())
    assert ids == ["madrid", "paris"]


@pytest.mark.unit
def test_events_bbox_partial_params_rejected(client, session, events_with_coords):
    resp = client.get("/api/events", params={"min_lat": 35.0, "min_lng": -10.0})
    assert resp.status_code == 400


@pytest.mark.unit
def test_events_bbox_invalid_min_max_rejected(client, session, events_with_coords):
    resp = client.get(
        "/api/events",
        params={
            "min_lat": 60.0,
            "min_lng": -10.0,
            "max_lat": 40.0,  # min > max
            "max_lng": 10.0,
        },
    )
    assert resp.status_code == 400


@pytest.mark.unit
def test_events_bbox_combined_with_tags(client, session, events_with_coords, tags):
    t1, _, _ = tags
    # Tag only Paris with t1.
    session.add(EventTag(event_id="paris", tag_id=t1.id))
    session.commit()

    resp = client.get(
        "/api/events",
        params={
            "min_lat": 35.0,
            "min_lng": -10.0,
            "max_lat": 60.0,
            "max_lng": 30.0,
            "tag_ids": str(t1.id),
        },
    )
    assert resp.status_code == 200
    ids = [e["event_id"] for e in resp.json()]
    assert ids == ["paris"]


@pytest.mark.unit
def test_events_bbox_outside_default_returns_events_in_view(client, session):
    """The explorer must return events anywhere on the globe when the user
    pans there. Regression for the cleanup that consolidates the area
    resolution: the backend has no implicit "Europe" default, so a Tokyo
    bbox returns the Tokyo event regardless of any saved preferences.
    """
    cal = CalendarSetting(calendar_id="cal-1", name="Cal", enabled=True, color="#000")
    session.add(cal)
    now = datetime.utcnow()
    session.add(
        CachedEvent(
            event_id="tokyo",
            calendar_id="cal-1",
            title="Tokyo bachata",
            start=now,
            end=now,
            latitude=35.68,
            longitude=139.69,
        )
    )
    session.add(
        CachedEvent(
            event_id="paris",
            calendar_id="cal-1",
            title="Paris socials",
            start=now,
            end=now,
            latitude=48.85,
            longitude=2.35,
        )
    )
    session.commit()

    # Bbox covering Japan only — must return Tokyo, not Paris.
    resp = client.get(
        "/api/events",
        params={
            "min_lat": 30.0,
            "min_lng": 130.0,
            "max_lat": 45.0,
            "max_lng": 145.0,
        },
    )
    assert resp.status_code == 200, resp.text
    ids = [e["event_id"] for e in resp.json()]
    assert ids == ["tokyo"]
