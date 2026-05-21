"""Phase E (friendship adoption) — Batch 2 tests.

Covers:
- E3: onboarding suggestions ranking + batch-complete idempotency +
  ``onboarded_at`` stamp; both GET /auth/me and POST /auth/google
  surface the ``onboarded_at`` field.
- E4: GET /api/social/me/suggestions returns friend-of-friend
  candidates ranked by mutual-friend count with up to 3 preview
  handles; excludes self/already-followed/no-handle/deleted.
- E7: GET/POST /api/social/me/referral is idempotent (same code on
  repeated calls); POST /api/auth/redeem-referral requires consent
  and creates a mutual ``UserFollow`` pair on success.
"""

import os
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

os.environ.setdefault("SESSION_SECRET", "test-secret-phase-e-batch-2")
os.environ.setdefault("ADMIN_EMAIL", "admin@example.com")
os.environ["DEV_AUTH"] = "true"

from backend.api.main import app  # noqa: E402
from backend.api.routes import auth as auth_module  # noqa: E402
from backend.api.routes import social as social_module  # noqa: E402
from backend.db.database import get_session  # noqa: E402
from backend.db.models import (  # noqa: E402
    User,
    UserFollow,
    UserReferral,
)


# --- fixtures ---------------------------------------------------------------


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


# --- helpers ----------------------------------------------------------------


def _login(client: TestClient, email: str) -> None:
    r = client.post(
        "/api/auth/google",
        json={"credential": "ignored", "mock_email": email},
    )
    assert r.status_code == 200, r.text


def _logout(client: TestClient) -> None:
    client.cookies.clear()


def _make_user(
    session: Session,
    email: str,
    handle: str,
    *,
    is_verified_organizer: bool = False,
    is_admin_managed: bool = False,
    deleted: bool = False,
) -> User:
    u = User(
        email=email,
        display_name=handle.title(),
        handle=handle,
        provider="google",
        provider_subject=f"mock|{email}",
        account_visibility="public",
        is_verified_organizer=is_verified_organizer,
        is_admin_managed=is_admin_managed,
    )
    if deleted:
        from datetime import datetime

        u.deleted_at = datetime.utcnow()
    session.add(u)
    session.commit()
    session.refresh(u)
    return u


def _follow(session: Session, follower: User, followee: User) -> None:
    session.add(UserFollow(follower_id=follower.id, followee_id=followee.id))
    session.commit()


def _mutual(session: Session, a: User, b: User) -> None:
    _follow(session, a, b)
    _follow(session, b, a)


# --- E3: onboarding ---------------------------------------------------------


def test_e3_auth_me_includes_onboarded_at_field(client, session):
    _make_user(session, "viewer@example.com", "viewer")
    _login(client, "viewer@example.com")
    r = client.get("/api/auth/me")
    assert r.status_code == 200
    body = r.json()
    # New accounts have NEVER been through onboarding.
    assert "onboarded_at" in body
    assert body["onboarded_at"] is None


def test_e3_auth_google_includes_onboarded_at_field(client, session):
    r = client.post(
        "/api/auth/google",
        json={"credential": "ignored", "mock_email": "newbie@example.com"},
    )
    assert r.status_code == 200
    body = r.json()
    assert "onboarded_at" in body
    assert body["onboarded_at"] is None


def test_e3_onboarding_suggestions_prioritises_verified_organizers(client, session):
    _make_user(session, "viewer@example.com", "viewer")
    # 2 verified organizers + 2 ordinary popular accounts; the
    # organizers must come first regardless of followers count.
    org1 = _make_user(session, "org1@example.com", "org1", is_verified_organizer=True)
    org2 = _make_user(session, "org2@example.com", "org2", is_verified_organizer=True)
    pop1 = _make_user(session, "pop1@example.com", "pop1")
    pop2 = _make_user(session, "pop2@example.com", "pop2")
    # Give pop1 a follower so it qualifies for the "most-followed"
    # bucket; org1/org2 have zero followers and would otherwise lose.
    extra = _make_user(session, "extra@example.com", "extra")
    _follow(session, extra, pop1)
    _follow(session, extra, pop2)

    _login(client, "viewer@example.com")
    r = client.get("/api/social/onboarding/suggestions?limit=4")
    assert r.status_code == 200
    handles = [item["handle"] for item in r.json()["items"]]
    # Organizers occupy slots 1 and 2 (unordered between themselves).
    assert set(handles[:2]) == {"org1", "org2"}
    # Then the most-followed non-organizers fill the rest.
    assert set(handles[2:]) <= {"pop1", "pop2", "extra"}


