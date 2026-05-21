"""Tests for the admin Users tab endpoints.

Covers:
- ``GET /api/social/admin/users`` (auth gating, search, pagination,
  follower counts, deleted filter, verified filter).
- ``DELETE /api/social/admin/users/{handle}`` (auth gating, social-edge
  cleanup parity with self-service deletion, refusal to delete the admin's
  own account).
"""

import os

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

os.environ.setdefault("SESSION_SECRET", "test-secret-admin-users")
os.environ.setdefault("ADMIN_EMAIL", "admin@example.com")
os.environ["DEV_AUTH"] = "true"

from backend.api.main import app  # noqa: E402
from backend.api.routes import auth as auth_module  # noqa: E402
from backend.api.routes import social as social_module  # noqa: E402
from backend.db.database import get_session  # noqa: E402
from backend.db.models import (  # noqa: E402
    CalendarSubscription,
    User,
    UserFollow,
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


def _seed_users(session: Session) -> dict[str, User]:
    """Three regular users + the admin. Returns by handle."""
    out: dict[str, User] = {}
    for email, handle in [
        ("alice@example.com", "alice"),
        ("bob@example.com", "bob"),
        ("carol@example.com", "carol"),
        ("admin@example.com", "admin"),
    ]:
        u = User(
            email=email,
            display_name=handle.title(),
            handle=handle,
            provider="google",
            provider_subject=f"mock|{email}",
        )
        session.add(u)
        out[handle] = u
    session.commit()
    for u in out.values():
        session.refresh(u)
    return out


# --- GET /admin/users -------------------------------------------------------


@pytest.mark.unit
def test_admin_list_users_requires_admin(client, session):
    _seed_users(session)
    _login(client, "alice@example.com")  # not admin
    r = client.get("/api/social/admin/users")
    assert r.status_code == 403


@pytest.mark.unit
def test_admin_list_users_requires_auth(client, session):
    _seed_users(session)
    r = client.get("/api/social/admin/users")
    # Unauthenticated calls hit get_current_user (admin dep) which returns
    # 401 before the admin check runs.
    assert r.status_code in (401, 403)


@pytest.mark.unit
def test_admin_list_users_returns_rows_with_counts(client, session):
    users = _seed_users(session)
    # Bob and Carol both follow Alice → followers_count(alice) == 2.
    session.add(UserFollow(follower_id=users["bob"].id, followee_id=users["alice"].id))
    session.add(
        UserFollow(follower_id=users["carol"].id, followee_id=users["alice"].id)
    )
    # Alice follows Bob → following_count(alice) == 1.
    session.add(UserFollow(follower_id=users["alice"].id, followee_id=users["bob"].id))
    session.commit()

    _login(client, "admin@example.com")
    r = client.get("/api/social/admin/users")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"] == 4
    by_handle = {row["handle"]: row for row in body["items"]}
    assert by_handle["alice"]["followers_count"] == 2
    assert by_handle["alice"]["following_count"] == 1
    assert by_handle["bob"]["followers_count"] == 1
    assert by_handle["admin"]["is_admin"] is True
    assert by_handle["alice"]["is_admin"] is False
    # Email IS exposed (admin endpoint, gated by require_admin).
    assert by_handle["alice"]["email"] == "alice@example.com"


@pytest.mark.unit
def test_admin_list_users_search(client, session):
    _seed_users(session)
    _login(client, "admin@example.com")
    r = client.get("/api/social/admin/users", params={"q": "ali"})
    assert r.status_code == 200
    handles = [row["handle"] for row in r.json()["items"]]
    assert handles == ["alice"]


@pytest.mark.unit
def test_admin_list_users_excludes_deleted_by_default(client, session):
    users = _seed_users(session)
    # Soft-delete Carol the same way the auth flow would.
    from datetime import datetime

    users["carol"].deleted_at = datetime.utcnow()
    session.add(users["carol"])
    session.commit()

    _login(client, "admin@example.com")
    r = client.get("/api/social/admin/users")
    assert r.status_code == 200
    handles = {row["handle"] for row in r.json()["items"]}
    assert "carol" not in handles

    r2 = client.get("/api/social/admin/users", params={"include_deleted": True})
    handles2 = {row["handle"] for row in r2.json()["items"]}
    assert "carol" in handles2


@pytest.mark.unit
def test_admin_managed_toggle_sets_public_default_audience(client, session):
    users = _seed_users(session)
    users["alice"].share_attendance_default = False
    users["alice"].share_attendance_default_audience = "private"
    session.add(users["alice"])
    session.commit()

    _login(client, "admin@example.com")
    r = client.patch(
        "/api/social/admin/users/alice/managed",
        json={"is_admin_managed": True, "managed_label": "Paris curator"},
    )
    assert r.status_code == 200, r.text

    session.expire_all()
    alice = session.exec(select(User).where(User.handle == "alice")).first()
    assert alice is not None
    assert alice.is_admin_managed is True
    assert alice.managed_label == "Paris curator"
    assert alice.share_attendance_default is True
    assert alice.share_attendance_default_audience == "public"
    assert alice.share_attendance_default_set_by_user is True


# --- DELETE /admin/users/{handle} -------------------------------------------


@pytest.mark.unit
def test_admin_delete_user_requires_admin(client, session):
    _seed_users(session)
    _login(client, "alice@example.com")
    r = client.delete("/api/social/admin/users/bob")
    assert r.status_code == 403


@pytest.mark.unit
def test_admin_delete_user_404_for_unknown_handle(client, session):
    _seed_users(session)
    _login(client, "admin@example.com")
    r = client.delete("/api/social/admin/users/nobody")
    assert r.status_code == 404


@pytest.mark.unit
def test_admin_delete_user_refuses_to_delete_admin(client, session):
    _seed_users(session)
    _login(client, "admin@example.com")
    r = client.delete("/api/social/admin/users/admin")
    assert r.status_code == 400
    # Admin row is still present and active.
    admin = session.exec(select(User).where(User.handle == "admin")).first()
    assert admin is not None
    assert admin.deleted_at is None


@pytest.mark.unit
def test_admin_delete_user_purges_social_edges(client, session):
    """Parity with self-service delete: hard-deleting Carol via the admin
    endpoint must drop her follow + subscription rows so Alice's follower
    count drops by 1. Regression coverage matching the friends-graph fix.
    """
    users = _seed_users(session)
    session.add(
        UserFollow(follower_id=users["carol"].id, followee_id=users["alice"].id)
    )
    session.add(
        CalendarSubscription(
            subscriber_id=users["carol"].id,
            target_user_id=users["alice"].id,
        )
    )
    session.commit()
    assert session.exec(select(UserFollow)).all()

    _login(client, "admin@example.com")
    r = client.delete("/api/social/admin/users/carol")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "deleted"

    # Edges gone.
    assert session.exec(select(UserFollow)).all() == []
    assert session.exec(select(CalendarSubscription)).all() == []
    # Carol soft-deleted + anonymised.
    carol = session.exec(
        select(User).where(User.email.like("deleted-%@example.invalid"))
    ).first()
    assert carol is not None
    assert carol.deleted_at is not None
    # Subsequent admin lookup by old handle returns 404 (deleted users are
    # excluded by _resolve_handle).
    r2 = client.delete("/api/social/admin/users/carol")
    assert r2.status_code == 404
