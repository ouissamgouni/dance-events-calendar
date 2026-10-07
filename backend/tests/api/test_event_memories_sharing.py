"""Privacy matrix for shared event memories: event page, summary, friend
passport and notifications must never leak beyond the visibility rules."""

import io
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from pydantic import BaseModel
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from backend.api.deps import require_user
from backend.api.main import app
from backend.api.routes import event_assets as event_assets_routes
from backend.api.routes.auth import purge_user_account
from backend.api.schemas import SharedPassportResponse
from backend.db.database import get_session
from backend.db.models import (
    CachedEvent,
    EventUserAsset,
    Notification,
    SiteSetting,
    User,
    UserEventAttendance,
    UserFollow,
)
from backend.services import event_assets
from backend.services.notifications import (
    EVENT_MEMORIES_SHARED,
    SUBSCRIPTION_MEMORIES,
    sync_memory_notifications,
)

NOW = datetime.now(timezone.utc)
CAST = ("sara", "fred", "fiona", "alex", "olga", "pat")
GOING = ("sara", "fred", "alex")


def _jpeg() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (64, 48), (10, 120, 200)).save(buffer, format="JPEG")
    return buffer.getvalue()


@pytest.fixture
def env():
    with (
        patch.object(
            event_assets.object_storage, "get_client", return_value=MagicMock()
        ),
        patch.object(event_assets.object_storage, "put_private"),
        patch.object(
            event_assets.object_storage,
            "presigned_private_url",
            side_effect=lambda key, ttl, **kw: f"https://signed.test/{key}",
        ),
        patch.object(
            event_assets.object_storage, "get_private_bucket", return_value="priv"
        ),
        patch.object(event_assets.object_storage, "delete_prefix"),
    ):
        engine = create_engine(
            "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
        )
        SQLModel.metadata.create_all(engine)
        with Session(engine) as session:
            users = {
                name: User(
                    email=f"{name}@example.com",
                    display_name=name.title(),
                    handle=name,
                    passport_visibility="friends",
                    passport_show_timeline=True,
                )
                for name in CAST
            }
            session.add_all(users.values())
            session.add(SiteSetting(key="event_memories_enabled", value="true"))
            for event_id in ("gala", "other"):
                session.add(
                    CachedEvent(
                        event_id=event_id,
                        calendar_id="c",
                        title=event_id.title(),
                        start=NOW - timedelta(days=2),
                        end=NOW - timedelta(days=2) + timedelta(hours=4),
                        review_status="approved",
                    )
                )
            session.commit()
            ids = {name: user.id for name, user in users.items()}
            for name in GOING:
                session.add(
                    UserEventAttendance(
                        device_id=f"{name}-gala",
                        event_id="gala",
                        user_id=ids[name],
                        share_audience="friends" if name == "sara" else "public",
                    )
                )
            for a, b in (
                ("sara", "fred"),
                ("fred", "sara"),
                ("sara", "fiona"),
                ("fiona", "sara"),
                ("pat", "sara"),
            ):
                session.add(
                    UserFollow(
                        follower_id=ids[a], followee_id=ids[b], status="approved"
                    )
                )
            session.commit()

        current = {"id": ids["sara"]}

        def _session_override():
            with Session(engine) as session:
                yield session

        def _user_override():
            with Session(engine) as session:
                return session.get(User, current["id"])

        app.dependency_overrides[get_session] = _session_override
        app.dependency_overrides[require_user] = _user_override
        event_assets_routes.limiter.enabled = False
        try:
            yield TestClient(app), engine, ids, current
        finally:
            event_assets_routes.limiter.enabled = True
            app.dependency_overrides.clear()
            SQLModel.metadata.drop_all(engine)


def _share(client, visibility, caption=None, event_id="gala"):
    response = client.post(
        f"/api/events/{event_id}/assets",
        data={
            "kind": "memory",
            "visibility": visibility,
            "caption": caption or visibility,
        },
        files={"file": ("m.jpg", _jpeg(), "application/octet-stream")},
    )
    assert response.status_code == 200, response.text
    return next(
        a for a in response.json()["assets"] if a["caption"] == (caption or visibility)
    )


