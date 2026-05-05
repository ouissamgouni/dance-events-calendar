"""Tests for auth routes and deps."""

import pytest
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

from backend.api.main import app
from backend.api.deps import create_session_token, require_admin, get_current_user


@pytest.mark.unit
class TestAuthDeps:
    def test_create_and_verify_session_token(self):
        token = create_session_token("admin@example.com", "Admin User")
        assert isinstance(token, str)
        assert len(token) > 0

    def test_get_current_user_no_cookie(self):
        client = TestClient(app)
        resp = client.get("/api/auth/me")
        assert resp.status_code == 401

    def test_get_current_user_valid_cookie(self):
        token = create_session_token("admin@example.com", "Admin")
        client = TestClient(app, cookies={"session_token": token})
        resp = client.get("/api/auth/me")
        assert resp.status_code == 200
        data = resp.json()
        assert data["email"] == "admin@example.com"
        assert data["name"] == "Admin"

    def test_get_current_user_invalid_cookie(self):
        client = TestClient(app, cookies={"session_token": "garbage.token.value"})
        resp = client.get("/api/auth/me")
        assert resp.status_code == 401


@pytest.mark.unit
class TestAuthRoutes:
    @patch("backend.api.routes.auth._is_dev_auth", return_value=True)
    def test_login_dev_mode(self, _mock):
        """In dev auth mode, login should succeed without real Google verification."""
        client = TestClient(app)
        resp = client.post("/api/auth/google", json={"credential": "anything"})
        assert resp.status_code == 200
        data = resp.json()
        assert "email" in data
        assert "session_token" in resp.cookies

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
        }
        client = TestClient(app)
        resp = client.post("/api/auth/google", json={"credential": "valid-token"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["email"] == "admin@example.com"
        assert "session_token" in resp.cookies

    @patch("backend.api.routes.auth._is_dev_auth", return_value=False)
    @patch(
        "backend.api.routes.auth.get_google_client_id", return_value="test-client-id"
    )
    @patch("backend.api.routes.auth.get_admin_email", return_value="admin@example.com")
    @patch("google.oauth2.id_token.verify_oauth2_token")
    def test_login_wrong_email(self, mock_verify, _admin, _cid, _dev):
        mock_verify.return_value = {
            "email": "other@example.com",
            "name": "Other",
        }
        client = TestClient(app)
        resp = client.post("/api/auth/google", json={"credential": "valid-token"})
        assert resp.status_code == 403

    @patch("backend.api.routes.auth._is_dev_auth", return_value=False)
    @patch(
        "backend.api.routes.auth.get_google_client_id", return_value="test-client-id"
    )
    @patch(
        "google.oauth2.id_token.verify_oauth2_token",
        side_effect=ValueError("bad token"),
    )
    def test_login_invalid_token(self, _verify, _cid, _dev):
        client = TestClient(app)
        resp = client.post("/api/auth/google", json={"credential": "bad-token"})
        assert resp.status_code == 401

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
