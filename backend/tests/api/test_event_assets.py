"""Tests for private per-user event tickets and memories."""

import io
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from backend.api.deps import require_user
from backend.api.main import app
from backend.api.routes import event_assets as event_assets_routes
from backend.api.routes.auth import purge_user_account
from backend.db.database import get_session
from backend.db.models import (
    CachedEvent,
    EventUserAsset,
    SiteSetting,
    User,
    UserEventAttendance,
    UserFollow,
)
from backend.services import event_assets
from backend.services.image_processing import ImageValidationError

NOW = datetime.now(timezone.utc)


def _jpeg(width=1600, height=1200, gps=False) -> bytes:
    image = Image.new("RGB", (width, height), (200, 40, 80))
    buffer = io.BytesIO()
    if gps:
        exif = Image.Exif()
        exif.get_ifd(0x8825)[1] = "N"
        exif.get_ifd(0x8825)[2] = (48.0, 51.0, 24.0)
        image.save(buffer, format="JPEG", exif=exif)
    else:
        image.save(buffer, format="JPEG")
    return buffer.getvalue()


PDF = b"%PDF-1.4\n% test ticket\n"


@pytest.fixture
def storage():
    stored: dict[str, bytes] = {}
    with (
        patch.object(
            event_assets.object_storage, "get_client", return_value=MagicMock()
        ),
        patch.object(
            event_assets.object_storage,
            "put_private",
            side_effect=lambda key, data, ct, client=None: stored.__setitem__(
                key, data
            ),
        ),
        patch.object(
            event_assets.object_storage,
            "presigned_private_url",
            side_effect=lambda key, ttl, **kw: f"https://signed.test/{key}",
        ),
        patch.object(
            event_assets.object_storage, "get_private_bucket", return_value="priv"
        ),
        patch.object(event_assets.object_storage, "delete_prefix") as delete_prefix,
    ):
        yield stored, delete_prefix


@pytest.fixture
def env(storage):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as session:
        users = {
            name: User(email=f"{name}@example.com", display_name=name.title())
            for name in ("mia", "fred", "ana", "stan")
        }
        session.add_all(users.values())
        session.add(SiteSetting(key="event_tickets_enabled", value="true"))
        session.add(SiteSetting(key="event_memories_enabled", value="true"))
        session.add_all(
            [
                CachedEvent(
                    event_id="past",
                    calendar_id="c",
                    title="Past",
                    start=NOW - timedelta(days=3),
                    end=NOW - timedelta(days=3) + timedelta(hours=4),
                    review_status="approved",
                ),
                CachedEvent(
                    event_id="old",
                    calendar_id="c",
                    title="Old",
                    start=NOW - timedelta(days=60),
                    end=NOW - timedelta(days=60) + timedelta(hours=4),
                    review_status="approved",
                ),
                CachedEvent(
                    event_id="soon",
                    calendar_id="c",
                    title="Soon",
                    start=NOW + timedelta(days=7),
                    end=NOW + timedelta(days=7, hours=4),
                    review_status="approved",
                ),
            ]
        )
        session.commit()
        ids = {name: user.id for name, user in users.items()}
        for name, event_id in (
            ("mia", "past"),
            ("mia", "old"),
            ("mia", "soon"),
            ("ana", "past"),
        ):
            session.add(
                UserEventAttendance(
                    device_id=f"{name}-{event_id}", event_id=event_id, user_id=ids[name]
                )
            )
        for follower, followee in (("mia", "fred"), ("fred", "mia")):
            session.add(
                UserFollow(
                    follower_id=ids[follower],
                    followee_id=ids[followee],
                    status="approved",
                )
            )
        session.commit()

    current = {"id": ids["mia"]}

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


def _upload(client, event_id, kind, data, name="file.jpg", **form):
    return client.post(
        f"/api/events/{event_id}/assets",
        data={"kind": kind, **form},
        files={"file": (name, data, "application/octet-stream")},
    )


# ── Processing ──────────────────────────────────────────────────────


def test_process_memory_strips_exif_and_caps_long_edge():
    processed = event_assets.process_file(
        _jpeg(4000, 3000, gps=True), event_assets.KIND_MEMORY, 10 * 1024 * 1024
    )
    full = Image.open(io.BytesIO(processed.objects["full.webp"][0]))
    assert max(full.size) == event_assets.MEMORY_MAX_EDGE
    assert full.getexif() == {}


def test_process_rejects_html_and_pdf_memory():
    with pytest.raises(ImageValidationError):
        event_assets.process_file(b"<html><script>x</script>", "ticket", 1024 * 1024)
    with pytest.raises(ImageValidationError):
        event_assets.process_file(PDF, event_assets.KIND_MEMORY, 1024 * 1024)


def test_process_pdf_ticket_is_stored_untouched():
    processed = event_assets.process_file(PDF, event_assets.KIND_TICKET, 1024 * 1024)
    assert processed.objects == {"ticket.pdf": (PDF, "application/pdf")}


# ── Routes ──────────────────────────────────────────────────────────


def test_upload_ticket_happy_path_returns_signed_urls(env, storage):
    client, _, _, _ = env
    stored, _ = storage

    response = _upload(client, "soon", "ticket", PDF, name="pass.pdf")

    assert response.status_code == 200
    body = response.json()
    assert body["ticket_count"] == 1
    assert body["assets"][0]["file_url"].startswith("https://signed.test/event-assets/")
    assert any(key.endswith("/ticket.pdf") for key in stored)


def test_upload_requires_going(env):
    client, _, ids, current = env
    current["id"] = ids["stan"]

    response = _upload(client, "soon", "ticket", PDF)

    assert response.status_code == 403