def _share_all(env):
    client, _, ids, current = env
    current["id"] = ids["sara"]
    return {v: _share(client, v)["id"] for v in ("private", "friends", "attendees")}


def _as(env, name):
    _, _, ids, current = env
    current["id"] = ids[name]


def _rows(engine, kind):
    with Session(engine) as session:
        return list(session.exec(select(Notification).where(Notification.kind == kind)))


def _recipients(engine, ids, kind):
    by_id = {v: k for k, v in ids.items()}
    return sorted(by_id[r.recipient_user_id] for r in _rows(engine, kind))


# ── Event page ──────────────────────────────────────────────────────

EXPECTED_EVENT_PAGE = {
    "sara": ["attendees", "friends", "private"],
    "fred": ["attendees", "friends"],
    "fiona": ["attendees", "friends"],
    "alex": ["attendees"],
    "olga": [],
    "pat": [],
}


def test_event_page_matrix_never_leaks_hidden_assets(env):
    client = env[0]
    asset_ids = _share_all(env)
    for viewer, expected in EXPECTED_EVENT_PAGE.items():
        _as(env, viewer)
        response = client.get("/api/events/gala/assets")
        body = response.json()
        captions = sorted(a["caption"] for a in body["assets"])
        assert captions == expected, viewer
        hidden = [asset_ids[v] for v in asset_ids if v not in expected]
        for asset_id in hidden:
            assert asset_id not in response.text, (viewer, asset_id)
        assert "object_key" not in response.text
        if viewer != "sara":
            assert body["memory_count"] == 0


def test_owner_identity_fields(env):
    client = env[0]
    _share_all(env)
    _as(env, "fred")
    fred_view = client.get("/api/events/gala/assets").json()["assets"]
    assert {(a["owner_handle"], a["owner_is_friend"]) for a in fred_view} == {
        ("sara", True)
    }
    _as(env, "alex")
    alex_view = client.get("/api/events/gala/assets").json()["assets"]
    assert [(a["owner_handle"], a["owner_is_friend"]) for a in alex_view] == [
        ("sara", False)
    ]


def test_owner_no_longer_going_hides_everything(env):
    client, engine, ids, _ = env
    _share_all(env)
    with Session(engine) as session:
        row = session.exec(
            select(UserEventAttendance).where(
                UserEventAttendance.user_id == ids["sara"]
            )
        ).one()
        session.delete(row)
        session.commit()
    for viewer in ("fred", "fiona", "alex"):
        _as(env, viewer)
        assert client.get("/api/events/gala/assets").json()["assets"] == []


def test_unfriending_narrows_visibility(env):
    client, engine, ids, _ = env
    _share_all(env)
    _as(env, "fred")
    assert client.delete("/api/social/users/sara/follow").status_code == 200
    # Fred is still Going, so only the attendee-level photo remains.
    assert [
        a["caption"] for a in client.get("/api/events/gala/assets").json()["assets"]
    ] == ["attendees"]
    _as(env, "fiona")
    assert client.delete("/api/social/users/sara/follow").status_code == 200
    assert client.get("/api/events/gala/assets").json()["assets"] == []


def test_cannot_touch_someone_elses_memory(env):
    client = env[0]
    asset_ids = _share_all(env)
    _as(env, "fred")
    for asset_id in asset_ids.values():
        assert (
            client.patch(
                f"/api/event-assets/{asset_id}", json={"visibility": "private"}
            ).status_code
            == 404
        )
        assert client.delete(f"/api/event-assets/{asset_id}").status_code == 404


def test_invalid_visibility_rejected(env):
    client = env[0]
    _as(env, "sara")
    response = client.post(
        "/api/events/gala/assets",
        data={"kind": "memory", "visibility": "public"},
        files={"file": ("m.jpg", _jpeg(), "application/octet-stream")},
    )
    assert response.status_code == 422


# ── Summary chip ────────────────────────────────────────────────────


