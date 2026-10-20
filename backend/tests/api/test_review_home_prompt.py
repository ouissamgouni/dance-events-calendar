"""Home review prompt (frequency caps, admin force, attribution) + similar events."""

import os
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

os.environ.setdefault("SESSION_SECRET", "test-secret-for-review-home-prompt")
os.environ.setdefault("ADMIN_EMAIL", "admin@example.com")
os.environ["DEV_AUTH"] = "true"

from backend.api.main import app  # noqa: E402
from backend.api.routes import auth as auth_module  # noqa: E402
from backend.api.routes import ratings as ratings_module  # noqa: E402
from backend.db.database import get_session  # noqa: E402
from backend.db.models import (  # noqa: E402
    CachedEvent,
    CalendarSetting,
    EventRating,
    EventSeries,
    EventSeriesMember,
    EventTag,
    Notification,
    ReviewPromptForce,
    ReviewPromptImpression,
    Tag,
    TagGroup,
    User,
    UserEventAttendance,
)

NOW = datetime.now(timezone.utc)
PARIS = (48.8566, 2.3522)
VERSAILLES = (48.8049, 2.1204)  # ~18 km from Paris
LYON = (45.764, 4.8357)  # ~390 km from Paris


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
        s.add(CalendarSetting(calendar_id="cal-1", name="Cal", enabled=True))
        s.commit()
        yield s


@pytest.fixture
def client(engine):
    def _override():
        with Session(engine) as s:
            yield s

    app.dependency_overrides[get_session] = _override
    auth_module.limiter.reset()
    ratings_module.limiter.reset()
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


@pytest.fixture
def styles(session):
    grp = TagGroup(slug="dance-style", label="Dance style")
    session.add(grp)
    session.commit()
    salsa = Tag(group_id=grp.id, slug="salsa", label="Salsa")
    session.add(salsa)
    session.commit()
    on2 = Tag(group_id=grp.id, slug="mambo", label="On2", parent_tag_id=salsa.id)
    bachata = Tag(group_id=grp.id, slug="bachata", label="Bachata")
    session.add_all([on2, bachata])
    session.commit()
    return {"salsa": salsa.id, "on2": on2.id, "bachata": bachata.id}


def _login(client: TestClient, email: str = "user@example.com") -> None:
    resp = client.post(
        "/api/auth/google", json={"credential": "ignored", "mock_email": email}
    )
    assert resp.status_code == 200


def _me(session: Session, email: str = "user@example.com") -> User:
    return session.exec(select(User).where(User.email == email)).first()


def _event(
    session: Session,
    event_id: str,
    *,
    ended_hours_ago: float = -48,
    where=PARIS,
    reach=None,
    tags=(),
) -> CachedEvent:
    end = NOW - timedelta(hours=ended_hours_ago)
    ev = CachedEvent(
        event_id=event_id,
        calendar_id="cal-1",
        title=event_id,
        start=end - timedelta(hours=4),
        end=end,
        latitude=where[0],
        longitude=where[1],
        city="Paris",
        reach=reach,
        review_status="reviewed",
    )
    session.add(ev)
    for tag_id in tags:
        session.add(EventTag(event_id=event_id, tag_id=tag_id))
    session.commit()
    return ev


def _attend(session: Session, user: User, event_id: str) -> None:
    session.add(
        UserEventAttendance(
            device_id=f"dev-{event_id}", event_id=event_id, user_id=user.id
        )
    )
    session.commit()


def _impression(session, user, event_id, *, hours_ago, outcome="dismissed"):
    session.add(
        ReviewPromptImpression(
            user_id=user.id,
            event_id=event_id,
            shown_at=NOW - timedelta(hours=hours_ago),
            outcome=outcome,
        )
    )
    session.commit()


# ── Home prompt ──────────────────────────────────────────────────────


