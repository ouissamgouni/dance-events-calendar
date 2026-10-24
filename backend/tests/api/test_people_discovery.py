"""People discovery: dismissals, Home people sheet caps, "joined" notifications, digest."""

import os
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

os.environ.setdefault("SESSION_SECRET", "test-secret-people-discovery")
os.environ.setdefault("ADMIN_EMAIL", "admin@example.com")
os.environ["DEV_AUTH"] = "true"

from backend.api.main import app  # noqa: E402
from backend.api.routes import auth as auth_module  # noqa: E402
from backend.api.routes import social as social_module  # noqa: E402
from backend.db.database import get_session  # noqa: E402
from backend.db.models import (  # noqa: E402
    Notification,
    PeoplePromptForce,
    PeoplePromptImpression,
    SuggestionDismissal,
    User,
    UserFollow,
)
from backend.services import email as email_module  # noqa: E402
from backend.services import people_joined_service, people_prompt  # noqa: E402

NOW = datetime.now(timezone.utc)


@pytest.fixture
def engine():
    eng = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
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


def _user(session: Session, handle: str, *, days_old: int = 60, **kw) -> User:
    u = User(
        email=f"{handle}@example.com",
        display_name=handle.title(),
        handle=handle,
        provider="google",
        provider_subject=f"mock|{handle}@example.com",
        created_at=NOW - timedelta(days=days_old),
        onboarded_at=NOW - timedelta(days=days_old),
        **kw,
    )
    session.add(u)
    session.commit()
    session.refresh(u)
    return u


def _follow(session: Session, a: User, b: User) -> None:
    session.add(UserFollow(follower_id=a.id, followee_id=b.id))
    session.commit()


def _friends(session: Session, a: User, b: User) -> None:
    _follow(session, a, b)
    _follow(session, b, a)


def _login(client: TestClient, user: User) -> None:
    r = client.post(
        "/api/auth/google", json={"credential": "ignored", "mock_email": user.email}
    )
    assert r.status_code == 200, r.text


def _handles(resp) -> list[str]:
    return [i["handle"] for i in resp.json()["items"]]


# --- dismissals + trail position ---------------------------------------------


def test_dismissed_person_disappears_and_undismiss_restores(client, session):
    viewer = _user(session, "viewer")
    friend = _user(session, "friend")
    cand = _user(session, "cand")
    _friends(session, viewer, friend)
    _follow(session, friend, cand)
    _login(client, viewer)

    r = client.get("/api/social/me/suggestions")
    assert "cand" in _handles(r)
    assert r.json()["friend_count"] == 1
    assert r.json()["trail_position"] == "top"

    assert client.post("/api/social/me/suggestions/cand/dismiss").status_code == 204
    assert "cand" not in _handles(client.get("/api/social/me/suggestions"))

    assert client.delete("/api/social/me/suggestions/cand/dismiss").status_code == 204
    assert "cand" in _handles(client.get("/api/social/me/suggestions"))


def test_dismissal_expires_after_ttl(session):
    viewer = _user(session, "viewer")
    cand = _user(session, "cand")
    session.add(
        SuggestionDismissal(
            user_id=viewer.id,
            dismissed_user_id=cand.id,
            dismissed_at=NOW - timedelta(days=91),
        )
    )
    session.commit()
    assert people_prompt.dismissed_user_ids(session, viewer.id) == set()


def test_trail_moves_to_bottom_above_friend_threshold(session):
    assert people_prompt.trail_position(session, 9) == "top"
    assert people_prompt.trail_position(session, 10) == "bottom"


# --- Home people sheet --------------------------------------------------------


def _curators(session: Session, n: int) -> None:
    for i in range(n):
        _user(session, f"curator{i}", is_admin_managed=True)