def test_summary_shared_count_only_counts_visible(env):
    client = env[0]
    _share_all(env)
    expected = {"sara": 0, "fred": 2, "alex": 1}
    for viewer, count in expected.items():
        _as(env, viewer)
        body = client.post(
            "/api/me/event-assets/summary", json={"event_ids": ["gala"]}
        ).json()
        assert body["gala"]["shared_memory_count"] == count, viewer
        thumbs = body["gala"]["memory_thumbs"]
        assert all(t["visibility"] for t in thumbs)
        if viewer != "sara":
            assert thumbs == []


# ── Friend passport ─────────────────────────────────────────────────


def _friend_summary(client, event_ids=("gala",), handle="sara"):
    return client.post(
        f"/api/social/users/{handle}/event-assets/summary",
        json={"event_ids": list(event_ids)},
    )


def test_friend_passport_matrix(env):
    client = env[0]
    asset_ids = _share_all(env)
    for viewer in ("fred", "fiona"):
        _as(env, viewer)
        response = _friend_summary(client)
        assert response.status_code == 200
        assert response.json()["gala"]["memory_count"] == 2
        assert asset_ids["private"] not in response.text
    for viewer in ("alex", "olga", "pat", "sara"):
        _as(env, viewer)
        assert _friend_summary(client).json() == {}, viewer


@pytest.mark.parametrize(
    "field,value",
    [("passport_visibility", "private"), ("passport_show_timeline", False)],
)
def test_friend_passport_respects_owner_settings(env, field, value):
    client, engine, ids, _ = env
    _share_all(env)
    with Session(engine) as session:
        sara = session.get(User, ids["sara"])
        setattr(sara, field, value)
        session.add(sara)
        session.commit()
    _as(env, "fred")
    assert _friend_summary(client).json() == {}


def test_friend_passport_skips_events_owner_did_not_attend(env):
    client, engine, ids, _ = env
    _share_all(env)
    with Session(engine) as session:
        session.add(
            EventUserAsset(
                user_id=ids["sara"],
                event_id="other",
                kind="memory",
                object_key="k",
                visibility="friends",
            )
        )
        session.commit()
    _as(env, "fred")
    body = _friend_summary(client, ("gala", "other", "missing")).json()
    assert set(body) == {"gala"}


def test_friend_passport_requires_sign_in_and_caps_ids(env):
    client = env[0]
    _as(env, "fred")
    assert _friend_summary(client, [f"e{i}" for i in range(201)]).status_code == 422
    assert _friend_summary(client, handle="nobody").status_code == 404
    app.dependency_overrides.pop(require_user)
    assert _friend_summary(client).status_code == 401


def test_shared_passport_link_schema_has_no_memory_fields():
    def names(model: type[BaseModel], seen: set) -> set:
        if model in seen:
            return set()
        seen.add(model)
        found = set()
        for name, field in model.model_fields.items():
            found.add(name)
            for arg in getattr(field.annotation, "__args__", ()) + (field.annotation,):
                if isinstance(arg, type) and issubclass(arg, BaseModel):
                    found |= names(arg, seen)
        return found

    leaked = {
        n
        for n in names(SharedPassportResponse, set())
        if any(word in n for word in ("memor", "asset"))
    }
    assert leaked == set()


# ── Notifications ───────────────────────────────────────────────────


def test_private_upload_notifies_nobody(env):
    client, engine, _, _ = env
    _as(env, "sara")
    _share(client, "private")
    assert _rows(engine, SUBSCRIPTION_MEMORIES) == []
    assert _rows(engine, EVENT_MEMORIES_SHARED) == []


def test_friends_upload_notifies_only_friends(env):
    client, engine, ids, _ = env
    _as(env, "sara")
    _share(client, "friends")
    assert _recipients(engine, ids, SUBSCRIPTION_MEMORIES) == ["fiona", "fred"]
    assert _rows(engine, EVENT_MEMORIES_SHARED) == []


def test_attendee_upload_adds_anonymous_summary_for_non_friends(env):
    client, engine, ids, _ = env
    _share_all(env)
    assert _recipients(engine, ids, SUBSCRIPTION_MEMORIES) == ["fiona", "fred"]
    assert _recipients(engine, ids, EVENT_MEMORIES_SHARED) == ["alex"]
    (row,) = _rows(engine, EVENT_MEMORIES_SHARED)
    assert row.actor_user_id == ids["alex"]

    _as(env, "alex")
    feed = client.get("/api/notifications")
    assert feed.status_code == 200
    assert str(ids["sara"]) not in feed.text
    assert "Sara" not in feed.text and '"sara"' not in feed.text