@pytest.mark.unit
def test_prompt_picks_latest_attended_then_cooldown_hides_it(client, session):
    _login(client)
    me = _me(session)
    _event(session, "ev-older", ended_hours_ago=72)
    _event(session, "ev-latest", ended_hours_ago=10)
    _event(session, "ev-too-fresh", ended_hours_ago=1)
    for eid in ("ev-older", "ev-latest", "ev-too-fresh"):
        _attend(session, me, eid)

    body = client.get("/api/users/me/review-prompt").json()
    assert body["prompt"]["event_id"] == "ev-latest"
    assert body["forced"] is False
    assert body["pending_total"] == 3

    resp = client.post(
        "/api/users/me/review-prompt/ev-latest/impression", json={"outcome": "shown"}
    )
    assert resp.status_code == 204
    assert client.get("/api/users/me/review-prompt").json()["prompt"] is None


@pytest.mark.unit
def test_prompt_respects_max_impressions_and_event_age(client, session):
    _login(client)
    me = _me(session)
    _event(session, "ev-capped", ended_hours_ago=24 * 5)
    _event(session, "ev-old", ended_hours_ago=24 * 20)
    _attend(session, me, "ev-capped")
    _attend(session, me, "ev-old")
    _impression(session, me, "ev-capped", hours_ago=24 * 4)
    _impression(session, me, "ev-capped", hours_ago=24 * 3.5)

    assert client.get("/api/users/me/review-prompt").json()["prompt"] is None


@pytest.mark.unit
def test_fatigue_pause_after_consecutive_ignores(client, session):
    _login(client)
    me = _me(session)
    for i in range(4):
        _event(session, f"ev-ignored-{i}", ended_hours_ago=24 * 13)
        _attend(session, me, f"ev-ignored-{i}")
    _event(session, "ev-new", ended_hours_ago=10)
    _attend(session, me, "ev-new")
    for i in range(4):
        _impression(session, me, f"ev-ignored-{i}", hours_ago=24 * (12 - i))

    assert client.get("/api/users/me/review-prompt").json()["prompt"] is None

    for row in session.exec(select(ReviewPromptImpression)).all():
        row.shown_at = row.shown_at - timedelta(days=40)
        session.add(row)
    session.commit()
    assert (
        client.get("/api/users/me/review-prompt").json()["prompt"]["event_id"]
        == "ev-new"
    )


@pytest.mark.unit
def test_admin_force_bypasses_cooldown_even_with_channels_off(client, session):
    _login(client)
    me = _me(session)
    me.email_review_prompt_enabled = False
    me.push_review_prompt_enabled = False
    session.add(me)
    session.commit()
    _event(session, "ev-forced", ended_hours_ago=24 * 30)
    _event(session, "ev-recent", ended_hours_ago=10)
    _attend(session, me, "ev-forced")
    _attend(session, me, "ev-recent")
    _impression(session, me, "ev-recent", hours_ago=1, outcome="shown")
    user_id = str(me.id)

    _login(client, "admin@example.com")
    resp = client.post(
        "/api/admin/notifications/review-prompt/send-now",
        json={
            "event_id": "ev-forced",
            "user_ids": [user_id],
            "channels": ["home"],
        },
    )
    assert resp.status_code == 200
    assert resp.json()["home_prompt_forced"] == 1
    assert resp.json()["in_app_created"] == 0
    assert resp.json()["results"][0]["status"] == "sent"
    assert resp.json()["results"][0]["channels"] == ["home"]
    assert session.exec(select(Notification)).all() == []

    _login(client)
    body = client.get("/api/users/me/review-prompt").json()
    assert body["prompt"]["event_id"] == "ev-forced"
    assert body["forced"] is True