def test_people_prompt_shows_then_respects_cooldown(client, session):
    viewer = _user(session, "viewer")
    _curators(session, 3)
    _login(client, viewer)

    body = client.get("/api/social/me/people-prompt").json()
    assert body["show"] is True and len(body["items"]) == 3

    client.post("/api/social/me/people-prompt/impression", json={"outcome": "shown"})
    assert client.get("/api/social/me/people-prompt").json()["show"] is False


def test_trail_size_setting_caps_trail_and_sheet(client, session, monkeypatch):
    monkeypatch.setenv("PEOPLE_TRAIL_MAX_ITEMS", "2")
    viewer = _user(session, "viewer")
    _curators(session, 4)
    _login(client, viewer)

    body = client.get("/api/social/me/suggestions?trail=true&limit=10").json()
    assert len(body["items"]) == 2
    assert body["total"] == 4 and body["trail_size"] == 2
    assert len(client.get("/api/social/me/suggestions?limit=10").json()["items"]) == 4
    assert len(client.get("/api/social/me/people-prompt").json()["items"]) == 2


def test_seed_shuffles_pool_deterministically(client, session):
    viewer = _user(session, "viewer")
    _curators(session, 8)
    _login(client, viewer)

    ranked = _handles(client.get("/api/social/me/suggestions?limit=50"))
    a = _handles(client.get("/api/social/me/suggestions?limit=50&seed=7"))
    b = _handles(client.get("/api/social/me/suggestions?limit=50&seed=7"))
    others = [
        _handles(client.get(f"/api/social/me/suggestions?limit=50&seed={s}"))
        for s in range(1, 6)
    ]
    assert a == b and sorted(a) == sorted(ranked)
    assert any(o != ranked for o in others)
    assert _handles(client.get("/api/social/me/suggestions?limit=50")) == ranked


def test_people_prompt_skipped_for_large_circle_and_min_suggestions(session):
    viewer = _user(session, "viewer")
    assert people_prompt.should_show(session, viewer, 10, 5) == (False, False)
    assert people_prompt.should_show(session, viewer, 0, 2) == (False, False)
    assert people_prompt.should_show(session, viewer, 0, 3) == (True, False)


def test_people_prompt_fatigue_pause(session):
    viewer = _user(session, "viewer")
    for days in (3, 6, 9):
        session.add(
            PeoplePromptImpression(
                user_id=viewer.id,
                shown_at=NOW - timedelta(days=days),
                outcome="dismissed",
            )
        )
    session.commit()
    assert people_prompt.should_show(session, viewer, 0, 5) == (False, False)


def test_admin_force_bypasses_caps_and_is_consumed(client, session):
    viewer = _user(session, "viewer")
    _curators(session, 1)
    admin = User(
        email="admin@example.com",
        handle="admin",
        provider="google",
        provider_subject="mock|admin@example.com",
    )
    session.add(admin)
    session.commit()
    _login(client, admin)

    preview = client.post(
        "/api/admin/people-prompt/force", json={"user_ids": [str(viewer.id)]}
    ).json()
    assert preview["forced"] == 0
    assert preview["users"][0]["forced_until"] is None
    assert preview["users"][0]["total"] == 1
    forced = client.post(
        "/api/admin/people-prompt/force",
        json={"user_ids": [str(viewer.id)], "dry_run": False},
    ).json()
    assert forced["forced"] == 1
    assert forced["users"][0]["forced_until"] is not None

    assert people_prompt.should_show(session, viewer, 0, 1) == (True, True)
    people_prompt.record_impression(session, viewer, "shown")
    session.commit()
    assert session.exec(select(PeoplePromptForce)).all() == []
    assert session.exec(select(PeoplePromptImpression)).one().forced is True


def _admin_login(client: TestClient, session: Session) -> User:
    admin = User(
        email="admin@example.com",
        handle="admin",
        provider="google",
        provider_subject="mock|admin@example.com",
    )
    session.add(admin)
    session.commit()
    _login(client, admin)
    return admin


