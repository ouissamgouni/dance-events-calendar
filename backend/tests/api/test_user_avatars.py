"""Tests for managed user avatar processing and authenticated routes."""

import io
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from backend.api.deps import require_user
from backend.api.main import app
from backend.api.routes.auth import purge_user_account
from backend.db.database import get_session
from backend.db.models import User
from backend.services import user_avatars
from backend.services.image_processing import ImageValidationError


def _png_bytes(width: int, height: int) -> bytes:
    output = io.BytesIO()
    Image.new("RGB", (width, height), (30, 120, 200)).save(output, format="PNG")
    return output.getvalue()


@pytest.fixture(autouse=True)
def _public_base_url(monkeypatch):
    monkeypatch.setenv("OBJECT_STORAGE_PUBLIC_BASE_URL", "https://cdn.test")


@pytest.fixture
def authenticated_client():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as session:
        user = User(
            email="dancer@example.com",
            display_name="Test Dancer",
            avatar_url="https://provider.test/avatar.jpg",
        )
        session.add(user)
        session.commit()
        session.refresh(user)
        user_id = user.id

    def _session_override():
        with Session(engine) as session:
            yield session

    def _user_override():
        with Session(engine) as session:
            return session.get(User, user_id)

    app.dependency_overrides[get_session] = _session_override
    app.dependency_overrides[require_user] = _user_override
    try:
        yield TestClient(app), engine, user_id
    finally:
        app.dependency_overrides.clear()
        SQLModel.metadata.drop_all(engine)


def test_process_avatar_renders_square_webp():
    rendered = user_avatars.process_avatar(_png_bytes(1200, 600))
    image = Image.open(io.BytesIO(rendered))

    assert image.format == "WEBP"
    assert image.size == (user_avatars.AVATAR_SIZE, user_avatars.AVATAR_SIZE)
    assert image.getexif() == {}


def test_process_avatar_rejects_non_image_bytes():
    with pytest.raises(ImageValidationError):
        user_avatars.process_avatar(b"not an image")


def test_upload_avatar_persists_key_and_returns_managed_url(authenticated_client):
    client, engine, user_id = authenticated_client

    with (
        patch(
            "backend.api.routes.auth.store_user_avatar",
            return_value=f"users/{user_id}/avatar/new",
        ) as store,
        patch("backend.api.routes.auth.delete_user_avatar") as delete,
    ):
        response = client.post(
            "/api/auth/me/avatar",
            files={"file": ("avatar.png", _png_bytes(800, 600), "image/png")},
        )

    assert response.status_code == 200
    assert response.json() == {
        "avatar_url": f"https://cdn.test/users/{user_id}/avatar/new/avatar.webp",
        "has_custom_avatar": True,
    }
    store.assert_called_once()
    delete.assert_called_once_with(None)
    with Session(engine) as session:
        assert session.get(User, user_id).avatar_key == f"users/{user_id}/avatar/new"


def test_upload_avatar_rejects_invalid_file(authenticated_client):
    client, engine, user_id = authenticated_client

    with patch(
        "backend.api.routes.auth.store_user_avatar",
        side_effect=ImageValidationError(
            "Only JPEG, PNG and WebP images are supported"
        ),
    ):
        response = client.post(
            "/api/auth/me/avatar",
            files={"file": ("avatar.txt", b"bad", "text/plain")},
        )

    assert response.status_code == 400
    with Session(engine) as session:
        assert session.get(User, user_id).avatar_key is None


def test_delete_avatar_restores_provider_fallback(authenticated_client):
    client, engine, user_id = authenticated_client
    with Session(engine) as session:
        user = session.get(User, user_id)
        user.avatar_key = f"users/{user_id}/avatar/old"
        session.add(user)
        session.commit()

    with patch("backend.api.routes.auth.delete_user_avatar") as delete:
        response = client.delete("/api/auth/me/avatar")

    assert response.status_code == 200
    assert response.json() == {
        "avatar_url": "https://provider.test/avatar.jpg",
        "has_custom_avatar": False,
    }
    delete.assert_called_once_with(f"users/{user_id}/avatar/old")
    with Session(engine) as session:
        assert session.get(User, user_id).avatar_key is None


def test_account_purge_deletes_managed_avatar(authenticated_client):
    _client, engine, user_id = authenticated_client
    avatar_key = f"users/{user_id}/avatar/custom"
    with Session(engine) as session:
        user = session.get(User, user_id)
        user.avatar_key = avatar_key
        session.add(user)
        session.commit()

        with patch("backend.api.routes.auth.delete_user_avatar") as delete:
            purge_user_account(session, user_id)
            session.commit()

        delete.assert_called_once_with(avatar_key)
        purged = session.get(User, user_id)
        assert purged.avatar_key is None
        assert purged.avatar_url is None
