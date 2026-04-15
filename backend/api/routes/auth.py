import logging

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from backend.api.deps import create_session_token, get_current_user
from backend.config.loader import get_admin_email, get_env_name, get_google_client_id

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/auth", tags=["auth"])

_COOKIE_NAME = "session_token"
_MAX_AGE = 60 * 60 * 24 * 7  # 7 days

_SAFE_ENV_NAMES = {"dev", "mock", "test", "qa"}


class GoogleLoginRequest(BaseModel):
    credential: str


def _is_dev_auth() -> bool:
    """True only when Google Client ID is not configured AND we're in a safe environment."""
    if get_google_client_id():
        return False
    env_name = get_env_name()
    if env_name not in _SAFE_ENV_NAMES:
        logger.warning(
            "GOOGLE_CLIENT_ID is not set in '%s' environment — login disabled. "
            "Set GOOGLE_CLIENT_ID to enable authentication.",
            env_name,
        )
        return False
    return True


def _set_session_cookie(response: JSONResponse, email: str, name: str) -> JSONResponse:
    token = create_session_token(email, name)
    response.set_cookie(
        key=_COOKIE_NAME,
        value=token,
        max_age=_MAX_AGE,
        httponly=True,
        samesite="lax",
        secure=False,  # Set True in production behind HTTPS
    )
    return response


@router.post("/google")
def login_with_google(body: GoogleLoginRequest):
    """Verify a Google ID token and set a session cookie."""
    admin_email = get_admin_email()

    # In dev mode (no Google Client ID), skip real Google verification
    if _is_dev_auth():
        email = admin_email or "admin@example.com"
        name = "Mock Admin"
        response = JSONResponse(content={"email": email, "name": name})
        return _set_session_cookie(response, email, name)

    # Real Google verification
    from google.auth.transport import requests as google_requests
    from google.oauth2 import id_token

    client_id = get_google_client_id()
    if not client_id:
        return JSONResponse(
            status_code=500, content={"detail": "Google Client ID not configured"}
        )

    try:
        idinfo = id_token.verify_oauth2_token(
            body.credential,
            google_requests.Request(),
            client_id,
        )
    except ValueError:
        return JSONResponse(status_code=401, content={"detail": "Invalid Google token"})

    email = idinfo.get("email", "")
    if admin_email and email != admin_email:
        return JSONResponse(status_code=403, content={"detail": "Not authorized"})

    name = idinfo.get("name", email)
    response = JSONResponse(content={"email": email, "name": name})
    return _set_session_cookie(response, email, name)


@router.get("/mode")
def auth_mode():
    """Return auth mode + Google client ID so frontend doesn't need its own env var."""
    dev = _is_dev_auth()
    return {
        "dev_auth": dev,
        "google_client_id": "" if dev else get_google_client_id(),
    }


@router.get("/me")
def get_me(user: dict = Depends(get_current_user)):
    """Return the current authenticated user."""
    return {"email": user["email"], "name": user["name"]}


@router.post("/logout")
def logout():
    """Clear the session cookie."""
    response = JSONResponse(content={"status": "logged out"})
    response.delete_cookie(key=_COOKIE_NAME)
    return response