def test_admin_force_all_users(client, session):
    a = _user(session, "a")
    b = _user(session, "b")
    _curators(session, 1)
    _admin_login(client, session)

    preview = client.post(
        "/api/admin/people-prompt/force", json={"all_users": True}
    ).json()
    assert preview["targeted"] == 2 and preview["forced"] == 0
    assert session.exec(select(PeoplePromptForce)).all() == []

    done = client.post(
        "/api/admin/people-prompt/force", json={"all_users": True, "dry_run": False}
    ).json()
    assert done["forced"] == 2
    forced_ids = {f.user_id for f in session.exec(select(PeoplePromptForce)).all()}
    assert forced_ids == {a.id, b.id}


def test_admin_joined_force_multiple_joiners(client, session):
    alice = _user(session, "alice")
    bob = _user(session, "bob")
    _friends(session, alice, bob)
    n1 = _user(session, "n1", days_old=1)
    n2 = _user(session, "n2", days_old=1)
    _follow(session, n1, bob)
    _follow(session, n2, bob)
    _admin_login(client, session)

    body = client.post(
        "/api/admin/people-joined/force",
        json={"joiner_user_ids": [str(n1.id), str(n2.id)], "dry_run": False},
    ).json()
    assert body["created"] == sum(j["created"] for j in body["joiners"])
    alice_rows = session.exec(
        select(Notification).where(Notification.recipient_user_id == alice.id)
    ).all()
    assert {n.actor_user_id for n in alice_rows} == {n1.id, n2.id}
    assert [j["joiner_handle"] for j in body["joiners"]] == ["n1", "n2"]

    recent = client.post(
        "/api/admin/people-joined/force", json={"all_recent_joiners": True}
    ).json()
    handles = {j["joiner_handle"] for j in recent["joiners"]}
    assert {"n1", "n2"} <= handles


# --- "someone you may know joined" -------------------------------------------


def _joined_rows(session: Session) -> dict[str, int]:
    users = {u.id: u.handle for u in session.exec(select(User)).all()}
    return {
        users[n.recipient_user_id]: int(n.context)
        for n in session.exec(
            select(Notification).where(
                Notification.kind == people_joined_service.SUGGESTED_PERSON_JOINED
            )
        ).all()
    }


def test_joined_regular_mutual_notifies(session):
    alice = _user(session, "alice")
    bob = _user(session, "bob")
    _friends(session, alice, bob)
    newbie = _user(session, "newbie", days_old=1)
    _follow(session, newbie, bob)

    assert people_joined_service.detect(session) == 1
    assert _joined_rows(session) == {"alice": 1}
    # Idempotent on the next tick.
    assert people_joined_service.detect(session) == 0


def test_joined_curator_needs_two_shared(session):
    c1 = _user(session, "c1", is_admin_managed=True)
    c2 = _user(session, "c2", is_verified_organizer=True)
    one = _user(session, "one")
    two = _user(session, "two")
    _follow(session, one, c1)
    _follow(session, two, c1)
    _follow(session, two, c2)
    newbie = _user(session, "newbie", days_old=1)
    _follow(session, newbie, c1)
    _follow(session, newbie, c2)

    people_joined_service.detect(session)
    rows = _joined_rows(session)
    assert "two" in rows and "one" not in rows
    # Curator accounts never receive the notification.
    assert "c1" not in rows


def test_joined_privacy_and_window_gates(session):
    alice = _user(session, "alice")
    bob = _user(session, "bob")
    _friends(session, alice, bob)
    private = _user(session, "private", days_old=1, account_visibility="private")
    hidden = _user(session, "hidden", days_old=1, show_in_suggestions=False)
    old = _user(session, "old", days_old=30)
    for joiner in (private, hidden, old):
        _follow(session, joiner, bob)

    assert people_joined_service.detect(session) == 0


