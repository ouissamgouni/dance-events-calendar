"""Tests for interest-profile CRUD: GET/POST/PATCH/DELETE
/api/interest-profiles.
"""

import os

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

os.environ.setdefault("SESSION_SECRET", "test-secret-for-interest-profiles")
os.environ.setdefault("ADMIN_EMAIL", "admin@example.com")
os.environ["DEV_AUTH"] = "true"

from backend.api.main import app  # noqa: E402
from backend.api.routes import auth as auth_module  # noqa: E402
from backend.db.database import get_session  # noqa: E402
from backend.db.models import Tag, TagGroup  # noqa: E402


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


def _login(client: TestClient, *, email: str):
    resp = client.post(
        "/api/auth/google", json={"credential": "ignored-in-mock", "mock_email": email}
    )
    # Signup seeds a default InterestProfile (permissive, matches_enabled=false,
    # is_active=true) so the Explorer/For You/alerts surfaces always have a row
    # to filter against. Clear it so these tests continue to assert against a
    # clean slate.
    listing = client.get("/api/interest-profiles").json()
    if isinstance(listing, list):
        for row in listing:
            client.delete(f"/api/interest-profiles/{row['id']}")
    return resp


@pytest.fixture
def tags(session):
    """One enabled dance tag + one enabled reach tag + one disabled dance tag."""
    dance_grp = TagGroup(slug="dance", label="Dance", ordinal=0, allow_multiple=True)
    reach_grp = TagGroup(slug="reach", label="Reach", ordinal=1, allow_multiple=True)
    session.add(dance_grp)
    session.add(reach_grp)
    session.commit()
    session.refresh(dance_grp)
    session.refresh(reach_grp)

    salsa = Tag(group_id=dance_grp.id, slug="salsa", label="Salsa", enabled=True)
    forro = Tag(group_id=dance_grp.id, slug="forro", label="Forró", enabled=False)
    regional = Tag(
        group_id=reach_grp.id, slug="regional", label="Regional", enabled=True
    )
    for t in (salsa, forro, regional):
        session.add(t)
    session.commit()
    for t in (salsa, forro, regional):
        session.refresh(t)
    return salsa, forro, regional


# --- POST /api/interest-profiles --------------------------------------------


@pytest.mark.unit
def test_create_interest_profile_area(client, tags):
    salsa, _forro, regional = tags
    _login(client, email="alice@example.com")

    payload = {
        "label": "My Area",
        "min_lat": 35.0,
        "min_lng": -10.0,
        "max_lat": 45.0,
        "max_lng": 5.0,
        "dance_tag_ids": [salsa.id],
        "reach_tag_ids": [regional.id],
        "matches_enabled": True,
    }
    resp = client.post("/api/interest-profiles", json=payload)
    assert resp.status_code == 201, resp.text
    data = resp.json()
    assert data["label"] == "My Area"
    assert data["dance_tag_ids"] == [salsa.id]
    assert data["reach_tag_ids"] == [regional.id]
    assert data["matches_enabled"] is True
    # Legacy mirror kept for one release.
    assert data["notify_enabled"] is True

    # Round-trips via GET list.
    list_resp = client.get("/api/interest-profiles")
    assert list_resp.status_code == 200
    assert len(list_resp.json()) == 1


@pytest.mark.unit
def test_create_interest_profile_rejects_disabled_tag(client, tags):
    _salsa, forro, _regional = tags
    _login(client, email="alice@example.com")

    payload = {
        "label": "Bad profile",
        "min_lat": 35.0,
        "min_lng": -10.0,
        "max_lat": 45.0,
        "max_lng": 5.0,
        "dance_tag_ids": [forro.id],
    }
    resp = client.post("/api/interest-profiles", json=payload)
    assert resp.status_code == 400


@pytest.mark.unit
def test_create_interest_profile_rejects_invalid_area(client):
    _login(client, email="alice@example.com")

    payload = {
        "label": "Inverted",
        "min_lat": 45.0,
        "min_lng": -10.0,
        "max_lat": 35.0,
        "max_lng": 5.0,
    }
    resp = client.post("/api/interest-profiles", json=payload)
    assert resp.status_code == 400


# --- PATCH /api/interest-profiles/{id} --------------------------------------


