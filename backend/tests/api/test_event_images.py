"""Tests for the event picture pipeline and the admin picture routes."""

import io
from datetime import datetime, timedelta
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from backend.api.deps import require_admin
from backend.api.main import app
from backend.db.database import get_session
from backend.db.models import CachedEvent, CalendarSetting
from backend.services import event_images


def _png_bytes(width: int, height: int) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (width, height), (120, 40, 200)).save(buf, format="PNG")
    return buf.getvalue()


START = datetime(2030, 1, 1, 20, 0, 0)
END = START + timedelta(hours=4)


@pytest.fixture(autouse=True)
def _public_base_url(monkeypatch):
    """Pin the public base URL so generated URLs are deterministic."""
    monkeypatch.setenv("OBJECT_STORAGE_PUBLIC_BASE_URL", "https://cdn.test")


# ── Image processing ────────────────────────────────────────────────


def test_process_image_crops_thumb_to_16_9_and_caps_full_width():
    thumb_bytes, full_bytes = event_images.process_image(_png_bytes(2000, 1000))

    thumb = Image.open(io.BytesIO(thumb_bytes))
    full = Image.open(io.BytesIO(full_bytes))

    assert thumb.format == "WEBP"
    assert thumb.width == event_images.THUMB_WIDTH
    assert thumb.height == round(event_images.THUMB_WIDTH / event_images.THUMB_ASPECT)
    # Full variant keeps the source aspect ratio, only scaled down.
    assert full.width == event_images.FULL_MAX_WIDTH
    assert full.height == event_images.FULL_MAX_WIDTH // 2


def test_process_image_crops_portrait_without_distorting():
    thumb_bytes, _ = event_images.process_image(_png_bytes(600, 1600))
    thumb = Image.open(io.BytesIO(thumb_bytes))

    assert thumb.width == event_images.THUMB_WIDTH
    assert thumb.height == round(event_images.THUMB_WIDTH / event_images.THUMB_ASPECT)


def test_process_image_does_not_upscale_small_sources():
    _, full_bytes = event_images.process_image(_png_bytes(300, 200))
    full = Image.open(io.BytesIO(full_bytes))

    assert full.width == 300
    assert full.height == 200


def test_process_image_rejects_non_image_bytes():
    with pytest.raises(event_images.ImageValidationError):
        event_images.process_image(b"definitely not an image")


# ── URL import guards ───────────────────────────────────────────────


@pytest.mark.parametrize(
    "url",
    [
        "http://example.com/a.jpg",  # not https
        "ftp://example.com/a.jpg",
        "https://127.0.0.1/a.jpg",  # loopback
        "https://10.0.0.5/a.jpg",  # private range
        "https://169.254.169.254/latest/meta-data",  # link-local metadata
    ],
)
def test_fetch_remote_image_rejects_unsafe_urls(url):
    with pytest.raises(event_images.ImageValidationError):
        event_images.fetch_remote_image(url)


# ── Serialization precedence ────────────────────────────────────────


def test_event_image_fields_prefers_stored_key():
    event = CachedEvent(
        event_id="e1",
        calendar_id="c1",
        title="T",
        start=START,
        end=END,
        image_url="https://origin.example/legacy.jpg",
        image_key="events/e1/abc",
    )

    fields = event_images.event_image_fields(event)

    assert fields["image_url"] == "https://cdn.test/events/e1/abc/full.webp"
    assert fields["image_thumb_url"] == "https://cdn.test/events/e1/abc/thumb.webp"


def test_event_image_fields_falls_back_to_plain_url():
    event = CachedEvent(
        event_id="e1",
        calendar_id="c1",
        title="T",
        start=START,
        end=END,
        image_url="https://origin.example/legacy.jpg",
    )

    fields = event_images.event_image_fields(event)

    assert fields["image_url"] == "https://origin.example/legacy.jpg"
    assert fields["image_thumb_url"] is None


# ── Admin routes ────────────────────────────────────────────────────


@pytest.fixture
def admin_client():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)

    with Session(engine) as session:
        session.add(CalendarSetting(calendar_id="cal-1", name="Cal", enabled=True))
        session.add(
            CachedEvent(
                event_id="evt-1",
                calendar_id="cal-1",
                title="Picture Event",
                description="Public description",
                source_description=(
                    "Public description\n<<<EXTRACTOR_JSON>>>"
                    '{"image":"https://example.com/a.jpg"}'
                    "<<<END_EXTRACTOR_JSON>>>"
                ),
                start=START,
                end=END,
            )
        )
        session.commit()

    def _override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = _override
    app.dependency_overrides[require_admin] = lambda: {"email": "admin@example.com"}
    try:
        yield TestClient(app), engine
    finally:
        app.dependency_overrides.clear()
        SQLModel.metadata.drop_all(engine)