def test_ticket_limit_is_enforced(env):
    client, engine, _, _ = env
    with Session(engine) as session:
        session.add(SiteSetting(key="event_assets_max_tickets", value="1"))
        session.commit()

    assert _upload(client, "soon", "ticket", PDF).status_code == 200
    response = _upload(client, "soon", "ticket", PDF)

    assert response.status_code == 409


def test_memory_only_inside_window(env):
    client, _, _, _ = env

    assert _upload(client, "soon", "memory", _jpeg()).status_code == 400
    assert _upload(client, "old", "memory", _jpeg()).status_code == 400
    assert _upload(client, "past", "memory", _jpeg()).status_code == 200


def test_oversized_upload_is_rejected(env):
    client, engine, _, _ = env
    with Session(engine) as session:
        session.add(SiteSetting(key="event_assets_max_ticket_mb", value="1"))
        session.commit()

    response = _upload(client, "soon", "ticket", PDF + b"0" * (2 * 1024 * 1024))

    assert response.status_code == 413


def test_feature_disabled_returns_404(env):
    client, engine, _, _ = env
    with Session(engine) as session:
        session.get(SiteSetting, "event_tickets_enabled").value = "false"
        session.get(SiteSetting, "event_memories_enabled").value = "false"
        session.commit()

    assert client.get("/api/events/soon/assets").status_code == 404


def test_tickets_off_memories_on(env):
    client, engine, _, _ = env
    ticket_id = _upload(client, "past", "ticket", PDF).json()["assets"][0]["id"]
    with Session(engine) as session:
        session.get(SiteSetting, "event_tickets_enabled").value = "false"
        session.commit()

    assert _upload(client, "soon", "ticket", PDF).status_code == 404
    assert client.delete(f"/api/event-assets/{ticket_id}").status_code == 404
    assert client.put("/api/events/soon/ticket-not-needed").status_code == 404
    body = _upload(client, "past", "memory", _jpeg()).json()
    assert [a["kind"] for a in body["assets"]] == ["memory"]
    assert body["can_add_ticket"] is False
    summary = client.post(
        "/api/me/event-assets/summary", json={"event_ids": ["past"]}
    ).json()
    assert summary["past"]["ticket_count"] == 0
    assert summary["past"]["memory_count"] == 1


def test_memories_off_tickets_on(env):
    client, engine, _, _ = env
    with Session(engine) as session:
        session.get(SiteSetting, "event_memories_enabled").value = "false"
        session.commit()

    assert _upload(client, "past", "memory", _jpeg()).status_code == 404
    body = _upload(client, "soon", "ticket", PDF).json()
    assert body["ticket_count"] == 1
    assert body["can_add_memory"] is False


def test_memory_visibility_by_viewer(env):
    client, _, ids, current = env
    for visibility in ("private", "friends", "attendees"):
        _upload(
            client, "past", "memory", _jpeg(), visibility=visibility, caption=visibility
        )

    def captions(viewer):
        current["id"] = ids[viewer]
        return sorted(
            a["caption"] for a in client.get("/api/events/past/assets").json()["assets"]
        )

    assert captions("mia") == ["attendees", "friends", "private"]
    assert captions("fred") == ["friends"]
    assert captions("ana") == ["attendees"]
    assert captions("stan") == []


def test_other_users_cannot_edit_or_delete(env):
    client, _, ids, current = env
    asset_id = _upload(client, "soon", "ticket", PDF).json()["assets"][0]["id"]
    current["id"] = ids["ana"]

    assert (
        client.patch(f"/api/event-assets/{asset_id}", json={"caption": "x"}).status_code
        == 404
    )
    assert client.delete(f"/api/event-assets/{asset_id}").status_code == 404


def test_summary_counts_and_thumbs(env):
    client, _, _, _ = env
    _upload(client, "soon", "ticket", PDF)
    _upload(client, "past", "memory", _jpeg())

    body = client.post(
        "/api/me/event-assets/summary", json={"event_ids": ["soon", "past", "old"]}
    ).json()

    assert body["soon"]["ticket_count"] == 1
    assert body["past"]["memory_count"] == 1
    assert body["past"]["memory_thumbs"][0]["thumb_url"].endswith("/thumb.webp")
    assert body["past"]["can_add_memory"] is True
    assert body["old"]["can_add_memory"] is False


# ── Lifecycle ───────────────────────────────────────────────────────


def test_sweep_removes_only_tickets_past_retention(env):
    _, engine, ids, _ = env
    with Session(engine) as session:
        for event_id, kind in (
            ("old", "ticket"),
            ("old", "memory"),
            ("past", "ticket"),
        ):
            session.add(
                EventUserAsset(
                    user_id=ids["mia"],
                    event_id=event_id,
                    kind=kind,
                    object_key=f"k/{event_id}/{kind}",
                )
            )
        session.add(
            EventUserAsset(
                user_id=ids["mia"],
                event_id="old",
                kind="ticket_link",
                url="https://x.test",
            )
        )
        session.commit()

        removed = event_assets.sweep_expired_tickets(session)

        left = {
            (a.event_id, a.kind) for a in session.exec(select(EventUserAsset)).all()
        }
    assert removed == 2
    assert left == {("old", "memory"), ("past", "ticket")}


def test_account_purge_deletes_assets(env, storage):
    _, engine, ids, _ = env
    _, delete_prefix = storage
    with Session(engine) as session:
        session.add(
            EventUserAsset(
                user_id=ids["mia"], event_id="past", kind="memory", object_key="k"
            )
        )
        session.commit()

        with patch("backend.api.routes.auth.delete_user_avatar"):
            purge_user_account(session, ids["mia"])
        session.commit()

        assert session.exec(select(EventUserAsset)).all() == []
    delete_prefix.assert_any_call(f"event-assets/{ids['mia']}/", "priv")
