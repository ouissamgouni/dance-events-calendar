import ipaddress
import logging
from uuid import UUID

from fastapi import Cookie, Depends, HTTPException, Request
from itsdangerous import BadSignature, URLSafeTimedSerializer
from sqlmodel import Session, select

from backend.config.loader import (
    get_admin_email,
    get_session_secret,
    get_trusted_proxies,
)
from backend.db.database import get_session
from backend.db.models import User

logger = logging.getLogger(__name__)

_MAX_AGE = 60 * 60 * 24 * 7  # 7 days


def _get_serializer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(get_session_secret())


def _decode_session(session_token: str | None) -> dict | None:
    if not session_token:
        return None
    try:
        return _get_serializer().loads(session_token, max_age=_MAX_AGE)
    except BadSignature:
        return None


def get_current_user(session_token: str | None = Cookie(default=None)) -> dict:
    """Decode session cookie and return user dict, or raise 401."""
    data = _decode_session(session_token)
    if data is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return data


def get_current_user_optional(
    session_token: str | None = Cookie(default=None),
    session: Session = Depends(get_session),
) -> User | None:
    """Return the authenticated User row, or None if anonymous / token invalid.

    Looks the user up by ``user_id`` in the cookie payload. Returns None if the
    cookie is missing/invalid OR the user no longer exists (e.g. account
    deleted but cookie still cached).
    """
    data = _decode_session(session_token)
    if not data:
        return None
    user_id = data.get("user_id")
    if not user_id:
        return None
    try:
        user_uuid = UUID(str(user_id))
    except (ValueError, TypeError):
        return None
    user = session.get(User, user_uuid)
    if user is None or user.deleted_at is not None:
        return None
    return user


def require_user(user: User | None = Depends(get_current_user_optional)) -> User:
    """Require an authenticated end-user. Distinct from ``require_admin``."""
    if user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user


def require_admin(user: dict = Depends(get_current_user)) -> dict:
    """Require that the current user is the admin."""
    admin_email = get_admin_email()
    if not admin_email or user.get("email") != admin_email:
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


def create_session_token(
    email: str, name: str, user_id: str | None = None, is_admin: bool = False
) -> str:
    s = _get_serializer()
    payload: dict = {"email": email, "name": name}
    if user_id is not None:
        payload["user_id"] = user_id
    if is_admin:
        payload["is_admin"] = True
    return s.dumps(payload)


def get_client_ip(request: Request) -> str:
    """Extract the real client IP, respecting TRUSTED_PROXIES for X-Forwarded-For."""
    client_host = request.client.host if request.client else "127.0.0.1"
    trusted = get_trusted_proxies()
    if not trusted:
        return client_host

    # Check if the direct client is a trusted proxy
    try:
        client_addr = ipaddress.ip_address(client_host)
    except ValueError:
        return client_host

    is_trusted = any(
        client_addr in ipaddress.ip_network(cidr, strict=False) for cidr in trusted
    )
    if not is_trusted:
        return client_host

    forwarded_for = request.headers.get("x-forwarded-for")
    if forwarded_for:
        # Return the leftmost (original client) IP
        return forwarded_for.split(",")[0].strip()

    return client_host