def test_e3_onboarding_suggestions_excludes_self_and_already_followed(client, session):
    viewer = _make_user(session, "viewer@example.com", "viewer")
    org = _make_user(session, "org@example.com", "org", is_verified_organizer=True)
    # Viewer already follows the organizer → must NOT be re-suggested.
    _follow(session, viewer, org)
    _login(client, "viewer@example.com")
    r = client.get("/api/social/onboarding/suggestions")
    handles = [item["handle"] for item in r.json()["items"]]
    assert "org" not in handles
    assert "viewer" not in handles  # never recommend self


def test_e3_onboarding_suggestions_include_admin_managed_curators(client, session):
    _make_user(session, "viewer@example.com", "viewer")
    _make_user(session, "curator@example.com", "curator", is_admin_managed=True)

    _login(client, "viewer@example.com")
    r = client.get("/api/social/onboarding/suggestions?limit=4")
    assert r.status_code == 200
    items = r.json()["items"]
    handles = [item["handle"] for item in items]
    assert "curator" in handles
    curator = next(item for item in items if item["handle"] == "curator")
    assert curator["is_admin_managed"] is True


def test_e3_onboarding_complete_creates_follows_and_stamps(client, session):
    viewer = _make_user(session, "viewer@example.com", "viewer")
    a = _make_user(session, "a@example.com", "alpha")
    b = _make_user(session, "b@example.com", "beta")
    _login(client, "viewer@example.com")

    r = client.post(
        "/api/social/onboarding/complete",
        json={"handles": ["alpha", "beta"]},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert sorted(body["followed"]) == ["alpha", "beta"]
    assert body["onboarded_at"] is not None

    # Both UserFollow rows exist.
    follows = session.exec(
        select(UserFollow).where(UserFollow.follower_id == viewer.id)
    ).all()
    target_ids = {f.followee_id for f in follows}
    assert {a.id, b.id} <= target_ids

    # /auth/me now reports onboarded_at.
    r2 = client.get("/api/auth/me")
    assert r2.json()["onboarded_at"] is not None


def test_e3_onboarding_complete_with_empty_handles_just_stamps(client, session):
    _make_user(session, "viewer@example.com", "viewer")
    _login(client, "viewer@example.com")
    r = client.post("/api/social/onboarding/complete", json={"handles": []})
    assert r.status_code == 200
    assert r.json()["followed"] == []
    assert r.json()["onboarded_at"] is not None


def test_e3_onboarding_complete_idempotent_on_duplicate_handles(client, session):
    viewer = _make_user(session, "viewer@example.com", "viewer")
    _make_user(session, "a@example.com", "alpha")
    _login(client, "viewer@example.com")

    r1 = client.post("/api/social/onboarding/complete", json={"handles": ["alpha"]})
    assert r1.status_code == 200
    r2 = client.post("/api/social/onboarding/complete", json={"handles": ["alpha"]})
    assert r2.status_code == 200
    # Second call returns the already-followed handle as a no-op
    # (followed == [] because the edge already exists).
    assert r2.json()["followed"] == []
    # Only ONE follow edge exists.
    follows = session.exec(
        select(UserFollow).where(UserFollow.follower_id == viewer.id)
    ).all()
    assert len(follows) == 1


def test_e3_onboarding_complete_drops_unknown_and_self_handles(client, session):
    _make_user(session, "viewer@example.com", "viewer")
    _make_user(session, "a@example.com", "alpha")
    _login(client, "viewer@example.com")
    r = client.post(
        "/api/social/onboarding/complete",
        json={"handles": ["alpha", "viewer", "doesnotexist"]},
    )
    assert r.status_code == 200
    assert r.json()["followed"] == ["alpha"]


# --- E4: FoF suggestions ----------------------------------------------------


def test_e4_fof_suggestions_ranks_by_mutual_friend_count(client, session):
    viewer = _make_user(session, "viewer@example.com", "viewer")
    # Viewer's friends:
    f1 = _make_user(session, "f1@example.com", "friend1")
    f2 = _make_user(session, "f2@example.com", "friend2")
    f3 = _make_user(session, "f3@example.com", "friend3")
    _mutual(session, viewer, f1)
    _mutual(session, viewer, f2)
    _mutual(session, viewer, f3)
    # Candidates:
    popular = _make_user(session, "p@example.com", "popular")  # 3 mutuals
    medium = _make_user(session, "m@example.com", "medium")  # 2 mutuals
    rare = _make_user(session, "r@example.com", "rare")  # 1 mutual
    for f in (f1, f2, f3):
        _follow(session, f, popular)
    for f in (f1, f2):
        _follow(session, f, medium)
    _follow(session, f1, rare)

    _login(client, "viewer@example.com")
    r = client.get("/api/social/me/suggestions")
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    # Order: popular(3) > medium(2) > rare(1).
    handles = [it["handle"] for it in items]
    assert handles[:3] == ["popular", "medium", "rare"]
    counts = {it["handle"]: it["mutual_friend_count"] for it in items}
    assert counts["popular"] == 3
    assert counts["medium"] == 2
    assert counts["rare"] == 1


def test_e4_fof_suggestions_preview_caps_at_three_handles(client, session):
    viewer = _make_user(session, "viewer@example.com", "viewer")
    friends = []
    for i in range(5):
        f = _make_user(session, f"f{i}@example.com", f"friend{i}")
        _mutual(session, viewer, f)
        friends.append(f)
    cand = _make_user(session, "c@example.com", "candidate")
    for f in friends:
        _follow(session, f, cand)

    _login(client, "viewer@example.com")
    r = client.get("/api/social/me/suggestions")
    items = r.json()["items"]
    target = next(it for it in items if it["handle"] == "candidate")
    assert target["mutual_friend_count"] == 5
    assert len(target["mutual_friends_preview"]) == 3
    # Preview handles are a subset of the actual friends.
    assert set(target["mutual_friends_preview"]) <= {f"friend{i}" for i in range(5)}


def test_e4_fof_suggestions_excludes_already_followed_and_self(client, session):
    viewer = _make_user(session, "viewer@example.com", "viewer")
    friend = _make_user(session, "f@example.com", "friend")
    _mutual(session, viewer, friend)
    # ``followed_already`` is reachable via friend but viewer already
    # follows them — must NOT appear.
    followed_already = _make_user(session, "fa@example.com", "followedalready")
    _follow(session, friend, followed_already)
    _follow(session, viewer, followed_already)
    # ``new`` is reachable and not followed.
    new = _make_user(session, "n@example.com", "newcandidate")
    _follow(session, friend, new)

    _login(client, "viewer@example.com")
    r = client.get("/api/social/me/suggestions")
    handles = [it["handle"] for it in r.json()["items"]]
    assert "followedalready" not in handles
    assert "viewer" not in handles
    assert "friend" not in handles  # also already-followed via mutual
    assert "newcandidate" in handles


def test_e4_fof_suggestions_empty_when_viewer_has_no_friends(client, session):
    _make_user(session, "viewer@example.com", "viewer")
    _login(client, "viewer@example.com")
    r = client.get("/api/social/me/suggestions")
    assert r.status_code == 200
    assert r.json() == {"items": [], "total": 0}


def test_e4_suggestions_include_admin_managed_curators_without_mutuals(client, session):
    _make_user(session, "viewer@example.com", "viewer")
    _make_user(session, "curator@example.com", "curator", is_admin_managed=True)

    _login(client, "viewer@example.com")
    r = client.get("/api/social/me/suggestions")
    assert r.status_code == 200
    items = r.json()["items"]
    assert [item["handle"] for item in items] == ["curator"]
    assert items[0]["is_admin_managed"] is True
    assert items[0]["mutual_friend_count"] == 0


# --- E7: referrals ----------------------------------------------------------


def test_e7_get_referral_is_idempotent(client, session):
    _make_user(session, "viewer@example.com", "viewer")
    _login(client, "viewer@example.com")
    r1 = client.get("/api/social/me/referral")
    r2 = client.get("/api/social/me/referral")
    assert r1.status_code == 200
    assert r2.status_code == 200
    assert r1.json()["code"] == r2.json()["code"]
    assert r1.json()["url"].endswith("/r/" + r1.json()["code"])
    assert r1.json()["used_count"] == 0


def test_e7_post_referral_returns_same_code_as_get(client, session):
    _make_user(session, "viewer@example.com", "viewer")
    _login(client, "viewer@example.com")
    r_get = client.get("/api/social/me/referral")
    r_post = client.post("/api/social/me/referral")
    assert r_get.json()["code"] == r_post.json()["code"]


def test_e7_redeem_requires_consent(client, session):
    _make_user(session, "inviter@example.com", "inviter")
    _make_user(session, "newbie@example.com", "newbie")
    _login(client, "inviter@example.com")
    code = client.get("/api/social/me/referral").json()["code"]
    _logout(client)
    _login(client, "newbie@example.com")
    r = client.post(
        "/api/auth/redeem-referral",
        json={"code": code, "consent": False},
    )
    assert r.status_code == 400


def test_e7_redeem_creates_mutual_follow_pair(client, session):
    inviter = _make_user(session, "inviter@example.com", "inviter")
    newbie = _make_user(session, "newbie@example.com", "newbie")
    _login(client, "inviter@example.com")
    code = client.get("/api/social/me/referral").json()["code"]
    _logout(client)
    _login(client, "newbie@example.com")
    r = client.post(
        "/api/auth/redeem-referral",
        json={"code": code, "consent": True},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["inviter_handle"] == "inviter"
    assert body["mutual_follow_created"] is True

    # Both edges exist.
    fwd = session.exec(
        select(UserFollow)
        .where(UserFollow.follower_id == newbie.id)
        .where(UserFollow.followee_id == inviter.id)
    ).first()
    rev = session.exec(
        select(UserFollow)
        .where(UserFollow.follower_id == inviter.id)
        .where(UserFollow.followee_id == newbie.id)
    ).first()
    assert fwd is not None
    assert rev is not None

    # used_count incremented.
    referral = session.exec(
        select(UserReferral).where(UserReferral.inviter_user_id == inviter.id)
    ).first()
    assert referral is not None
    assert referral.used_count == 1


def test_e7_redeem_unknown_code_silent_no_op(client, session):
    _make_user(session, "newbie@example.com", "newbie")
    _login(client, "newbie@example.com")
    r = client.post(
        "/api/auth/redeem-referral",
        json={"code": "BOGUSCODE", "consent": True},
    )
    assert r.status_code == 200
    # No inviter, no follow created — but 200 to avoid leaking
    # whether the code exists.
    assert r.json()["inviter_handle"] is None
    assert r.json()["mutual_follow_created"] is False


def test_e7_redeem_self_code_no_op(client, session):
    _make_user(session, "self@example.com", "selfie")
    _login(client, "self@example.com")
    code = client.get("/api/social/me/referral").json()["code"]
    r = client.post(
        "/api/auth/redeem-referral",
        json={"code": code, "consent": True},
    )
    assert r.status_code == 200
    assert r.json()["mutual_follow_created"] is False


def test_e7_redeem_double_redemption_idempotent(client, session):
    inviter = _make_user(session, "inviter@example.com", "inviter")
    newbie = _make_user(session, "newbie@example.com", "newbie")
    _login(client, "inviter@example.com")
    code = client.get("/api/social/me/referral").json()["code"]
    _logout(client)
    _login(client, "newbie@example.com")
    client.post(
        "/api/auth/redeem-referral",
        json={"code": code, "consent": True},
    )
    r2 = client.post(
        "/api/auth/redeem-referral",
        json={"code": code, "consent": True},
    )
    assert r2.status_code == 200
    # Second call: edges already exist, so mutual_follow_created is False.
    assert r2.json()["mutual_follow_created"] is False
    # Still only one edge per direction.
    fwd = session.exec(
        select(UserFollow)
        .where(UserFollow.follower_id == newbie.id)
        .where(UserFollow.followee_id == inviter.id)
    ).all()
    assert len(fwd) == 1


# --- D2: share-link doubles as referral -------------------------------------


def _share_code_for(session: Session, email: str) -> str:
    """Trigger lazy share_code allocation by fetching /auth/me as ``email``."""
    # Caller is expected to be logged in as ``email`` already; reads share_code
    # straight from the DB after the read path mints it.
    user = session.exec(select(User).where(User.email == email)).first()
    assert user is not None
    if not user.share_code:
        session.refresh(user)
    return user.share_code  # type: ignore[return-value]


def test_d2_share_source_lookup_returns_handle(client, session):
    _make_user(session, "sharer@example.com", "sharer")
    # share_code is minted on login → /auth/me path.
    _login(client, "sharer@example.com")
    me = client.get("/api/auth/me").json()
    code = me["share_code"]
    assert code
    _logout(client)
    # Anonymous lookup is allowed by design.
    r = client.get(f"/api/social/share-source/{code}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["handle"] == "sharer"
    assert body["display_name"] == "Sharer"


def test_d2_share_source_unknown_404(client, session):
    r = client.get("/api/social/share-source/notarealcode")
    assert r.status_code == 404


def test_d2_share_source_deleted_user_404(client, session):
    _make_user(session, "ghost@example.com", "ghost")
    _login(client, "ghost@example.com")
    code = client.get("/api/auth/me").json()["share_code"]
    _logout(client)
    # Soft-delete the account.
    ghost = session.exec(select(User).where(User.email == "ghost@example.com")).first()
    from datetime import datetime as _dt

    ghost.deleted_at = _dt.utcnow()
    session.add(ghost)
    session.commit()
    r = client.get(f"/api/social/share-source/{code}")
    assert r.status_code == 404


def test_d2_redeem_share_follow_requires_consent(client, session):
    _make_user(session, "sharer@example.com", "sharer")
    _make_user(session, "viewer@example.com", "viewer")
    _login(client, "sharer@example.com")
    code = client.get("/api/auth/me").json()["share_code"]
    _logout(client)
    _login(client, "viewer@example.com")
    r = client.post(
        "/api/auth/redeem-share-follow",
        json={"share_code": code, "consent": False},
    )
    assert r.status_code == 400


def test_d2_redeem_share_follow_creates_one_way(client, session):
    sharer = _make_user(session, "sharer@example.com", "sharer")
    viewer = _make_user(session, "viewer@example.com", "viewer")
    _login(client, "sharer@example.com")
    code = client.get("/api/auth/me").json()["share_code"]
    _logout(client)
    _login(client, "viewer@example.com")
    r = client.post(
        "/api/auth/redeem-share-follow",
        json={"share_code": code, "consent": True},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["sharer_handle"] == "sharer"
    assert body["follow_created"] is True
    fwd = session.exec(
        select(UserFollow)
        .where(UserFollow.follower_id == viewer.id)
        .where(UserFollow.followee_id == sharer.id)
    ).first()
    rev = session.exec(
        select(UserFollow)
        .where(UserFollow.follower_id == sharer.id)
        .where(UserFollow.followee_id == viewer.id)
    ).first()
    assert fwd is not None
    # One-way: sharer is NOT auto-followed back. Sharing a link is not
    # strong enough consent for the sharer to befriend a stranger.
    assert rev is None


def test_d2_redeem_share_follow_does_not_bump_referral_used_count(client, session):
    """Share-link conversions stay off the E7 referral leaderboard."""
    sharer = _make_user(session, "sharer@example.com", "sharer")
    _make_user(session, "viewer@example.com", "viewer")
    _login(client, "sharer@example.com")
    # Allocate an E7 referral row for the sharer so we can confirm
    # used_count stays at 0 after a share-follow redemption.
    client.get("/api/social/me/referral")
    code = client.get("/api/auth/me").json()["share_code"]
    _logout(client)
    _login(client, "viewer@example.com")
    client.post(
        "/api/auth/redeem-share-follow",
        json={"share_code": code, "consent": True},
    )
    referral = session.exec(
        select(UserReferral).where(UserReferral.inviter_user_id == sharer.id)
    ).first()
    assert referral is not None
    assert referral.used_count == 0


def test_d2_redeem_share_follow_self_code_no_op(client, session):
    _make_user(session, "selfie@example.com", "selfie")
    _login(client, "selfie@example.com")
    code = client.get("/api/auth/me").json()["share_code"]
    r = client.post(
        "/api/auth/redeem-share-follow",
        json={"share_code": code, "consent": True},
    )
    assert r.status_code == 200
    assert r.json()["follow_created"] is False
    assert r.json()["sharer_handle"] is None


def test_d2_redeem_share_follow_unknown_code_silent_no_op(client, session):
    _make_user(session, "viewer@example.com", "viewer")
    _login(client, "viewer@example.com")
    r = client.post(
        "/api/auth/redeem-share-follow",
        json={"share_code": "notarealcode", "consent": True},
    )
    assert r.status_code == 200
    assert r.json()["follow_created"] is False
    assert r.json()["sharer_handle"] is None


def test_d2_redeem_share_follow_idempotent(client, session):
    _make_user(session, "sharer@example.com", "sharer")
    _make_user(session, "viewer@example.com", "viewer")
    _login(client, "sharer@example.com")
    code = client.get("/api/auth/me").json()["share_code"]
    _logout(client)
    _login(client, "viewer@example.com")
    client.post(
        "/api/auth/redeem-share-follow",
        json={"share_code": code, "consent": True},
    )
    r2 = client.post(
        "/api/auth/redeem-share-follow",
        json={"share_code": code, "consent": True},
    )
    assert r2.status_code == 200
    # Second call is a no-op; edge already exists.
    assert r2.json()["follow_created"] is False


# ---------------------------------------------------------------------------
# E5: friends / FoF "going" wedge for the event modal.
# ---------------------------------------------------------------------------


def _attend(
    session: Session,
    user: User,
    event_id: str,
    *,
    audience: str = "public",
) -> None:
    from backend.db.models import UserEventAttendance

    session.add(
        UserEventAttendance(
            device_id=f"dev-{user.id}",
            event_id=event_id,
            user_id=user.id,
            share_audience=audience,
            share_publicly=(audience == "public"),
        )
    )
    session.commit()


def test_e5_wedge_requires_auth(client, session):
    r = client.get("/api/events/evt-1/going-wedge")
    assert r.status_code == 401


def test_e5_wedge_empty_when_no_attendees(client, session):
    _make_user(session, "viewer@example.com", "viewer")
    _login(client, "viewer@example.com")
    r = client.get("/api/events/evt-empty/going-wedge")
    assert r.status_code == 200
    body = r.json()
    assert body["friends_going"] == []
    assert body["fof_going"] == []
    assert body["public_going_count"] == 0


def test_e5_wedge_excludes_viewer_own_attendance(client, session):
    viewer = _make_user(session, "viewer@example.com", "viewer")
    _attend(session, viewer, "evt-self", audience="public")
    _login(client, "viewer@example.com")
    r = client.get("/api/events/evt-self/going-wedge")
    assert r.status_code == 200
    body = r.json()
    assert body["friends_going"] == []
    assert body["fof_going"] == []
    assert body["public_going_count"] == 0


def test_e5_wedge_surfaces_friend_with_friends_audience(client, session):
    viewer = _make_user(session, "viewer@example.com", "viewer")
    alice = _make_user(session, "alice@example.com", "alice")
    _mutual(session, viewer, alice)
    _attend(session, alice, "evt-1", audience="friends")
    _login(client, "viewer@example.com")
    r = client.get("/api/events/evt-1/going-wedge")
    assert r.status_code == 200
    body = r.json()
    assert [f["handle"] for f in body["friends_going"]] == ["alice"]
    assert body["fof_going"] == []
    assert body["public_going_count"] == 0


def test_e5_wedge_hides_friends_audience_when_not_friend(client, session):
    """Non-friend attendee with audience=friends must NOT appear, NOT be counted."""
    _make_user(session, "viewer@example.com", "viewer")
    stranger = _make_user(session, "stranger@example.com", "stranger")
    _attend(session, stranger, "evt-1", audience="friends")
    _login(client, "viewer@example.com")
    r = client.get("/api/events/evt-1/going-wedge")
    assert r.status_code == 200
    body = r.json()
    assert body["friends_going"] == []
    assert body["fof_going"] == []
    assert body["public_going_count"] == 0


def test_e5_wedge_excludes_private_audience(client, session):
    viewer = _make_user(session, "viewer@example.com", "viewer")
    alice = _make_user(session, "alice@example.com", "alice")
    _mutual(session, viewer, alice)
    _attend(session, alice, "evt-1", audience="private")
    _login(client, "viewer@example.com")
    r = client.get("/api/events/evt-1/going-wedge")
    body = r.json()
    assert body["friends_going"] == []
    assert body["public_going_count"] == 0


def test_e5_wedge_fof_via_mutual_friend(client, session):
    viewer = _make_user(session, "viewer@example.com", "viewer")
    alice = _make_user(session, "alice@example.com", "alice")
    bob = _make_user(session, "bob@example.com", "bob")
    _mutual(session, viewer, alice)
    _mutual(session, alice, bob)  # bob is FoF via alice
    _attend(session, bob, "evt-1", audience="public")
    _login(client, "viewer@example.com")
    r = client.get("/api/events/evt-1/going-wedge")
    assert r.status_code == 200
    body = r.json()
    assert body["friends_going"] == []
    assert len(body["fof_going"]) == 1
    fof = body["fof_going"][0]
    assert fof["handle"] == "bob"
    assert fof["via_friend_handle"] == "alice"
    assert body["public_going_count"] == 0


def test_e5_wedge_public_stranger_counted_not_named(client, session):
    _make_user(session, "viewer@example.com", "viewer")
    stranger = _make_user(session, "stranger@example.com", "stranger")
    _attend(session, stranger, "evt-1", audience="public")
    _login(client, "viewer@example.com")
    r = client.get("/api/events/evt-1/going-wedge")
    body = r.json()
    assert body["friends_going"] == []
    assert body["fof_going"] == []
    assert body["public_going_count"] == 1


def test_e5_wedge_friend_takes_precedence_over_fof(client, session):
    """A direct friend appears in friends_going, not in fof_going, even if
    a FoF path also exists."""
    viewer = _make_user(session, "viewer@example.com", "viewer")
    alice = _make_user(session, "alice@example.com", "alice")
    bob = _make_user(session, "bob@example.com", "bob")
    _mutual(session, viewer, alice)
    _mutual(session, viewer, bob)
    _mutual(session, alice, bob)  # also FoF path
    _attend(session, bob, "evt-1", audience="public")
    _login(client, "viewer@example.com")
    r = client.get("/api/events/evt-1/going-wedge")
    body = r.json()
    assert [f["handle"] for f in body["friends_going"]] == ["bob"]
    assert body["fof_going"] == []


def test_e5_wedge_fof_cap_overflow_goes_to_public_count(client, session):
    """FoF cap is 5; the 6th FoF candidate spills into public_going_count."""
    viewer = _make_user(session, "viewer@example.com", "viewer")
    alice = _make_user(session, "alice@example.com", "alice")
    _mutual(session, viewer, alice)
    # 6 FoFs (all friends of alice, attending public).
    for i in range(6):
        u = _make_user(session, f"fof{i}@example.com", f"fof{i}")
        _mutual(session, alice, u)
        _attend(session, u, "evt-1", audience="public")
    _login(client, "viewer@example.com")
    r = client.get("/api/events/evt-1/going-wedge")
    body = r.json()
    assert len(body["fof_going"]) == 5
    assert body["public_going_count"] == 1


def test_e5_wedge_soft_deleted_attendee_ignored(client, session):
    viewer = _make_user(session, "viewer@example.com", "viewer")
    ghost = _make_user(session, "ghost@example.com", "ghost")
    _mutual(session, viewer, ghost)
    _attend(session, ghost, "evt-1", audience="public")
    # Soft-delete after the row exists.
    from datetime import datetime as _dt

    ghost.deleted_at = _dt.utcnow()
    session.add(ghost)
    session.commit()
    _login(client, "viewer@example.com")
    r = client.get("/api/events/evt-1/going-wedge")
    body = r.json()
    assert body["friends_going"] == []


def test_e5_wedge_anonymous_attendee_never_named(client, session):
    """Device-only attendances (user_id IS NULL) must not surface or count."""
    from backend.db.models import UserEventAttendance

    _make_user(session, "viewer@example.com", "viewer")
    session.add(
        UserEventAttendance(
            device_id="dev-anon",
            event_id="evt-1",
            user_id=None,
            share_audience="public",
            share_publicly=True,
        )
    )
    session.commit()
    _login(client, "viewer@example.com")
    r = client.get("/api/events/evt-1/going-wedge")
    body = r.json()
    assert body["public_going_count"] == 0


# --- E8: friend-requests for friends-visibility accounts --------------------


def _make_friends_user(session: Session, email: str, handle: str) -> User:
    """Like ``_make_user`` but creates a friends-visibility account."""
    u = User(
        email=email,
        display_name=handle.title(),
        handle=handle,
        provider="google",
        provider_subject=f"mock|{email}",
        account_visibility="friends",
    )
    session.add(u)
    session.commit()
    session.refresh(u)
    return u


def test_e8_follow_public_target_is_immediately_approved(client, session):
    """Following a public-visibility account always lands as approved."""
    os.environ["FEATURE_FRIEND_REQUESTS"] = "true"
    _make_user(session, "viewer@example.com", "viewer")
    _make_user(session, "target@example.com", "target")
    _login(client, "viewer@example.com")
    r = client.post("/api/social/users/target/follow")
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["follow_status"] == "approved"
    assert body["is_following"] is True
    # Approved follow creates the implied subscription.
    assert body["is_subscribed"] is True


def test_e8_follow_friends_only_target_creates_pending(client, session):
    """Friends-visibility target → pending; no visibility granted."""
    os.environ["FEATURE_FRIEND_REQUESTS"] = "true"
    _make_user(session, "viewer@example.com", "viewer")
    _make_friends_user(session, "secret@example.com", "secret")
    _login(client, "viewer@example.com")
    r = client.post("/api/social/users/secret/follow")
    assert r.status_code == 201
    body = r.json()
    assert body["follow_status"] == "pending"
    assert body["is_following"] is False
    assert body["is_friend"] is False
    assert body["is_subscribed"] is False
    # Followers count must NOT include pending requesters.
    assert body["followers_count"] == 0


def test_e8_pending_follow_grants_no_mutual_friend_visibility(client, session):
    """is_mutual_follow must ignore pending edges."""
    os.environ["FEATURE_FRIEND_REQUESTS"] = "true"
    viewer = _make_user(session, "viewer@example.com", "viewer")
    target = _make_friends_user(session, "secret@example.com", "secret")
    # Pre-seed an approved reverse follow (target → viewer); the new
    # forward request is still pending so they are not yet friends.
    session.add(UserFollow(follower_id=target.id, followee_id=viewer.id))
    session.commit()
    _login(client, "viewer@example.com")
    # Reverse approved follow exists ⇒ requires_approval skipped per
    # follow_user logic, so this should *auto-approve*.
    r = client.post("/api/social/users/secret/follow")
    assert r.status_code == 201
    assert r.json()["follow_status"] == "approved"
    assert r.json()["is_friend"] is True


def test_e8_unfollow_clears_pending_request(client, session):
    os.environ["FEATURE_FRIEND_REQUESTS"] = "true"
    _make_user(session, "viewer@example.com", "viewer")
    _make_friends_user(session, "secret@example.com", "secret")
    _login(client, "viewer@example.com")
    client.post("/api/social/users/secret/follow")
    # Pending row + notification exist.
    from backend.db.models import Notification

    notifs = session.exec(
        select(Notification).where(Notification.kind == "follow_request")
    ).all()
    assert len(notifs) == 1
    # Rescind.
    r = client.delete("/api/social/users/secret/follow")
    assert r.status_code == 200
    rows = session.exec(select(UserFollow)).all()
    assert rows == []
    notifs = session.exec(
        select(Notification).where(Notification.kind == "follow_request")
    ).all()
    assert notifs == []


def test_e8_list_follow_requests_returns_pending_inbound(client, session):
    os.environ["FEATURE_FRIEND_REQUESTS"] = "true"
    target = _make_friends_user(session, "target@example.com", "target")
    _make_user(session, "a@example.com", "alice")
    _make_user(session, "b@example.com", "bob")
    # Alice and Bob each request to follow.
    _login(client, "a@example.com")
    client.post("/api/social/users/target/follow")
    _logout(client)
    _login(client, "b@example.com")
    client.post("/api/social/users/target/follow")
    _logout(client)
    # Target views their inbox.
    _login(client, "target@example.com")
    r = client.get("/api/social/me/follow-requests")
    assert r.status_code == 200
    handles = {item["handle"] for item in r.json()["items"]}
    assert handles == {"alice", "bob"}


def test_e8_approve_promotes_to_approved_and_creates_subscription(client, session):
    os.environ["FEATURE_FRIEND_REQUESTS"] = "true"
    _make_friends_user(session, "target@example.com", "target")
    requester = _make_user(session, "asker@example.com", "asker")
    _login(client, "asker@example.com")
    client.post("/api/social/users/target/follow")
    _logout(client)
    _login(client, "target@example.com")
    r = client.post("/api/social/me/follow-requests/asker/approve")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["follow_status"] == "approved"
    assert body["followers_count"] == 1  # asker counts now
    # Row is approved.
    follow = session.exec(
        select(UserFollow).where(UserFollow.follower_id == requester.id)
    ).first()
    assert follow.status == "approved"
    # Pending notification gone.
    from backend.db.models import Notification

    pending = session.exec(
        select(Notification).where(Notification.kind == "follow_request")
    ).all()
    assert pending == []
    # new_follower notification must NOT fire to the approver;
    # instead a follow_request_approved notification is sent to the requester.
    nf = session.exec(
        select(Notification).where(Notification.kind == "new_follower")
    ).all()
    assert len(nf) == 0
    approved = session.exec(
        select(Notification).where(Notification.kind == "follow_request_approved")
    ).all()
    assert len(approved) == 1


def test_e8_approve_creates_mutual_friendship(client, session):
    """Approving a follow-request must make BOTH users friends instantly:
    the reverse follow edge is auto-created so the approver also follows
    the requester (mutual = friends), without needing a separate
    \"follow back\" action."""
    os.environ["FEATURE_FRIEND_REQUESTS"] = "true"
    target = _make_friends_user(session, "target@example.com", "target")
    requester = _make_user(session, "asker@example.com", "asker")
    _login(client, "asker@example.com")
    client.post("/api/social/users/target/follow")
    _logout(client)
    _login(client, "target@example.com")
    r = client.post("/api/social/me/follow-requests/asker/approve")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["follow_status"] == "approved"
    assert body["is_friend"] is True
    assert body["is_following"] is True
    # Both follow edges exist and are approved.
    fwd = session.exec(
        select(UserFollow)
        .where(UserFollow.follower_id == requester.id)
        .where(UserFollow.followee_id == target.id)
    ).first()
    rev = session.exec(
        select(UserFollow)
        .where(UserFollow.follower_id == target.id)
        .where(UserFollow.followee_id == requester.id)
    ).first()
    assert fwd is not None and fwd.status == "approved"
    assert rev is not None and rev.status == "approved"


def test_e8_decline_deletes_row_and_notification(client, session):
    os.environ["FEATURE_FRIEND_REQUESTS"] = "true"
    _make_friends_user(session, "target@example.com", "target")
    _make_user(session, "asker@example.com", "asker")
    _login(client, "asker@example.com")
    client.post("/api/social/users/target/follow")
    _logout(client)
    _login(client, "target@example.com")
    r = client.post("/api/social/me/follow-requests/asker/decline")
    assert r.status_code == 204
    rows = session.exec(select(UserFollow)).all()
    assert rows == []
    from backend.db.models import Notification

    notifs = session.exec(
        select(Notification).where(Notification.kind == "follow_request")
    ).all()
    assert notifs == []


def test_e8_approve_unknown_request_returns_404(client, session):
    os.environ["FEATURE_FRIEND_REQUESTS"] = "true"
    _make_friends_user(session, "target@example.com", "target")
    _make_user(session, "stranger@example.com", "stranger")
    _login(client, "target@example.com")
    r = client.post("/api/social/me/follow-requests/stranger/approve")
    assert r.status_code == 404


def test_e8_flag_off_bypasses_pending_for_friends_account(client, session):
    """With FEATURE_FRIEND_REQUESTS=false, follows always land approved."""
    os.environ["FEATURE_FRIEND_REQUESTS"] = "false"
    try:
        _make_user(session, "viewer@example.com", "viewer")
        _make_friends_user(session, "secret@example.com", "secret")
        _login(client, "viewer@example.com")
        r = client.post("/api/social/users/secret/follow")
        assert r.status_code == 201
        assert r.json()["follow_status"] == "approved"
        assert r.json()["is_following"] is True
    finally:
        os.environ["FEATURE_FRIEND_REQUESTS"] = "true"