def test_upload_event_image_stores_key_and_returns_urls(admin_client):
    client, engine = admin_client

    with patch(
        "backend.api.routes.admin.store_event_image", return_value="events/evt-1/new"
    ) as store:
        res = client.post(
            "/api/admin/events/evt-1/image",
            files={"file": ("pic.png", _png_bytes(800, 600), "image/png")},
        )

    assert res.status_code == 200
    assert store.called
    body = res.json()
    assert body["image_thumb_url"] == "https://cdn.test/events/evt-1/new/thumb.webp"
    assert body["image_url"] == "https://cdn.test/events/evt-1/new/full.webp"

    with Session(engine) as session:
        assert session.get(CachedEvent, "evt-1").image_key == "events/evt-1/new"


def test_admin_event_response_includes_raw_source_description(admin_client):
    client, _ = admin_client

    response = client.get("/api/admin/events/evt-1")

    assert response.status_code == 200
    assert "<<<EXTRACTOR_JSON>>>" in response.json()["source_description"]


def test_upload_event_image_rejects_invalid_file(admin_client):
    client, engine = admin_client

    with patch(
        "backend.api.routes.admin.store_event_image",
        side_effect=event_images.ImageValidationError("Unsupported image type"),
    ):
        res = client.post(
            "/api/admin/events/evt-1/image",
            files={"file": ("notes.txt", b"hello", "text/plain")},
        )

    assert res.status_code == 400
    assert "Unsupported image type" in res.json()["detail"]
    with Session(engine) as session:
        assert session.get(CachedEvent, "evt-1").image_key is None


def test_upload_event_image_404_for_unknown_event(admin_client):
    client, _ = admin_client

    res = client.post(
        "/api/admin/events/missing/image",
        files={"file": ("pic.png", _png_bytes(10, 10), "image/png")},
    )

    assert res.status_code == 404


def test_set_event_image_from_url_rejects_unsafe_url(admin_client):
    client, _ = admin_client

    res = client.post(
        "/api/admin/events/evt-1/image/from-url",
        json={"url": "http://example.com/a.jpg"},
    )

    assert res.status_code == 400


def test_set_event_image_from_url_happy_path(admin_client):
    client, engine = admin_client

    with patch(
        "backend.api.routes.admin.replace_event_image_from_url",
        return_value="events/evt-1/from-url",
    ):
        res = client.post(
            "/api/admin/events/evt-1/image/from-url",
            json={"url": "https://example.com/a.jpg"},
        )

    assert res.status_code == 200
    with Session(engine) as session:
        assert session.get(CachedEvent, "evt-1").image_key == "events/evt-1/from-url"


def test_replacing_image_deletes_the_previous_objects(admin_client):
    client, engine = admin_client
    with Session(engine) as session:
        event = session.get(CachedEvent, "evt-1")
        event.image_key = "events/evt-1/old"
        session.add(event)
        session.commit()

    with (
        patch(
            "backend.api.routes.admin.store_event_image",
            return_value="events/evt-1/new",
        ),
        patch("backend.api.routes.admin.delete_event_image") as delete,
    ):
        res = client.post(
            "/api/admin/events/evt-1/image",
            files={"file": ("pic.png", _png_bytes(800, 600), "image/png")},
        )

    assert res.status_code == 200
    delete.assert_called_once_with("events/evt-1/old")


def test_delete_event_image_clears_key_and_removes_objects(admin_client):
    client, engine = admin_client
    with Session(engine) as session:
        event = session.get(CachedEvent, "evt-1")
        event.image_key = "events/evt-1/old"
        session.add(event)
        session.commit()

    with patch("backend.api.routes.admin.delete_event_image") as delete:
        res = client.delete("/api/admin/events/evt-1/image")

    assert res.status_code == 200
    delete.assert_called_once_with("events/evt-1/old")
    assert res.json()["image_thumb_url"] is None
    with Session(engine) as session:
        assert session.get(CachedEvent, "evt-1").image_key is None


@pytest.mark.parametrize(
    "method,path",
    [
        ("get", "/api/admin/events/evt-1"),
        ("post", "/api/admin/events/evt-1/block"),
        ("delete", "/api/admin/events/evt-1/block"),
        ("post", "/api/admin/events/evt-1/review"),
    ],
)
def test_admin_event_responses_carry_the_picture(admin_client, method, path):
    """The admin panel builds its editor state from these — losing the
    picture URLs there made the editor claim the event had no picture."""
    client, engine = admin_client
    with Session(engine) as session:
        event = session.get(CachedEvent, "evt-1")
        event.image_key = "events/evt-1/abc"
        session.add(event)
        session.commit()

    res = getattr(client, method)(path)

    assert res.status_code == 200
    body = res.json()
    assert body["image_url"] == "https://cdn.test/events/evt-1/abc/full.webp"
    assert body["image_thumb_url"] == "https://cdn.test/events/evt-1/abc/thumb.webp"