def test_joined_skips_followers_and_dismissers(session):
    alice = _user(session, "alice")
    carol = _user(session, "carol")
    bob = _user(session, "bob")
    _friends(session, alice, bob)
    _friends(session, carol, bob)
    newbie = _user(session, "newbie", days_old=1)
    _follow(session, newbie, bob)
    _follow(session, alice, newbie)
    session.add(SuggestionDismissal(user_id=carol.id, dismissed_user_id=newbie.id))
    session.commit()

    reasons = {
        r["user"].handle: r["reason"]
        for r in people_joined_service.evaluate(session, newbie)
    }
    assert reasons["alice"] == "already_follows"
    assert reasons["carol"] == "dismissed"
    assert people_joined_service.detect(session) == 0


def test_joined_push_batched_once_per_day_in_window(session, monkeypatch):
    pushes: list[tuple] = []
    monkeypatch.setattr(
        "backend.services.push_service.send_push",
        lambda user_id, **kw: pushes.append((user_id, kw["title"])) or 1,
    )
    alice = _user(session, "alice", timezone="UTC")
    bob = _user(session, "bob")
    _friends(session, alice, bob)
    for h in ("n1", "n2"):
        _follow(session, _user(session, h, days_old=1), bob)
    noon = NOW.replace(hour=12, minute=0)
    people_joined_service.detect(session, noon)

    night = NOW.replace(hour=23, minute=0)
    assert people_joined_service.push_pending(session, night) == 0
    people_joined_service.push_pending(session, noon)
    alice_pushes = [title for uid, title in pushes if uid == alice.id]
    assert len(alice_pushes) == 1 and "1 other" in alice_pushes[0]
    stats = people_joined_service.stats(session, noon - timedelta(days=1))
    assert stats["joined_created"] > stats["joined_pushed"] == len(pushes)
    assert stats["joined_push_failed"] == 0

    _follow(session, _user(session, "n3", days_old=1), bob)
    people_joined_service.detect(session, noon)
    people_joined_service.push_pending(session, noon + timedelta(hours=2))
    assert len([uid for uid, _ in pushes if uid == alice.id]) == 1


# --- digest people section ----------------------------------------------------


def test_people_section_has_new_on_movida_and_see_all():
    html = email_module._people_suggestions_html(
        [{"handle": "top", "followers_count": 1}],
        [{"handle": "fresh", "followers_count": 0}],
    )
    assert "New on Movida" in html and "fresh" in html
    assert "/tribe/network" in html


def test_email_suggestions_split_recent_joiners(session):
    viewer = _user(session, "viewer")
    for i in range(6):
        _user(session, f"cur{i}", is_admin_managed=True)
    _user(session, "freshcur", is_admin_managed=True, days_old=2)

    top, recent = social_module.get_people_suggestions_for_email(
        session, viewer, limit=5
    )
    assert len(top) == 5
    assert "freshcur" not in {i.handle for i in top}
    assert [i.handle for i in recent] == ["freshcur"]


def test_email_new_on_movida_pulls_high_ranked_joiner(session):
    viewer = _user(session, "viewer")
    friend = _user(session, "friend")
    _friends(session, viewer, friend)
    fresh = _user(session, "fresh", days_old=1)
    _follow(session, friend, fresh)
    _curators(session, 2)

    top, recent = social_module.get_people_suggestions_for_email(session, viewer)
    assert [i.handle for i in recent] == ["fresh"]
    assert {i.handle for i in top} == {"curator0", "curator1"}


def test_people_prompt_decide_reasons(session):
    viewer = _user(session, "viewer")
    assert people_prompt.decide(session, viewer, 10, 5)[2] == "circle_too_big"
    assert people_prompt.decide(session, viewer, 0, 0)[2] == "no_suggestions"
    assert people_prompt.decide(session, viewer, 0, 2)[2] == "too_few_suggestions"
    assert people_prompt.decide(session, viewer, 0, 3) == (True, False, "ok")