@pytest.mark.unit
def test_send_now_dry_run_previews_without_side_effects(client, session, monkeypatch):
    sent: list = []
    monkeypatch.setattr(
        "backend.services.email.send_event_review_prompt_email",
        lambda u, e, friend_proof=None: sent.append(u.email) or True,
    )
    monkeypatch.setattr(
        "backend.services.push_service.send_push", lambda *a, **k: sent.append(a) or 1
    )
    _login(client)
    me = _me(session)
    _event(session, "ev-a", ended_hours_ago=10)
    _attend(session, me, "ev-a")
    user_id = str(me.id)

    _login(client, "admin@example.com")
    payload = {
        "event_id": "ev-a",
        "user_ids": [user_id],
        "channels": ["app", "email", "home"],
    }
    preview = client.post(
        "/api/admin/notifications/review-prompt/send-now",
        json={**payload, "dry_run": True},
    ).json()
    assert preview["dry_run"] is True
    assert (preview["in_app_created"], preview["emailed"], preview["pushed"]) == (
        1,
        1,
        0,
    )
    assert preview["home_prompt_forced"] == 1
    assert preview["results"][0]["channels"] == ["home", "app", "email"]
    assert sent == []
    session.expire_all()
    assert session.exec(select(Notification)).all() == []
    assert session.exec(select(ReviewPromptForce)).all() == []

    real = client.post(
        "/api/admin/notifications/review-prompt/send-now", json=payload
    ).json()
    assert real["results"][0]["channels"] == ["home", "app", "email"]
    assert sent == ["user@example.com"]  # push not selected

    rows = client.get("/api/admin/events/ev-a/review-prompt-candidates").json()
    cand = rows["candidates"][0]
    assert cand["notification"]["emailed_at"] is not None
    assert cand["home"]["forced_until"] is not None
    assert rows["home_warning"] is None


@pytest.mark.unit
def test_candidates_home_warning(client, session):
    _event(session, "ev-fresh", ended_hours_ago=1)
    _event(session, "ev-ancient", ended_hours_ago=24 * 200)
    _login(client, "admin@example.com")
    get = lambda eid: client.get(  # noqa: E731
        f"/api/admin/events/{eid}/review-prompt-candidates"
    ).json()["home_warning"]
    assert get("ev-fresh") == "too_recent"
    assert get("ev-ancient") == "too_old"


@pytest.mark.unit
def test_review_records_entry_point_and_closes_prompt_loop(client, session):
    _login(client)
    me = _me(session)
    _event(session, "ev-done", ended_hours_ago=10)
    _attend(session, me, "ev-done")
    session.add(
        ReviewPromptForce(
            user_id=me.id, event_id="ev-done", expires_at=NOW + timedelta(days=1)
        )
    )
    session.commit()
    client.post(
        "/api/users/me/review-prompt/ev-done/impression", json={"outcome": "shown"}
    )

    resp = client.post(
        "/api/events/ev-done/feedback",
        json={"overall_sentiment": "great", "entry_point": "home-prompt"},
    )
    assert resp.status_code == 201

    session.expire_all()
    assert session.exec(select(EventRating)).one().entry_point == "home-prompt"
    assert session.exec(select(ReviewPromptImpression)).one().outcome == "reviewed"
    assert session.exec(select(ReviewPromptForce)).all() == []
    assert client.get("/api/users/me/review-prompt").json()["prompt"] is None


@pytest.mark.unit
def test_impression_rejected_for_unattended_event(client, session):
    _login(client)
    _event(session, "ev-stranger", ended_hours_ago=10)
    resp = client.post(
        "/api/users/me/review-prompt/ev-stranger/impression", json={"outcome": "shown"}
    )
    assert resp.status_code == 404


@pytest.mark.unit
def test_admin_stats_and_settings(client, session):
    _login(client)
    me = _me(session)
    _event(session, "ev-a", ended_hours_ago=10)
    _impression(session, me, "ev-a", hours_ago=30, outcome="dismissed")
    _impression(session, me, "ev-a", hours_ago=2, outcome="reviewed")
    session.add(
        EventRating(event_id="ev-a", user_id=me.id, stars=4, entry_point="home-prompt")
    )
    session.commit()

    _login(client, "admin@example.com")
    stats = client.get("/api/admin/review-prompt/stats?days=30").json()
    assert (stats["shown"], stats["dismissed"], stats["reviewed"]) == (2, 1, 1)
    assert stats["reviews_by_entry_point"] == [{"key": "home-prompt", "count": 1}]

    resp = client.put("/api/settings", json={"review_home_prompt_cooldown_hours": 12})
    assert resp.status_code == 200
    assert client.get("/api/settings").json()["review_home_prompt_cooldown_hours"] == 12


