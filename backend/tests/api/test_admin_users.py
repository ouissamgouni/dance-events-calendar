"""Tests for the admin Users tab endpoints.

Covers:
- ``GET /api/social/admin/users`` (auth gating, search, pagination,
  follower counts, deleted filter, verified filter).
- ``DELETE /api/social/admin/users/id/{user_id}`` (auth gating, social-edge
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
    CalendarCurationRule,
    CalendarSetting,
    CalendarSubscription,
    EventRating,
    User,
    UserAccountMerge,
    UserEventAttendance,
    UserFollow,
    UserSavedEvent,
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
def test_admin_list_users_sort_by_followers_count(client, session):
    users = _seed_users(session)
    # Bob and Carol both follow Alice → followers_count(alice) == 2.
    session.add(UserFollow(follower_id=users["bob"].id, followee_id=users["alice"].id))
    session.add(
        UserFollow(follower_id=users["carol"].id, followee_id=users["alice"].id)
    )
    session.commit()

    _login(client, "admin@example.com")
    r = client.get(
        "/api/social/admin/users",
        params={"sort_by": "followers_count", "sort_dir": "desc"},
    )
    assert r.status_code == 200, r.text
    handles = [row["handle"] for row in r.json()["items"]]
    assert handles[0] == "alice"

    r2 = client.get(
        "/api/social/admin/users",
        params={"sort_by": "followers_count", "sort_dir": "asc"},
    )
    assert r2.status_code == 200
    handles2 = [row["handle"] for row in r2.json()["items"]]
    assert handles2[-1] == "alice"


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
        f"/api/social/admin/users/id/{users['alice'].id}/managed",
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


@pytest.mark.unit
def test_admin_force_enable_push_toggle(client, session):
    users = _seed_users(session)
    assert users["alice"].force_enable_push_prompt is False

    _login(client, "admin@example.com")
    r = client.patch(
        f"/api/social/admin/users/id/{users['alice'].id}/force-enable-push",
        json={"force_enable_push_prompt": True},
    )
    assert r.status_code == 200, r.text
    assert r.json()["force_enable_push_prompt"] is True

    session.expire_all()
    alice = session.exec(select(User).where(User.handle == "alice")).first()
    assert alice is not None
    assert alice.force_enable_push_prompt is True

    r2 = client.patch(
        f"/api/social/admin/users/id/{users['alice'].id}/force-enable-push",
        json={"force_enable_push_prompt": False},
    )
    assert r2.status_code == 200, r2.text
    assert r2.json()["force_enable_push_prompt"] is False


@pytest.mark.unit
def test_admin_send_install_email_requires_admin(client, session):
    users = _seed_users(session)
    _login(client, "alice@example.com")  # not admin
    r = client.post(f"/api/social/admin/users/id/{users['bob'].id}/send-install-email")
    assert r.status_code == 403


@pytest.mark.unit
def test_admin_send_install_email_skips_without_smtp(client, session):
    # SMTP isn't configured in this test environment, so the send is a
    # no-op (status "skipped"), but the endpoint still succeeds.
    users = _seed_users(session)
    _login(client, "admin@example.com")
    r = client.post(
        f"/api/social/admin/users/id/{users['alice'].id}/send-install-email"
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"status": "skipped", "user_id": str(users["alice"].id)}


@pytest.mark.unit
def test_admin_actions_work_for_user_without_handle(client, session):
    users = _seed_users(session)
    users["alice"].handle = None
    session.add(users["alice"])
    session.commit()
    session.refresh(users["alice"])

    _login(client, "admin@example.com")
    r = client.patch(
        f"/api/social/admin/users/id/{users['alice'].id}/verified",
        json={"is_verified_organizer": True},
    )
    assert r.status_code == 200, r.text
    assert r.json()["handle"] is None
    assert r.json()["is_verified_organizer"] is True

    r2 = client.patch(
        f"/api/social/admin/users/id/{users['alice'].id}/managed",
        json={"is_admin_managed": True, "managed_label": "Legacy account"},
    )
    assert r2.status_code == 200, r2.text
    assert r2.json()["handle"] is None
    assert r2.json()["is_admin_managed"] is True

    r3 = client.delete(f"/api/social/admin/users/id/{users['alice'].id}")
    assert r3.status_code == 200, r3.text
    assert r3.json()["status"] == "deleted"


# --- DELETE /admin/users/id/{user_id} ---------------------------------------


@pytest.mark.unit
def test_admin_delete_user_requires_admin(client, session):
    users = _seed_users(session)
    _login(client, "alice@example.com")
    r = client.delete(f"/api/social/admin/users/id/{users['bob'].id}")
    assert r.status_code == 403


@pytest.mark.unit
def test_admin_delete_user_404_for_unknown_user_id(client, session):
    _seed_users(session)
    _login(client, "admin@example.com")
    r = client.delete("/api/social/admin/users/id/00000000-0000-0000-0000-000000000000")
    assert r.status_code == 404


@pytest.mark.unit
def test_admin_delete_user_refuses_to_delete_admin(client, session):
    users = _seed_users(session)
    _login(client, "admin@example.com")
    r = client.delete(f"/api/social/admin/users/id/{users['admin'].id}")
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
    r = client.delete(f"/api/social/admin/users/id/{users['carol'].id}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "deleted"

    # Edges gone.
    assert session.exec(select(UserFollow)).all() == []
    assert session.exec(select(CalendarSubscription)).all() == []
    # Carol soft-deleted + anonymised.
    session.expire_all()
    carol = session.exec(
        select(User).where(User.email.like("deleted-%@example.invalid"))
    ).first()
    assert carol is not None
    assert carol.deleted_at is not None
    # Subsequent admin lookup by id returns 404 (deleted users are excluded).
    r2 = client.delete(f"/api/social/admin/users/id/{users['carol'].id}")
    assert r2.status_code == 404


# --- POST /admin/users/merge ------------------------------------------------


@pytest.mark.unit
def test_admin_merge_users_requires_admin(client, session):
    users = _seed_users(session)
    users["carol"].is_admin_managed = True
    session.add(users["carol"])
    session.commit()

    _login(client, "alice@example.com")
    r = client.post(
        "/api/social/admin/users/merge",
        json={
            "source_user_id": str(users["carol"].id),
            "destination_user_id": str(users["bob"].id),
        },
    )
    assert r.status_code == 403


@pytest.mark.unit
def test_admin_merge_users_requires_managed_source(client, session):
    users = _seed_users(session)

    _login(client, "admin@example.com")
    r = client.post(
        "/api/social/admin/users/merge",
        json={
            "source_user_id": str(users["carol"].id),
            "destination_user_id": str(users["bob"].id),
        },
    )
    assert r.status_code == 400
    assert r.json()["detail"] == "Source user must be admin-managed"


@pytest.mark.unit
def test_admin_merge_users_moves_managed_data_and_anonymizes_source(client, session):
    users = _seed_users(session)
    users["carol"].is_admin_managed = True
    users["carol"].managed_label = "Old curator"
    session.add(users["carol"])
    session.add(CalendarSetting(calendar_id="cal-merge", name="Merge Calendar"))
    session.add(
        CalendarCurationRule(
            calendar_id="cal-merge",
            target_user_id=users["carol"].id,
            kind="save",
            audience="public",
        )
    )
    session.add(
        UserFollow(follower_id=users["alice"].id, followee_id=users["carol"].id)
    )
    session.add(
        UserFollow(follower_id=users["carol"].id, followee_id=users["alice"].id)
    )
    session.add(
        CalendarSubscription(
            subscriber_id=users["alice"].id,
            target_user_id=users["carol"].id,
        )
    )
    session.add(
        UserSavedEvent(
            device_id="carol-save-device",
            event_id="event-1",
            user_id=users["carol"].id,
            audience="public",
        )
    )
    session.add(
        UserEventAttendance(
            device_id="carol-going-device",
            event_id="event-1",
            user_id=users["carol"].id,
            share_audience="public",
            share_publicly=True,
        )
    )
    session.add(
        EventRating(
            event_id="event-1",
            user_id=users["carol"].id,
            stars=5,
            status="approved",
        )
    )
    session.commit()

    _login(client, "admin@example.com")
    r = client.post(
        "/api/social/admin/users/merge",
        json={
            "source_user_id": str(users["carol"].id),
            "destination_user_id": str(users["bob"].id),
            "reason": "Google account recovery",
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "merged"
    assert body["summary"]["follows_moved"] == 2
    assert body["summary"]["saved_events_moved"] == 1
    assert body["summary"]["attendance_moved"] == 1

    session.expire_all()
    bob = session.get(User, users["bob"].id)
    carol = session.get(User, users["carol"].id)
    assert bob is not None
    assert carol is not None
    assert bob.email == "bob@example.com"
    assert bob.provider_subject == "mock|bob@example.com"
    assert bob.is_admin_managed is True
    assert bob.managed_label == "Old curator"
    assert carol.deleted_at is not None
    assert carol.email == f"merged-{carol.id}@example.invalid"
    assert carol.provider_subject is None
    assert carol.handle is None
    assert carol.is_admin_managed is False

    follows = session.exec(select(UserFollow)).all()
    assert {(f.follower_id, f.followee_id) for f in follows} == {
        (users["alice"].id, users["bob"].id),
        (users["bob"].id, users["alice"].id),
    }
    sub = session.exec(select(CalendarSubscription)).one()
    assert sub.subscriber_id == users["alice"].id
    assert sub.target_user_id == users["bob"].id
    saved = session.exec(select(UserSavedEvent)).one()
    assert saved.user_id == users["bob"].id
    attendance = session.exec(select(UserEventAttendance)).one()
    assert attendance.user_id == users["bob"].id
    rule = session.exec(select(CalendarCurationRule)).one()
    assert rule.target_user_id == users["bob"].id
    rating = session.exec(select(EventRating)).one()
    assert rating.user_id == users["bob"].id
    merge = session.exec(select(UserAccountMerge)).one()
    assert merge.source_user_id == users["carol"].id
    assert merge.destination_user_id == users["bob"].id
    assert merge.reason == "Google account recovery"


@pytest.mark.unit
def test_admin_merge_users_dedupes_existing_destination_rows(client, session):
    users = _seed_users(session)
    users["carol"].is_admin_managed = True
    session.add(users["carol"])
    session.add(CalendarSetting(calendar_id="cal-merge", name="Merge Calendar"))
    session.add(
        CalendarCurationRule(
            calendar_id="cal-merge",
            target_user_id=users["carol"].id,
            kind="going",
        )
    )
    session.add(
        CalendarCurationRule(
            calendar_id="cal-merge",
            target_user_id=users["bob"].id,
            kind="going",
        )
    )
    session.add(
        UserFollow(follower_id=users["alice"].id, followee_id=users["carol"].id)
    )
    session.add(UserFollow(follower_id=users["alice"].id, followee_id=users["bob"].id))
    session.add(
        CalendarSubscription(
            subscriber_id=users["alice"].id,
            target_user_id=users["carol"].id,
            notify_new_events=False,
        )
    )
    session.add(
        CalendarSubscription(
            subscriber_id=users["alice"].id,
            target_user_id=users["bob"].id,
            notify_new_events=True,
        )
    )
    session.add(
        UserSavedEvent(
            device_id="source-save", event_id="event-1", user_id=users["carol"].id
        )
    )
    session.add(
        UserSavedEvent(
            device_id="dest-save", event_id="event-1", user_id=users["bob"].id
        )
    )
    session.add(
        UserEventAttendance(
            device_id="source-going", event_id="event-1", user_id=users["carol"].id
        )
    )
    session.add(
        UserEventAttendance(
            device_id="dest-going", event_id="event-1", user_id=users["bob"].id
        )
    )
    session.add(EventRating(event_id="event-1", user_id=users["carol"].id, stars=4))
    session.add(EventRating(event_id="event-1", user_id=users["bob"].id, stars=2))
    session.commit()

    _login(client, "admin@example.com")
    r = client.post(
        "/api/social/admin/users/merge",
        json={
            "source_user_id": str(users["carol"].id),
            "destination_user_id": str(users["bob"].id),
        },
    )
    assert r.status_code == 200, r.text
    summary = r.json()["summary"]
    assert summary["follows_deduped"] == 1
    assert summary["subscriptions_deduped"] == 1
    assert summary["saved_events_deduped"] == 1
    assert summary["attendance_deduped"] == 1
    assert summary["curation_rules_deduped"] == 1
    assert summary["ratings_anonymized"] == 1

    session.expire_all()
    assert len(session.exec(select(UserFollow)).all()) == 1
    assert len(session.exec(select(CalendarSubscription)).all()) == 1
    assert len(session.exec(select(UserSavedEvent)).all()) == 1
    assert len(session.exec(select(UserEventAttendance)).all()) == 1
    assert len(session.exec(select(CalendarCurationRule)).all()) == 1
    ratings = session.exec(select(EventRating)).all()
    assert len(ratings) == 2
    assert sum(1 for rating in ratings if rating.user_id == users["bob"].id) == 1
    assert (
        sum(1 for rating in ratings if rating.user_id is None and rating.is_anonymous)
        == 1
    )
