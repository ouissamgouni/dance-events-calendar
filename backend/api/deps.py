import ipaddress
import logging

from fastapi import Cookie, Depends, HTTPException, Request
from itsdangerous import BadSignature, URLSafeTimedSerializer

from backend.config.loader import (
    get_admin_email,
    get_session_secret,
    get_trusted_proxies,
)

logger = logging.getLogger(__name__)

_MAX_AGE = 60 * 60 * 24 * 7  # 7 days


def _get_serializer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(get_session_secret())


def get_current_user(session_token: str | None = Cookie(default=None)) -> dict:
    """Decode session cookie and return user dict, or raise 401."""
    if not session_token:
        raise HTTPException(status_code=401, detail="Not authenticated")

    s = _get_serializer()
    try:
        data = s.loads(session_token, max_age=_MAX_AGE)
    except BadSignature:
        raise HTTPException(status_code=401, detail="Invalid or expired session")

    return data


def require_admin(user: dict = Depends(get_current_user)) -> dict:
    """Require that the current user is the admin."""
    admin_email = get_admin_email()
    if not admin_email or user.get("email") != admin_email:
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


def create_session_token(email: str, name: str) -> str:
    s = _get_serializer()
    return s.dumps({"email": email, "name": name})


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