# ── Similar events ───────────────────────────────────────────────────


@pytest.mark.unit
def test_similar_local_event_stays_within_radius_and_style(client, session, styles):
    _login(client)
    _event(session, "ev-src", ended_hours_ago=10, tags=[styles["salsa"], styles["on2"]])
    _event(
        session,
        "ev-near",
        ended_hours_ago=-48,
        where=VERSAILLES,
        tags=[styles["salsa"], styles["on2"]],
    )
    _event(
        session,
        "ev-far",
        ended_hours_ago=-48,
        where=LYON,
        tags=[styles["salsa"], styles["on2"]],
    )
    _event(session, "ev-other-style", ended_hours_ago=-48, tags=[styles["bachata"]])
    _event(session, "ev-past", ended_hours_ago=5, tags=[styles["on2"]])

    body = client.get("/api/events/ev-src/similar").json()
    assert body["event_ids"] == ["ev-near"]
    assert body["style_tag_ids"] == [styles["on2"]]
    assert body["reach_filter"] == "any"
    assert body["area"]["radius_km"] == 25


@pytest.mark.unit
def test_similar_events_flag_defaults_on_and_disables_rail(client, session, styles):
    _login(client)
    me = _me(session)
    _event(session, "ev-src", ended_hours_ago=10, tags=[styles["salsa"]])
    _attend(session, me, "ev-src")
    _event(
        session,
        "ev-near",
        ended_hours_ago=-48,
        where=VERSAILLES,
        tags=[styles["salsa"]],
    )
    settings = client.get("/api/settings").json()
    assert settings["review_home_prompt_enabled"] is True
    assert settings["similar_events_enabled"] is True
    assert client.get("/api/users/me/review-prompt").json()["similar_count"] == 1

    _login(client, "admin@example.com")
    resp = client.put("/api/settings", json={"similar_events_enabled": False})
    assert resp.status_code == 200
    _login(client)
    assert client.get("/api/events/ev-src/similar").json()["event_ids"] == []
    assert client.get("/api/users/me/review-prompt").json()["similar_count"] == 0


@pytest.mark.unit
def test_similar_widens_to_parent_style_and_filters_reach(client, session, styles):
    _login(client)
    _event(
        session,
        "ev-src",
        ended_hours_ago=10,
        reach="regional",
        tags=[styles["salsa"], styles["on2"]],
    )
    _event(
        session,
        "ev-family",
        ended_hours_ago=-48,
        where=VERSAILLES,
        reach="regional",
        tags=[styles["salsa"]],
    )
    _event(
        session,
        "ev-local",
        ended_hours_ago=-48,
        where=VERSAILLES,
        reach="local",
        tags=[styles["salsa"]],
    )

    body = client.get("/api/events/ev-src/similar").json()
    assert body["event_ids"] == ["ev-family"]
    assert body["reach_filter"] == "regional_plus"
    assert body["area"]["radius_km"] == 150


@pytest.mark.unit
def test_similar_sentiment_pins_or_drops_same_series(client, session, styles):
    _login(client)
    _event(session, "ev-src", ended_hours_ago=10, tags=[styles["salsa"]])
    _event(session, "ev-other", ended_hours_ago=-24, tags=[styles["salsa"]])
    _event(session, "ev-next-edition", ended_hours_ago=-24 * 7, tags=[styles["salsa"]])
    series = EventSeries(status="resolved")
    session.add(series)
    session.commit()
    session.add_all(
        [
            EventSeriesMember(series_id=series.id, event_id="ev-src"),
            EventSeriesMember(series_id=series.id, event_id="ev-next-edition"),
        ]
    )
    session.commit()

    loved = client.get("/api/events/ev-src/similar?sentiment=amazing").json()
    assert loved["event_ids"] == ["ev-next-edition", "ev-other"]
    disliked = client.get("/api/events/ev-src/similar?sentiment=bad").json()
    assert disliked["event_ids"] == ["ev-other"]
