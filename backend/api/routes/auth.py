import logging
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Optional

import yaml
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlmodel import Session, delete, select

from backend.api.deps import (
    create_session_token,
    require_user,
)
from backend.api.schemas import UpdatePreferencesRequest
from backend.config.loader import (
    get_admin_email,
    get_dev_auth_enabled,
    get_env_name,
    get_google_client_id,
)
from backend.db.database import get_session
from backend.db.models import (
    EventRating,
    ShareToken,
    User,
    UserEventAttendance,
    UserSavedEvent,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/auth", tags=["auth"])

limiter = Limiter(key_func=get_remote_address)

_COOKIE_NAME = "session_token"
_MAX_AGE = 60 * 60 * 24 * 7  # 7 days

_SECURE_ENV_NAMES = {"staging", "production"}


class GoogleLoginRequest(BaseModel):
    credential: str
    device_id: Optional[str] = None
    # Dev-only: pick which mock user to log in as. Ignored (and rejected with
    # 400) when DEV_AUTH is not enabled — closes the "log in as anyone"
    # hole in production.
    mock_email: Optional[str] = None
    mock_name: Optional[str] = None


_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_DEFAULT_MOCK_EMAIL = "dev-user@example.com"
_DEFAULT_MOCK_NAME = "Dev User"


def _is_dev_auth() -> bool:
    """True when DEV_AUTH=true — replaces Google OAuth with selectable mock logins."""
    if not get_dev_auth_enabled():
        return False
    if get_google_client_id():
        logger.warning(
            "DEV_AUTH is enabled but GOOGLE_CLIENT_ID is also set — "
            "dev login will be used and Google OAuth will be ignored."
        )
    return True


def _is_admin_email(email: str) -> bool:
    admin = get_admin_email()
    return bool(admin) and email == admin


def _set_session_cookie(
    response: JSONResponse, user: User, is_admin: bool
) -> JSONResponse:
    token = create_session_token(
        email=user.email,
        name=user.display_name or user.email,
        user_id=str(user.id),
        is_admin=is_admin,
    )
    secure = get_env_name() in _SECURE_ENV_NAMES
    response.set_cookie(
        key=_COOKIE_NAME,
        value=token,
        max_age=_MAX_AGE,
        httponly=True,
        samesite="none" if secure else "lax",
        secure=secure,
    )
    return response


def _upsert_user_from_claims(
    session: Session,
    *,
    email: str,
    name: str,
    picture: Optional[str],
    provider_subject: Optional[str],
) -> tuple[User, bool]:
    """Find an existing user by Google subject (preferred) or email; else create.

    Returns (user, is_new_user) so the caller can distinguish first-time signup
    from a repeat login (used for analytics — `signup_completed` vs `login_completed`).
    """
    user: Optional[User] = None
    if provider_subject:
        user = session.exec(
            select(User).where(User.provider_subject == provider_subject)
        ).first()
    if user is None:
        user = session.exec(select(User).where(User.email == email)).first()

    now = datetime.utcnow()
    is_new_user = user is None
    if user is None:
        user = User(
            email=email,
            display_name=name,
            avatar_url=picture,
            provider="google",
            provider_subject=provider_subject,
            last_login_at=now,
        )
        session.add(user)
    else:
        # Reactivate a soft-deleted account on re-login.
        user.deleted_at = None
        if provider_subject and not user.provider_subject:
            user.provider_subject = provider_subject
        if name and not user.display_name:
            user.display_name = name
        if picture:
            user.avatar_url = picture
        user.last_login_at = now
        session.add(user)

    session.commit()
    session.refresh(user)
    return user, is_new_user


def _merge_device_data(session: Session, user: User, device_id: Optional[str]) -> None:
    """Attribute anonymous device-keyed rows to this user (idempotent, conflict-safe)."""
    if not device_id:
        return

    # Saved events: claim rows for this device that have no user yet. On
    # event-id conflict with rows already owned by this user, drop the
    # device-only row (keep the older user-owned one).
    existing_event_ids = set(
        session.exec(
            select(UserSavedEvent.event_id).where(UserSavedEvent.user_id == user.id)
        ).all()
    )
    saved_rows = session.exec(
        select(UserSavedEvent).where(
            UserSavedEvent.device_id == device_id,
            UserSavedEvent.user_id.is_(None),
        )
    ).all()
    for row in saved_rows:
        if row.event_id in existing_event_ids:
            session.delete(row)
        else:
            row.user_id = user.id
            session.add(row)
            existing_event_ids.add(row.event_id)

    existing_attending_ids = set(
        session.exec(
            select(UserEventAttendance.event_id).where(
                UserEventAttendance.user_id == user.id
            )
        ).all()
    )
    attending_rows = session.exec(
        select(UserEventAttendance).where(
            UserEventAttendance.device_id == device_id,
            UserEventAttendance.user_id.is_(None),
        )
    ).all()
    for row in attending_rows:
        if row.event_id in existing_attending_ids:
            session.delete(row)
        else:
            row.user_id = user.id
            session.add(row)
            existing_attending_ids.add(row.event_id)

    # Share token: if the user already owns one, keep it. Otherwise claim the
    # device's token; on conflict drop the device-only token.
    user_share = session.exec(
        select(ShareToken).where(ShareToken.user_id == user.id)
    ).first()
    device_share = session.exec(
        select(ShareToken).where(
            ShareToken.device_id == device_id, ShareToken.user_id.is_(None)
        )
    ).first()
    if device_share is not None:
        if user_share is None:
            device_share.user_id = user.id
            session.add(device_share)
        else:
            session.delete(device_share)

    session.commit()


@router.post("/google")
@limiter.limit("10/minute")
def login_with_google(
    request: Request,
    body: GoogleLoginRequest,
    session: Session = Depends(get_session),
):
    """Verify a Google ID token, upsert the user, merge anon data, set the cookie."""
    if not _is_dev_auth() and (body.mock_email or body.mock_name):
        # Defence in depth: never accept caller-chosen identities outside dev mode.
        return JSONResponse(
            status_code=400,
            content={
                "detail": "mock_email/mock_name are only allowed when DEV_AUTH=true"
            },
        )

    if _is_dev_auth():
        # Dev path: skip Google verification. Identity is picked by the caller
        # (mock_email) so scenarios can have several distinct mock users; default
        # to a generic non-admin user so a one-click login is never admin.
        email = (body.mock_email or _DEFAULT_MOCK_EMAIL).strip().lower()
        if not _EMAIL_RE.match(email):
            return JSONResponse(
                status_code=400, content={"detail": "Invalid mock_email"}
            )
        name = body.mock_name or email.split("@", 1)[0]
        picture = None
        provider_subject = f"mock|{email}"
    else:
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
            return JSONResponse(
                status_code=401, content={"detail": "Invalid Google token"}
            )
        email = idinfo.get("email", "")
        if not email:
            return JSONResponse(
                status_code=400, content={"detail": "Email missing from Google token"}
            )
        name = idinfo.get("name") or email
        picture = idinfo.get("picture")
        provider_subject = idinfo.get("sub")

    user, is_new_user = _upsert_user_from_claims(
        session,
        email=email,
        name=name,
        picture=picture,
        provider_subject=provider_subject,
    )
    _merge_device_data(session, user, body.device_id)

    is_admin = _is_admin_email(user.email)
    response = JSONResponse(
        content={
            "user_id": str(user.id),
            "email": user.email,
            "name": user.display_name or user.email,
            "avatar_url": user.avatar_url,
            "is_admin": is_admin,
            "is_new_user": is_new_user,
            "share_attendance_default": user.share_attendance_default,
        }
    )
    return _set_session_cookie(response, user, is_admin)


@router.get("/mode")
def auth_mode():
    """Return auth mode + Google client ID so frontend doesn't need its own env var."""
    dev = _is_dev_auth()
    return {
        "dev_auth": dev,
        "google_client_id": "" if dev else get_google_client_id(),
    }


def _load_mock_users_from_scenario() -> list[dict]:
    """Load scenarios/<name>/mock-users.yaml if SCENARIO_DIR is set.

    File shape:
        users:
          - email: alice@example.com
            name: Alice
          - email: admin@example.com
            name: Admin
    Returns [] if not configured / file missing / malformed.
    """
    scenario_dir = os.getenv("SCENARIO_DIR")
    if not scenario_dir:
        return []
    path = Path(scenario_dir) / "mock-users.yaml"
    if not path.exists():
        return []
    try:
        with open(path) as f:
            data = yaml.safe_load(f) or {}
    except (OSError, yaml.YAMLError):
        logger.warning("Failed to load %s", path, exc_info=True)
        return []
    raw = data.get("users") or []
    out: list[dict] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        email = (entry.get("email") or "").strip().lower()
        if not _EMAIL_RE.match(email):
            continue
        name = entry.get("name") or email.split("@", 1)[0]
        out.append({"email": email, "name": name})
    return out


@router.get("/dev-users")
def dev_users():
    """Pre-seeded mock users from the active scenario.

    Empty list when DEV_AUTH is off so the frontend can call this
    unconditionally without special-casing prod.
    """
    if not _is_dev_auth():
        return {"users": []}
    return {"users": _load_mock_users_from_scenario()}


@router.get("/me")
def get_me(user: User = Depends(require_user)):
    """Return the current authenticated user."""
    return {
        "user_id": str(user.id),
        "email": user.email,
        "name": user.display_name or user.email,
        "avatar_url": user.avatar_url,
        "is_admin": _is_admin_email(user.email),
        "share_attendance_default": user.share_attendance_default,
    }


@router.patch("/preferences")
def update_preferences(
    payload: UpdatePreferencesRequest,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
):
    """Partial update of the authenticated user's preferences."""
    if payload.share_attendance_default is not None:
        user.share_attendance_default = payload.share_attendance_default
        # Mark the preference as explicitly chosen so future default-flip
        # migrations skip this user.
        user.share_attendance_default_set_by_user = True
    session.add(user)
    session.commit()
    session.refresh(user)
    return {"share_attendance_default": user.share_attendance_default}


@router.post("/logout")
def logout():
    """Clear the session cookie."""
    response = JSONResponse(content={"status": "logged out"})
    response.delete_cookie(key=_COOKIE_NAME)
    return response


@router.delete("/me")
@limiter.limit("5/hour")
def delete_me(
    request: Request,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
):
    """GDPR: hard-delete the user's personal rows + soft-delete the account."""
    user_id = user.id

    session.exec(delete(UserSavedEvent).where(UserSavedEvent.user_id == user_id))
    session.exec(
        delete(UserEventAttendance).where(UserEventAttendance.user_id == user_id)
    )
    session.exec(delete(ShareToken).where(ShareToken.user_id == user_id))

    # Soft-anonymise ratings rather than hard-delete so aggregate scores
    # (count + average) shown to other users remain stable. The FK uses
    # ON DELETE SET NULL but we also explicitly flip is_anonymous so the
    # public reviewer label switches to "Anonymous".
    user_ratings = session.exec(
        select(EventRating).where(EventRating.user_id == user_id)
    ).all()
    for rating in user_ratings:
        rating.user_id = None
        rating.is_anonymous = True
        session.add(rating)

    db_user = session.get(User, user_id)
    if db_user is not None:
        # Anonymize and soft-delete; the row stays so FK history is preserved.
        db_user.email = f"deleted-{db_user.id}@example.invalid"
        db_user.display_name = None
        db_user.avatar_url = None
        db_user.provider_subject = None
        db_user.deleted_at = datetime.utcnow()
        session.add(db_user)
    session.commit()

    response = JSONResponse(content={"status": "deleted"})
    response.delete_cookie(key=_COOKIE_NAME)
    return response


@router.get("/saved-events")
def get_my_saved_events(
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
):
    """Return event_ids the current user has saved across all their devices."""
    rows = session.exec(
        select(UserSavedEvent.event_id).where(UserSavedEvent.user_id == user.id)
    ).all()
    return {"event_ids": sorted({r for r in rows})}


@router.get("/attending-events")
def get_my_attending_events(
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
):
    """Return events the current user is attending across all their devices,
    along with the per-event share_publicly flag so the UI can render the
    correct toggle state without re-querying."""
    rows = session.exec(
        select(
            UserEventAttendance.event_id,
            UserEventAttendance.share_publicly,
        ).where(UserEventAttendance.user_id == user.id)
    ).all()
    # A user may have rows on multiple devices for the same event; collapse
    # to one entry per event_id, treating share_publicly=True on any device
    # as the canonical state (since one row gating visibility is enough).
    by_event: dict[str, bool] = {}
    for event_id, share_publicly in rows:
        by_event[event_id] = by_event.get(event_id, False) or bool(share_publicly)
    events = [
        {"event_id": eid, "share_publicly": share}
        for eid, share in sorted(by_event.items())
    ]
    return {
        "event_ids": [e["event_id"] for e in events],
        "events": events,
    }