@pytest.mark.unit
def test_patch_interest_profile_partial_update(client, tags):
    salsa, _forro, regional = tags
    _login(client, email="alice@example.com")

    create_resp = client.post(
        "/api/interest-profiles",
        json={
            "label": "Original",
            "min_lat": 35.0,
            "min_lng": -10.0,
            "max_lat": 45.0,
            "max_lng": 5.0,
            "dance_tag_ids": [salsa.id],
        },
    )
    profile_id = create_resp.json()["id"]

    patch_resp = client.patch(
        f"/api/interest-profiles/{profile_id}",
        json={"label": "Renamed", "reach_tag_ids": [regional.id]},
    )
    assert patch_resp.status_code == 200, patch_resp.text
    data = patch_resp.json()
    assert data["label"] == "Renamed"
    assert data["dance_tag_ids"] == [salsa.id]
    assert data["reach_tag_ids"] == [regional.id]
    # Untouched geo fields preserved.
    assert data["max_lat"] == 45.0


@pytest.mark.unit
def test_patch_interest_profile_not_found(client):
    _login(client, email="alice@example.com")
    resp = client.patch("/api/interest-profiles/999999", json={"label": "X"})
    assert resp.status_code == 404


# --- DELETE /api/interest-profiles/{id} -------------------------------------


@pytest.mark.unit
def test_delete_interest_profile(client, tags):
    salsa, _forro, _regional = tags
    _login(client, email="alice@example.com")

    create_resp = client.post(
        "/api/interest-profiles",
        json={
            "label": "To delete",
            "min_lat": 35.0,
            "min_lng": -10.0,
            "max_lat": 45.0,
            "max_lng": 5.0,
            "dance_tag_ids": [salsa.id],
        },
    )
    profile_id = create_resp.json()["id"]

    del_resp = client.delete(f"/api/interest-profiles/{profile_id}")
    assert del_resp.status_code == 204

    list_resp = client.get("/api/interest-profiles")
    assert list_resp.json() == []


@pytest.mark.unit
def test_delete_interest_profile_not_found(client):
    _login(client, email="alice@example.com")
    resp = client.delete("/api/interest-profiles/999999")
    assert resp.status_code == 404


@pytest.mark.unit
def test_interest_profiles_require_auth(client):
    resp = client.get("/api/interest-profiles")
    assert resp.status_code == 401


# --- is_active enforcement --------------------------------------------------


def _minimal_area_payload(**overrides):
    base = {
        "label": "P",
        "min_lat": 35.0,
        "min_lng": -10.0,
        "max_lat": 45.0,
        "max_lng": 5.0,
    }
    base.update(overrides)
    return base


@pytest.mark.unit
def test_first_profile_auto_active(client):
    _login(client, email="alice@example.com")
    resp = client.post("/api/interest-profiles", json=_minimal_area_payload())
    assert resp.status_code == 201
    assert resp.json()["is_active"] is True


@pytest.mark.unit
def test_second_profile_not_active_by_default(client):
    _login(client, email="alice@example.com")
    a = client.post(
        "/api/interest-profiles", json=_minimal_area_payload(label="A")
    ).json()
    b = client.post(
        "/api/interest-profiles", json=_minimal_area_payload(label="B")
    ).json()
    assert a["is_active"] is True
    assert b["is_active"] is False


@pytest.mark.unit
def test_creating_second_profile_with_active_flag_deactivates_first(client):
    _login(client, email="alice@example.com")
    a_id = client.post(
        "/api/interest-profiles", json=_minimal_area_payload(label="A")
    ).json()["id"]
    b = client.post(
        "/api/interest-profiles", json=_minimal_area_payload(label="B", is_active=True)
    ).json()
    assert b["is_active"] is True
    lst = {p["id"]: p for p in client.get("/api/interest-profiles").json()}
    assert lst[a_id]["is_active"] is False
    assert lst[b["id"]]["is_active"] is True


@pytest.mark.unit
def test_patch_is_active_deactivates_others(client):
    _login(client, email="alice@example.com")
    a_id = client.post(
        "/api/interest-profiles", json=_minimal_area_payload(label="A")
    ).json()["id"]
    b_id = client.post(
        "/api/interest-profiles", json=_minimal_area_payload(label="B")
    ).json()["id"]
    r = client.patch(f"/api/interest-profiles/{b_id}", json={"is_active": True})
    assert r.status_code == 200
    assert r.json()["is_active"] is True
    lst = {p["id"]: p for p in client.get("/api/interest-profiles").json()}
    assert lst[a_id]["is_active"] is False


