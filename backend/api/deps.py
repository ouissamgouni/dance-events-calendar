import ipaddress
import logging
from uuid import UUID

from fastapi import Cookie, Depends, HTTPException, Request
from itsdangerous import BadSignature, URLSafeTimedSerializer
from sqlmodel import Session, select
from sqlalchemy import func

from backend.config.loader import (
    get_admin_email,
    get_session_secret,
    get_trusted_proxies,
)
from backend.db.database import get_session
from backend.db.models import User, UserFollow

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


def is_admin_user(user: User | None) -> bool:
    """True when ``user`` is the configured site admin.

    Single source of truth for admin identification — wraps the
    env-var-based ``ADMIN_EMAIL`` comparison so callers don't inline
    case-folded email checks.
    """
    if user is None or not user.email:
        return False
    admin_email = (get_admin_email() or "").lower()
    if not admin_email:
        return False
    return user.email.lower() == admin_email


def get_admin_user_id(session: Session) -> UUID | None:
    """Return the admin User's id, or None if no admin email configured
    or no matching user row exists yet.

    Used by public discovery surfaces to exclude the human admin
    account from search / FoF results. Returns None defensively so
    callers can no-op the exclusion in setups without an admin.
    """
    admin_email = (get_admin_email() or "").lower()
    if not admin_email:
        return None
    row = session.exec(
        select(User.id).where(func.lower(User.email) == admin_email)
    ).first()
    return row


def require_flag(name: str):
    """Dependency factory: 404 when the given site-setting boolean flag is off.

    Used to gate user-facing endpoints behind admin-controlled feature
    flags (``promo_codes_enabled``, ``organizer_claims_enabled``).
    Admin endpoints should not use this — admins must always be able to
    triage backlog after disabling a feature.
    """

    def _dep(session: Session = Depends(get_session)) -> None:
        from backend.db.models import SiteSetting

        row = session.get(SiteSetting, name)
        if not row or row.value.lower() != "true":
            raise HTTPException(status_code=404, detail="Not found")

    return _dep


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


# --- Social visibility chokepoint --------------------------------------------

# Account-level visibility (Instagram-style gate). Two values only — legacy
# ``private`` is coerced to ``friends`` at the migration boundary.
ACCOUNT_VISIBILITY_VALUES = ("public", "friends")
# 3-tier per-event audience tier (used by share_audience / saved.audience).
AUDIENCE_VALUES = ("public", "friends", "private")


def _account_visibility(owner: User) -> str:
    value = getattr(owner, "account_visibility", None)
    if value not in ACCOUNT_VISIBILITY_VALUES:
        return "friends"
    return value


def is_mutual_follow(session: Session, viewer_id: UUID, owner_id: UUID) -> bool:
    """True iff both ``viewer_id`` and ``owner_id`` follow each other.

    Phase E (E8): only ``status='approved'`` edges count toward
    mutuality. Pending follow-requests grant zero visibility.
    """
    if viewer_id == owner_id:
        return True
    rows = session.exec(
        select(UserFollow.follower_id, UserFollow.followee_id)
        .where(
            (
                (UserFollow.follower_id == viewer_id)
                & (UserFollow.followee_id == owner_id)
            )
            | (
                (UserFollow.follower_id == owner_id)
                & (UserFollow.followee_id == viewer_id)
            )
        )
        .where(UserFollow.status == "approved")
    ).all()
    return len(rows) >= 2


def can_view(
    session: Session,
    viewer: User | None,
    owner: User,
    scope: str | None = None,
) -> bool:
    """Return True if ``viewer`` is allowed to read ``owner``'s profile / lists.

    The ``scope`` parameter is accepted for backwards-compatibility but
    ignored — visibility is now governed by a single account-level gate
    (``owner.account_visibility``):

    - ``public``  — anyone (including anonymous) may read.
    - ``friends`` — only the owner and their mutual follows.

    Endpoints calling this helper should respond with **404** (not 403)
    when it returns False to avoid leaking the existence of restricted
    resources.
    """
    if viewer is not None and viewer.id == owner.id:
        return True
    visibility = _account_visibility(owner)
    if visibility == "public":
        return True
    # 'friends' — requires authenticated viewer with mutual follow.
    if viewer is None:
        return False
    return is_mutual_follow(session, viewer.id, owner.id)


def _audience_passes(
    session: Session,
    viewer: User | None,
    owner: User,
    audience: str,
) -> bool:
    """Apply a 3-tier per-event audience tier
    (``public``/``friends``/``private``)."""
    if audience not in AUDIENCE_VALUES:
        audience = "private"
    if viewer is not None and viewer.id == owner.id:
        return True
    if audience == "public":
        return True
    if audience == "private":
        return False
    if viewer is None:
        return False
    return is_mutual_follow(session, viewer.id, owner.id)


def can_view_event_in_calendar(
    session: Session,
    viewer: User | None,
    owner: User,
    event_audience: str,
) -> bool:
    """Decide whether a single event row should appear on ``owner``'s
    calendar to ``viewer``. Two-step gate:

        viewer must pass:
            event_audience  AND
            owner.account_visibility

    Owner is always allowed to see their own rows.
    """
    if viewer is not None and viewer.id == owner.id:
        return True
    return _audience_passes(session, viewer, owner, event_audience) and can_view(
        session, viewer, owner
    )
