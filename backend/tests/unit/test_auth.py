"""Tests for auth routes and deps."""

import pytest
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from backend.api.main import app
from backend.api.deps import create_session_token
from backend.db.database import get_session


def _sqlite_session_override():
    """Build a get_session override backed by a fresh in-memory SQLite DB.

    Returns ``(override, engine)`` so callers can keep a reference to the engine
    if they need to inspect or seed it.
    """
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)

    def _override():
        with Session(engine) as s:
            yield s

    return _override, engine


@pytest.mark.unit
class TestAuthDeps:
    def test_create_and_verify_session_token(self):
        token = create_session_token("admin@example.com", "Admin User")
        assert isinstance(token, str)
        assert len(token) > 0

    def test_get_current_user_no_cookie(self):
        override, _ = _sqlite_session_override()
        app.dependency_overrides[get_session] = override
        try:
            client = TestClient(app)
            resp = client.get("/api/auth/me")
            assert resp.status_code == 401
        finally:
            app.dependency_overrides.clear()

    def test_get_current_user_valid_cookie(self):
        # /api/auth/me now requires a DB-backed user row that matches the
        # cookie's user_id, so we seed the user first then sign a cookie for it.
        from uuid import uuid4
        from backend.db.models import User

        override, engine = _sqlite_session_override()
        user_id = uuid4()
        with Session(engine) as s:
            s.add(User(id=user_id, email="admin@example.com", display_name="Admin"))
            s.commit()

        token = create_session_token("admin@example.com", "Admin", user_id=str(user_id))
        app.dependency_overrides[get_session] = override
        try:
            client = TestClient(app, cookies={"session_token": token})
            resp = client.get("/api/auth/me")
            assert resp.status_code == 200
            data = resp.json()
            assert data["email"] == "admin@example.com"
            assert data["name"] == "Admin"
        finally:
            app.dependency_overrides.clear()

    def test_get_current_user_invalid_cookie(self):
        override, _ = _sqlite_session_override()
        app.dependency_overrides[get_session] = override
        try:
            client = TestClient(app, cookies={"session_token": "garbage.token.value"})
            resp = client.get("/api/auth/me")
            assert resp.status_code == 401
        finally:
            app.dependency_overrides.clear()


@pytest.mark.unit
class TestAuthRoutes:
    @patch("backend.api.routes.auth._is_dev_auth", return_value=True)
    def test_login_dev_mode(self, _mock):
        """In dev auth mode, login should succeed without real Google verification."""
        override, _ = _sqlite_session_override()
        app.dependency_overrides[get_session] = override
        try:
            client = TestClient(app)
            resp = client.post("/api/auth/google", json={"credential": "anything"})
            assert resp.status_code == 200
            data = resp.json()
            assert "email" in data
            assert "session_token" in resp.cookies
        finally:
            app.dependency_overrides.clear()

    @patch("backend.api.routes.auth._is_dev_auth", return_value=False)
    @patch(
        "backend.api.routes.auth.get_google_client_id", return_value="test-client-id"
    )
    @patch("backend.api.routes.auth.get_admin_email", return_value="admin@example.com")
    @patch("google.oauth2.id_token.verify_oauth2_token")
    def test_login_success(self, mock_verify, _admin, _cid, _dev):
        mock_verify.return_value = {
            "email": "admin@example.com",
            "name": "Admin User",
            "sub": "google-sub-1",
        }
        override, _ = _sqlite_session_override()
        app.dependency_overrides[get_session] = override
        try:
            client = TestClient(app)
            resp = client.post("/api/auth/google", json={"credential": "valid-token"})
            assert resp.status_code == 200
            data = resp.json()
            assert data["email"] == "admin@example.com"
            assert data["is_admin"] is True
            assert "session_token" in resp.cookies
        finally:
            app.dependency_overrides.clear()

    @patch("backend.api.routes.auth._is_dev_auth", return_value=False)
    @patch(
        "backend.api.routes.auth.get_google_client_id", return_value="test-client-id"
    )
    @patch("backend.api.routes.auth.get_admin_email", return_value="admin@example.com")
    @patch("google.oauth2.id_token.verify_oauth2_token")
    def test_login_non_admin_user(self, mock_verify, _admin, _cid, _dev):
        """Non-admin emails now succeed (regular user) but is_admin is False."""
        mock_verify.return_value = {
            "email": "other@example.com",
            "name": "Other",
            "sub": "google-sub-2",
        }
        override, _ = _sqlite_session_override()
        app.dependency_overrides[get_session] = override
        try:
            client = TestClient(app)
            resp = client.post("/api/auth/google", json={"credential": "valid-token"})
            assert resp.status_code == 200
            data = resp.json()
            assert data["email"] == "other@example.com"
            assert data["is_admin"] is False
        finally:
            app.dependency_overrides.clear()

    @patch("backend.api.routes.auth._is_dev_auth", return_value=False)
    @patch(
        "backend.api.routes.auth.get_google_client_id", return_value="test-client-id"
    )
    @patch(
        "google.oauth2.id_token.verify_oauth2_token",
        side_effect=ValueError("bad token"),
    )
    def test_login_invalid_token(self, _verify, _cid, _dev):
        override, _ = _sqlite_session_override()
        app.dependency_overrides[get_session] = override
        try:
            client = TestClient(app)
            resp = client.post("/api/auth/google", json={"credential": "bad-token"})
            assert resp.status_code == 401
        finally:
            app.dependency_overrides.clear()

    def test_logout_clears_cookie(self):
        token = create_session_token("admin@example.com", "Admin")
        client = TestClient(app, cookies={"session_token": token})
        resp = client.post("/api/auth/logout")
        assert resp.status_code == 200
        assert resp.json()["status"] == "logged out"

@pytest.mark.unit
class TestAdminProtection:
    def test_toggle_requires_auth(self):
        """Admin toggle endpoint should return 401 without auth."""
        from unittest.mock import MagicMock
        from sqlmodel import Session
        from backend.api.deps import require_admin
        from backend.db.database import get_session

        app.dependency_overrides.pop(require_admin, None)
        app.dependency_overrides[get_session] = lambda: MagicMock(spec=Session)
        try:
            client = TestClient(app)
            resp = client.post(
                "/api/admin/calendars/cal-1/toggle",
                json={"enabled": True},
            )
            assert resp.status_code == 401
        finally:
            app.dependency_overrides.pop(get_session, None)

    def test_most_viewed_requires_auth(self):
        """Admin most-viewed endpoint should return 401 without auth."""
        from unittest.mock import MagicMock
        from sqlmodel import Session
        from backend.api.deps import require_admin
        from backend.db.database import get_session

        app.dependency_overrides.pop(require_admin, None)
        app.dependency_overrides[get_session] = lambda: MagicMock(spec=Session)
        try:
            client = TestClient(app)
            resp = client.get("/api/admin/most-viewed-events")
            assert resp.status_code == 401
        finally:
            app.dependency_overrides.pop(get_session, None)