@pytest.mark.unit
def test_patch_cannot_deactivate_active_directly(client):
    _login(client, email="alice@example.com")
    a_id = client.post(
        "/api/interest-profiles", json=_minimal_area_payload(label="A")
    ).json()["id"]
    r = client.patch(f"/api/interest-profiles/{a_id}", json={"is_active": False})
    assert r.status_code == 400


@pytest.mark.unit
def test_deleting_active_profile_promotes_next_oldest(client):
    _login(client, email="alice@example.com")
    a_id = client.post(
        "/api/interest-profiles", json=_minimal_area_payload(label="A")
    ).json()["id"]
    b_id = client.post(
        "/api/interest-profiles", json=_minimal_area_payload(label="B")
    ).json()["id"]
    del_r = client.delete(f"/api/interest-profiles/{a_id}")
    assert del_r.status_code == 204
    lst = client.get("/api/interest-profiles").json()
    assert len(lst) == 1
    assert lst[0]["id"] == b_id
    assert lst[0]["is_active"] is True


# --- Signup bootstrap: default profile is seeded exactly once ---------------


def _raw_login(client: TestClient, *, email: str):
    """Login without the ``_login`` helper's default-profile cleanup, so
    signup-bootstrap assertions can inspect what the auth route actually
    creates."""
    return client.post(
        "/api/auth/google", json={"credential": "ignored-in-mock", "mock_email": email}
    )


@pytest.mark.unit
def test_signup_seeds_exactly_one_default_profile(client):
    _raw_login(client, email="new@example.com")
    listing = client.get("/api/interest-profiles").json()
    assert isinstance(listing, list)
    assert len(listing) == 1
    default = listing[0]
    assert default["label"] == "My preferences"
    assert default["is_active"] is True
    assert default["matches_enabled"] is False
    # Legacy mirror kept for one release.
    assert default["notify_enabled"] is False
    # DEFAULT_AREA_BBOX mirrored from backend/services/user_bootstrap.py.
    assert default["min_lat"] == 24.0
    assert default["min_lng"] == -18.0
    assert default["max_lat"] == 69.0
    assert default["max_lng"] == 50.0


@pytest.mark.unit
def test_resignup_does_not_duplicate_default_profile(client):
    _raw_login(client, email="return@example.com")
    _raw_login(client, email="return@example.com")  # simulate re-login
    listing = client.get("/api/interest-profiles").json()
    assert len(listing) == 1


@pytest.mark.unit
def test_signup_default_includes_international_reach_when_tag_exists(client, session):
    grp = TagGroup(slug="reach", label="Reach", ordinal=0, allow_multiple=True)
    session.add(grp)
    session.commit()
    session.refresh(grp)
    intl = Tag(
        group_id=grp.id, slug="international", label="International", enabled=True
    )
    session.add(intl)
    session.commit()
    session.refresh(intl)

    _raw_login(client, email="int@example.com")
    listing = client.get("/api/interest-profiles").json()
    assert len(listing) == 1
    assert intl.id in listing[0].get("reach_tag_ids", [])


# --- Cross-user access control ---------------------------------------------


@pytest.mark.unit
def test_patch_other_users_profile_returns_404(client, tags):
    salsa, *_ = tags
    _login(client, email="alice@example.com")
    create_resp = client.post(
        "/api/interest-profiles",
        json={
            "label": "Alice's",
            "min_lat": 40.0,
            "min_lng": -5.0,
            "max_lat": 45.0,
            "max_lng": 5.0,
            "dance_tag_ids": [salsa.id],
        },
    )
    alice_profile_id = create_resp.json()["id"]

    # Swap identities on the same client — the session cookie is replaced.
    _login(client, email="bob@example.com")

    r = client.patch(
        f"/api/interest-profiles/{alice_profile_id}", json={"label": "hijacked"}
    )
    assert r.status_code == 404


@pytest.mark.unit
def test_delete_other_users_profile_returns_404(client, tags):
    salsa, *_ = tags
    _login(client, email="alice@example.com")
    create_resp = client.post(
        "/api/interest-profiles",
        json={
            "label": "Alice's",
            "min_lat": 40.0,
            "min_lng": -5.0,
            "max_lat": 45.0,
            "max_lng": 5.0,
            "dance_tag_ids": [salsa.id],
        },
    )
    alice_profile_id = create_resp.json()["id"]

    _login(client, email="bob@example.com")

    r = client.delete(f"/api/interest-profiles/{alice_profile_id}")
    assert r.status_code == 404
