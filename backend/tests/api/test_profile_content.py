"""Tests for Phase D — public profile bio + content tabs + discovery.

Covers:
- ``PATCH /social/me/bio`` normalization (control chars, whitespace, clear).
- ``PublicProfileResponse`` Phase D fields (bio, going_count_30d,
  mutual_subscribers, mutual_subscribers_count) including visibility gating.
- ``GET /social/users/{handle}/{going,saved,suggested}`` content tabs.
- ``GET /social/search/users`` ranking + private exclusion.
- ``GET /social/discover/suggested`` friends-of-friends derivation.

Conventions inherited from ``test_social_routes.py``:
- DEV_AUTH=true + mock-email Google sign-in.
- 404 (never 403) on visibility denial.
- New TestClient per test; rate-limiter reset in fixture.
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

os.environ.setdefault("SESSION_SECRET", "test-secret-phase-d")
os.environ.setdefault("ADMIN_EMAIL", "admin@example.com")
os.environ["DEV_AUTH"] = "true"

from backend.api.main import app  # noqa: E402
from backend.api.routes import auth as auth_module  # noqa: E402
from backend.api.routes import social as social_module  # noqa: E402
from backend.db.database import get_session  # noqa: E402
from backend.db.models import (  # noqa: E402
    CachedEvent,
    CalendarSetting,
    CalendarSubscription,
    EventSuggestion,
    User,
    UserEventAttendance,
    UserFollow,
    UserSavedEvent,
)


# --- Fixtures ----------------------------------------------------------------


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


# --- Helpers ----------------------------------------------------------------


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
    account_visibility: str = "public",
    is_admin_managed: bool = False,
    managed_label: str | None = None,
    show_in_suggestions: bool = True,
    # Back-compat shims for the pre-refactor three-scope kwargs. Any
    # non-"public" value collapses to ``account_visibility="friends"``
    # (the new model's single tightened gate). Callers that explicitly
    # set ``account_visibility`` win.
    visibility_calendar: str | None = None,
    visibility_attendance: str | None = None,
    visibility_saved: str | None = None,
) -> User:
    legacy = [
        v for v in (visibility_calendar, visibility_attendance, visibility_saved) if v
    ]
    if legacy and account_visibility == "public":
        if any(v != "public" for v in legacy):
            account_visibility = "friends"
    u = User(
        email=email,
        display_name=handle.title(),
        handle=handle,
        provider="google",
        provider_subject=f"mock|{email}",
        account_visibility=account_visibility,
        is_admin_managed=is_admin_managed,
        managed_label=managed_label,
        show_in_suggestions=show_in_suggestions,
    )
    session.add(u)
    session.commit()
    session.refresh(u)
    return u


def _follow(session: Session, follower: User, followee: User) -> None:
    session.add(UserFollow(follower_id=follower.id, followee_id=followee.id))
    session.commit()


def _subscribe(session: Session, subscriber: User, target: User) -> None:
    session.add(
        CalendarSubscription(
            subscriber_id=subscriber.id,
            target_user_id=target.id,
            notify_new_events=False,
        )
    )
    session.commit()


def _make_calendar(session: Session, calendar_id: str = "cal-default") -> str:
    cs = CalendarSetting(
        calendar_id=calendar_id,
        name="Default",
        enabled=True,
        color="#3b82f6",
    )
    session.add(cs)
    session.commit()
    return calendar_id


def _make_event(
    session: Session,
    calendar_id: str,
    *,
    title: str = "Salsa Night",
    days_from_now: int = 7,
) -> CachedEvent:
    """Create a CachedEvent at ``now + days_from_now``. Negative = past."""
    start = datetime.utcnow() + timedelta(days=days_from_now)
    ev = CachedEvent(
        event_id=str(uuid4()),
        calendar_id=calendar_id,
        title=title,
        start=start,
        end=start + timedelta(hours=2),
    )
    session.add(ev)
    session.commit()
    session.refresh(ev)
    return ev


def _mark_going(
    session: Session,
    user: User,
    event: CachedEvent,
    *,
    share_publicly: bool = True,
) -> None:
    # Dual-write: ``share_publicly`` is the legacy bool, ``share_audience``
    # is the new 3-tier field that the privacy chokepoint actually reads.
    # Keep them consistent so tests that pass ``share_publicly=False``
    # produce a row that is genuinely hidden under the new model too.
    share_audience = "public" if share_publicly else "private"
    session.add(
        UserEventAttendance(
            user_id=user.id,
            event_id=event.event_id,
            device_id="dev-1",
            status="going",
            share_publicly=share_publicly,
            share_audience=share_audience,
        )
    )
    session.commit()


def _save_event(session: Session, user: User, event: CachedEvent) -> None:
    # Default ``audience`` to ``public`` here so saved-tab tests can
    # exercise the public/anon read path. The model default is
    # ``friends`` (privacy-by-default), but these fixtures predate the
    # flip and assert visibility to anonymous viewers.
    session.add(
        UserSavedEvent(
            user_id=user.id,
            event_id=event.event_id,
            device_id="dev-1",
            audience="public",
        )
    )
    session.commit()


# --- PATCH /me/bio ----------------------------------------------------------


def test_update_bio_persists_and_returns_profile(client, session):
    _make_user(session, "alice@example.com", "alice")
    _login(client, "alice@example.com")
    r = client.patch("/api/social/me/bio", json={"bio": "Salsa addict in SF."})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["handle"] == "alice"
    assert body["bio"] == "Salsa addict in SF."


def test_update_bio_strips_control_chars_and_trims(client, session):
    _make_user(session, "alice@example.com", "alice")
    _login(client, "alice@example.com")
    # Leading/trailing whitespace + a NUL byte + a vertical tab.
    payload = {"bio": "  hello\x00 world\x0b  "}
    r = client.patch("/api/social/me/bio", json=payload)
    assert r.status_code == 200, r.text
    assert r.json()["bio"] == "hello world"


def test_update_bio_empty_clears(client, session):
    alice = _make_user(session, "alice@example.com", "alice")
    alice.bio = "old bio"
    session.add(alice)
    session.commit()
    _login(client, "alice@example.com")
    r = client.patch("/api/social/me/bio", json={"bio": "   "})
    assert r.status_code == 200
    assert r.json()["bio"] is None


def test_update_bio_rejects_too_long(client, session):
    _make_user(session, "alice@example.com", "alice")
    _login(client, "alice@example.com")
    r = client.patch("/api/social/me/bio", json={"bio": "x" * 281})
    # Pydantic max_length validation -> 422.
    assert r.status_code == 422


def test_update_bio_requires_auth(client):
    r = client.patch("/api/social/me/bio", json={"bio": "x"})
    assert r.status_code in (401, 403)


# --- PublicProfileResponse Phase D fields -----------------------------------


def test_profile_includes_bio_and_zero_counts_by_default(client, session):
    _make_user(session, "alice@example.com", "alice")
    body = client.get("/api/social/users/alice").json()
    assert body["bio"] is None
    assert body["going_count_30d"] == 0
    assert body["mutual_subscribers"] == []
    assert body["mutual_subscribers_count"] == 0


def test_profile_going_count_30d_counts_only_public_recent(client, session):
    alice = _make_user(session, "alice@example.com", "alice")
    cal = _make_calendar(session)
    upcoming = _make_event(session, cal, days_from_now=5)
    past = _make_event(session, cal, days_from_now=-40)  # outside 30d window
    private = _make_event(session, cal, days_from_now=10)
    _mark_going(session, alice, upcoming, share_publicly=True)
    _mark_going(session, alice, past, share_publicly=True)
    _mark_going(session, alice, private, share_publicly=False)

    body = client.get("/api/social/users/alice").json()
    # Only the upcoming public Going row counts.
    assert body["going_count_30d"] == 1


def test_profile_going_count_hidden_when_attendance_private(client, session):
    alice = _make_user(
        session,
        "alice@example.com",
        "alice",
        visibility_attendance="private",
    )
    cal = _make_calendar(session)
    upcoming = _make_event(session, cal, days_from_now=5)
    _mark_going(session, alice, upcoming, share_publicly=True)
    body = client.get("/api/social/users/alice").json()
    assert body["going_count_30d"] == 0


def test_profile_mutual_subscribers_lists_overlap_with_viewer_network(client, session):
    # Topology: viewer subscribes to bob; bob subscribes to target.
    # So bob is a mutual subscriber of (viewer, target).
    viewer = _make_user(session, "viewer@example.com", "viewer")
    bob = _make_user(session, "bob@example.com", "bob")
    target = _make_user(session, "target@example.com", "target")
    _subscribe(session, viewer, bob)
    _subscribe(session, bob, target)

    _login(client, "viewer@example.com")
    body = client.get("/api/social/users/target").json()
    assert body["mutual_subscribers_count"] == 1
    handles = [u["handle"] for u in body["mutual_subscribers"]]
    assert handles == ["bob"]


def test_profile_mutual_subscribers_empty_for_anon(client, session):
    bob = _make_user(session, "bob@example.com", "bob")
    target = _make_user(session, "target@example.com", "target")
    _subscribe(session, bob, target)

    body = client.get("/api/social/users/target").json()
    assert body["mutual_subscribers_count"] == 0
    assert body["mutual_subscribers"] == []


# --- Profile content tabs: Going --------------------------------------------


def test_going_tab_lists_public_upcoming_only(client, session):
    alice = _make_user(session, "alice@example.com", "alice")
    cal = _make_calendar(session)
    upcoming = _make_event(session, cal, title="Future", days_from_now=3)
    past = _make_event(session, cal, title="Past", days_from_now=-2)
    private = _make_event(session, cal, title="Private", days_from_now=10)
    _mark_going(session, alice, upcoming, share_publicly=True)
    _mark_going(session, alice, past, share_publicly=True)
    _mark_going(session, alice, private, share_publicly=False)

    body = client.get("/api/social/users/alice/going").json()
    titles = [it["title"] for it in body["items"]]
    assert titles == ["Future"]
    assert body["total"] == 1


def test_going_tab_include_past(client, session):
    alice = _make_user(session, "alice@example.com", "alice")
    cal = _make_calendar(session)
    upcoming = _make_event(session, cal, title="Future", days_from_now=3)
    past = _make_event(session, cal, title="Past", days_from_now=-2)
    _mark_going(session, alice, upcoming, share_publicly=True)
    _mark_going(session, alice, past, share_publicly=True)

    body = client.get("/api/social/users/alice/going?include_past=1").json()
    # Past sorts newest-first when included; both should appear.
    assert {it["title"] for it in body["items"]} == {"Future", "Past"}


def test_going_tab_404_when_attendance_private(client, session):
    alice = _make_user(
        session,
        "alice@example.com",
        "alice",
        visibility_attendance="private",
    )
    cal = _make_calendar(session)
    ev = _make_event(session, cal, days_from_now=3)
    _mark_going(session, alice, ev)
    r = client.get("/api/social/users/alice/going")
    assert r.status_code == 404


# --- Saved tab --------------------------------------------------------------


def test_saved_tab_lists_upcoming(client, session):
    alice = _make_user(session, "alice@example.com", "alice")
    cal = _make_calendar(session)
    upcoming = _make_event(session, cal, title="Future", days_from_now=3)
    past = _make_event(session, cal, title="Past", days_from_now=-2)
    _save_event(session, alice, upcoming)
    _save_event(session, alice, past)

    body = client.get("/api/social/users/alice/saved").json()
    titles = [it["title"] for it in body["items"]]
    assert titles == ["Future"]


def test_saved_tab_404_when_saved_private(client, session):
    alice = _make_user(
        session, "alice@example.com", "alice", visibility_saved="private"
    )
    cal = _make_calendar(session)
    ev = _make_event(session, cal, days_from_now=3)
    _save_event(session, alice, ev)
    r = client.get("/api/social/users/alice/saved")
    assert r.status_code == 404


# --- Suggested tab ----------------------------------------------------------


def test_suggested_tab_lists_only_approved_with_event(client, session):
    alice = _make_user(session, "alice@example.com", "alice")
    cal = _make_calendar(session)
    approved_event = _make_event(session, cal, title="Approved", days_from_now=4)
    other_event = _make_event(session, cal, title="Other", days_from_now=5)
    # Approved suggestion linked to a real event.
    session.add(
        EventSuggestion(
            submitter_user_id=alice.id,
            title="t",
            start=approved_event.start,
            end=approved_event.end,
            status="approved",
            created_event_id=approved_event.event_id,
        )
    )
    # Pending suggestion — should NOT appear.
    session.add(
        EventSuggestion(
            submitter_user_id=alice.id,
            title="t2",
            start=other_event.start,
            end=other_event.end,
            status="pending",
            created_event_id=other_event.event_id,
        )
    )
    # Approved but no created_event_id — should NOT appear.
    session.add(
        EventSuggestion(
            submitter_user_id=alice.id,
            title="t3",
            start=other_event.start,
            end=other_event.end,
            status="approved",
            created_event_id=None,
        )
    )
    session.commit()

    body = client.get("/api/social/users/alice/suggested").json()
    titles = [it["title"] for it in body["items"]]
    assert titles == ["Approved"]


# --- Search -----------------------------------------------------------------


def test_search_users_matches_handle_prefix_and_name_parts(client, session):
    alice = _make_user(session, "alice@example.com", "alice")
    alice.display_name = "Alice Smith"
    session.add(alice)
    session.commit()
    _make_user(session, "alex@example.com", "alex")
    _make_user(session, "bob@example.com", "bob")
    body = client.get("/api/social/search/users?q=al").json()
    handles = sorted(u["handle"] for u in body["items"])
    assert handles == ["alex", "alice"]

    body = client.get("/api/social/search/users?q=smith").json()
    assert [u["handle"] for u in body["items"]] == ["alice"]


def test_search_users_excludes_fully_private_non_verified(client, session):
    # Post-refactor: ``account_visibility`` only has two values
    # (``public`` / ``friends``). Friends-only users remain
    # discoverable by handle search so people can find and follow them;
    # row-level content is still gated by the chokepoint. This test now
    # documents the looser behavior — anyone matching the query is
    # returned, verified or not.
    _make_user(
        session,
        "ghost@example.com",
        "ghost",
        account_visibility="friends",
    )
    body = client.get("/api/social/search/users?q=ghost").json()
    assert [x["handle"] for x in body["items"]] == ["ghost"]


def test_search_users_includes_verified_even_if_private(client, session):
    u = _make_user(
        session,
        "vorg@example.com",
        "vorg",
        account_visibility="friends",
    )
    u.is_verified_organizer = True
    session.add(u)
    session.commit()
    body = client.get("/api/social/search/users?q=vorg").json()
    assert [x["handle"] for x in body["items"]] == ["vorg"]


def test_curators_endpoint_lists_ranked_curators(client, session):
    alpha = _make_user(
        session,
        "alpha@example.com",
        "curatoralpha",
        is_admin_managed=True,
    )
    beta = _make_user(
        session,
        "beta@example.com",
        "curatorbeta",
        is_admin_managed=True,
        managed_label="Featured",
    )
    _make_user(session, "normal@example.com", "curatornormal")
    _subscribe(session, _make_user(session, "one@example.com", "one"), alpha)
    _subscribe(session, _make_user(session, "two@example.com", "two"), beta)
    _subscribe(session, _make_user(session, "three@example.com", "three"), beta)

    body = client.get("/api/social/curators?q=curator&limit=2").json()
    items = body["items"]
    assert [x["handle"] for x in items] == ["curatorbeta", "curatoralpha"]
    assert all(x["is_admin_managed"] is True for x in items)
    assert all(x["source"] == "curator" for x in items)


def test_curators_endpoint_excludes_followed_and_subscribed(client, session):
    viewer = _make_user(session, "viewer@example.com", "viewer")
    followed = _make_user(
        session,
        "followed@example.com",
        "followedcurator",
        is_admin_managed=True,
    )
    subscribed = _make_user(
        session,
        "subscribed@example.com",
        "subscribedcurator",
        is_admin_managed=True,
    )
    open_curator = _make_user(
        session,
        "open@example.com",
        "opencurator",
        is_admin_managed=True,
    )
    _follow(session, viewer, followed)
    _subscribe(session, viewer, subscribed)

    _login(client, "viewer@example.com")
    body = client.get(
        "/api/social/curators?exclude_followed=true&exclude_subscribed=true"
    ).json()
    assert [x["handle"] for x in body["items"]] == [open_curator.handle]


# --- Discover suggested (friends-of-friends) --------------------------------


def test_discover_suggested_anonymous_returns_empty(client):
    r = client.get("/api/social/discover/suggested")
    assert r.status_code == 200
    assert r.json()["items"] == []


def test_discover_suggested_without_network_returns_curators(client, session):
    _make_user(session, "viewer@example.com", "viewer")
    _make_user(
        session,
        "curator@example.com",
        "curator",
        is_admin_managed=True,
    )

    _login(client, "viewer@example.com")
    body = client.get("/api/social/discover/suggested").json()
    assert [(u["handle"], u["source"]) for u in body["items"]] == [
        ("curator", "curator")
    ]


def test_discover_suggested_without_network_excludes_opted_out_curators(
    client, session
):
    _make_user(session, "viewer@example.com", "viewer")
    _make_user(
        session,
        "curator@example.com",
        "curator",
        is_admin_managed=True,
        show_in_suggestions=False,
    )

    _login(client, "viewer@example.com")
    body = client.get("/api/social/discover/suggested").json()
    assert body["items"] == []


def test_discover_suggested_friends_of_friends(client, session):
    # viewer follows alice; alice follows charlie. Charlie should
    # surface for viewer (FoF), but alice should NOT (already in network).
    viewer = _make_user(session, "viewer@example.com", "viewer")
    alice = _make_user(session, "alice@example.com", "alice")
    charlie = _make_user(session, "charlie@example.com", "charlie")
    _follow(session, viewer, alice)
    _follow(session, alice, charlie)

    _login(client, "viewer@example.com")
    body = client.get("/api/social/discover/suggested").json()
    handles = [u["handle"] for u in body["items"]]
    assert "charlie" in handles
    assert "alice" not in handles
    assert "viewer" not in handles
    charlie = next(u for u in body["items"] if u["handle"] == "charlie")
    assert charlie["source"] == "network"


def test_discover_suggested_excludes_already_subscribed(client, session):
    viewer = _make_user(session, "viewer@example.com", "viewer")
    alice = _make_user(session, "alice@example.com", "alice")
    charlie = _make_user(session, "charlie@example.com", "charlie")
    _follow(session, viewer, alice)
    _follow(session, alice, charlie)
    _subscribe(session, viewer, charlie)  # already subscribed

    _login(client, "viewer@example.com")
    body = client.get("/api/social/discover/suggested").json()
    handles = [u["handle"] for u in body["items"]]
    assert "charlie" not in handles


def test_discover_suggested_excludes_opted_out_network_candidates(client, session):
    viewer = _make_user(session, "viewer@example.com", "viewer")
    alice = _make_user(session, "alice@example.com", "alice")
    hidden = _make_user(
        session,
        "hidden@example.com",
        "hidden",
        show_in_suggestions=False,
    )
    visible = _make_user(session, "visible@example.com", "visible")
    _follow(session, viewer, alice)
    _follow(session, alice, hidden)
    _follow(session, alice, visible)

    _login(client, "viewer@example.com")
    body = client.get("/api/social/discover/suggested").json()
    handles = [u["handle"] for u in body["items"]]
    assert "hidden" not in handles
    assert "visible" in handles