def test_more_uploads_do_not_add_or_realert(env):
    client, engine, ids, _ = env
    _as(env, "sara")
    _share(client, "attendees", caption="one")
    before = {
        (r.id, r.recipient_user_id)
        for kind in (SUBSCRIPTION_MEMORIES, EVENT_MEMORIES_SHARED)
        for r in _rows(engine, kind)
    }
    with Session(engine) as session:
        for row in session.exec(select(Notification)).all():
            row.pushed_at = NOW
            session.add(row)
        session.commit()
    _share(client, "attendees", caption="two")
    _share(client, "friends", caption="three")
    after_rows = [
        r
        for kind in (SUBSCRIPTION_MEMORIES, EVENT_MEMORIES_SHARED)
        for r in _rows(engine, kind)
    ]
    assert {(r.id, r.recipient_user_id) for r in after_rows} == before
    assert all(r.pushed_at is not None for r in after_rows)


def test_narrowing_and_deleting_withdraw_notifications(env):
    client, engine, ids, _ = env
    asset_ids = _share_all(env)

    client.patch(
        f"/api/event-assets/{asset_ids['attendees']}", json={"visibility": "friends"}
    )
    assert _rows(engine, EVENT_MEMORIES_SHARED) == []
    assert _recipients(engine, ids, SUBSCRIPTION_MEMORIES) == ["fiona", "fred"]

    for key in ("friends", "attendees"):
        client.patch(
            f"/api/event-assets/{asset_ids[key]}", json={"visibility": "private"}
        )
    assert _rows(engine, SUBSCRIPTION_MEMORIES) == []

    client.patch(
        f"/api/event-assets/{asset_ids['friends']}", json={"visibility": "attendees"}
    )
    assert _recipients(engine, ids, EVENT_MEMORIES_SHARED) == ["alex"]
    client.delete(f"/api/event-assets/{asset_ids['friends']}")
    assert _rows(engine, SUBSCRIPTION_MEMORIES) == []
    assert _rows(engine, EVENT_MEMORIES_SHARED) == []


def test_sharer_leaving_event_withdraws(env):
    _, engine, ids, _ = env
    _share_all(env)
    with Session(engine) as session:
        row = session.exec(
            select(UserEventAttendance).where(
                UserEventAttendance.user_id == ids["sara"]
            )
        ).one()
        session.delete(row)
        sync_memory_notifications(session, ids["sara"], "gala")
        session.commit()
    assert _rows(engine, SUBSCRIPTION_MEMORIES) == []
    assert _rows(engine, EVENT_MEMORIES_SHARED) == []


def test_unfollow_withdraws_friend_notification(env):
    client, engine, ids, _ = env
    _share_all(env)
    _as(env, "fred")
    client.delete("/api/social/users/sara/follow")
    assert _recipients(engine, ids, SUBSCRIPTION_MEMORIES) == ["fiona"]


def test_purge_withdraws_attendee_summary(env):
    _, engine, ids, _ = env
    _share_all(env)
    with Session(engine) as session:
        with patch("backend.api.routes.auth.delete_user_avatar"):
            purge_user_account(session, ids["sara"])
        session.commit()
    assert _rows(engine, SUBSCRIPTION_MEMORIES) == []
    assert _rows(engine, EVENT_MEMORIES_SHARED) == []


def test_feature_off_creates_no_notifications(env):
    _, engine, ids, _ = env
    with Session(engine) as session:
        session.add(
            EventUserAsset(
                user_id=ids["sara"],
                event_id="gala",
                kind="memory",
                object_key="k",
                visibility="attendees",
            )
        )
        session.get(SiteSetting, "event_memories_enabled").value = "false"
        session.commit()
        sync_memory_notifications(session, ids["sara"], "gala")
        session.commit()
    assert _rows(engine, SUBSCRIPTION_MEMORIES) == []
    assert _rows(engine, EVENT_MEMORIES_SHARED) == []
