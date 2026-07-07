import logging
import os
import re
import unicodedata
from datetime import datetime
from pathlib import Path
from typing import Optional

import yaml
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from slowapi import Limiter
from backend.api.rate_limit import client_ip
from sqlmodel import Session, delete, select
from sqlalchemy import func
from sqlalchemy.orm import aliased

from backend.api.deps import (
    create_session_token,
    get_client_ip,
    get_current_user_optional,
    require_user,
)
from backend.api.anon_id import clear_anon_id, read_anon_id
from backend.api.schemas import (
    AnonPreferencesPayload,
    HandleAvailabilityResponse,
    HomeLocationResponse,
    IPGeolocationResponse,
    PreferredAreaResponse,
    RedeemReferralRequest,
    RedeemReferralResponse,
    RedeemShareFollowRequest,
    RedeemShareFollowResponse,
    UpdatePreferencesRequest,
    UpdateProfileRequest,
    UserPreferencesResponse,
)
from backend.config.loader import (
    get_admin_email,
    get_current_onboarding_version,
    get_dev_auth_enabled,
    get_env_name,
    get_google_client_id,
)
from backend.db.database import get_session
from backend.db.seed import scenario_file_with_default
from backend.db.models import (
    BlockedUserIdentity,
    CalendarSubscription,
    EventRating,
    ShareToken,
    Tag,
    User,
    UserEventAttendance,
    UserFollow,
    UserPreferredTag,
    UserReferral,
    UserSavedEvent,
)
from backend.services.email import send_new_user_notification
from backend.services.follows import ensure_approved_follow_with_subscription
from backend.services.user_bootstrap import ensure_default_interest_profile

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/auth", tags=["auth"])

limiter = Limiter(key_func=client_ip)

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
    # Anonymous preferences from localStorage. Applied only when the user
    # has no server-side prefs yet (see ``_apply_anon_preferences``); a
    # returning user signing in on a second device keeps their saved prefs.
    anon_preferences: Optional[AnonPreferencesPayload] = None


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
        # Allocate a share_code immediately for new users so their first
        # shared link already carries attribution.
        _ensure_share_code(session, user)
    else:
        # Reactivate a soft-deleted account on re-login.
        was_deleted = user.deleted_at is not None
        user.deleted_at = None
        if was_deleted:
            user.onboarded_at = None
        if email and user.email != email:
            user.email = email
        if provider_subject and not user.provider_subject:
            user.provider_subject = provider_subject
        if name and not user.display_name:
            user.display_name = name
        if picture:
            user.avatar_url = picture
        user.last_login_at = now
        session.add(user)

    if not user.handle:
        user.handle = _generate_default_handle(
            session,
            name=user.display_name or name,
            email=user.email,
            exclude_user_id=user.id,
        )
        session.add(user)

    session.commit()
    session.refresh(user)
    if is_new_user:
        # Guarantee the user owns exactly one profile (the source of
        # truth for Explorer/For You defaults). ``notify_enabled=False``
        # so no alerts fire until the user opts in.
        ensure_default_interest_profile(session, user)
    return user, is_new_user


def _active_block_for_identity(
    session: Session, *, provider: str, provider_subject: Optional[str]
) -> Optional[BlockedUserIdentity]:
    if not provider_subject:
        return None
    return session.exec(
        select(BlockedUserIdentity).where(
            (BlockedUserIdentity.provider == provider)
            & (BlockedUserIdentity.provider_subject == provider_subject)
            & (BlockedUserIdentity.revoked_at.is_(None))
        )
    ).first()


def _merge_device_data(
    session: Session,
    user: User,
    device_id: Optional[str],
    anon_id: Optional[str] = None,
) -> None:
    """Attribute anonymous device-keyed rows to this user (idempotent, conflict-safe).

    ``device_id`` is the legacy localStorage value supplied by the client.
    ``anon_id`` is the value of the server-issued ``movida_aid`` cookie
    (see ``backend.api.anon_id``). Both are checked because writes after the
    cookie was introduced are keyed on the cookie value, while pre-cookie
    writes (and clients without the cookie) still use the device_id. We dedupe
    so passing the same value for both does not double-process rows.

    Newly-claimed ``UserEventAttendance`` rows inherit
    ``user.share_attendance_default`` for ``share_publicly`` so the user
    immediately appears in their own avatar stack on event cards / details
    without having to re-toggle "going" after sign-up.
    """
    keys = [k for k in {device_id, anon_id} if k]
    if not keys:
        return

    # Saved events: claim rows for these keys that have no user yet. On
    # event-id conflict with rows already owned by this user, drop the
    # device-only row (keep the older user-owned one).
    existing_event_ids = set(
        session.exec(
            select(UserSavedEvent.event_id).where(UserSavedEvent.user_id == user.id)
        ).all()
    )
    saved_rows = session.exec(
        select(UserSavedEvent).where(
            UserSavedEvent.device_id.in_(keys),
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
            UserEventAttendance.device_id.in_(keys),
            UserEventAttendance.user_id.is_(None),
        )
    ).all()
    for row in attending_rows:
        if row.event_id in existing_attending_ids:
            session.delete(row)
        else:
            row.user_id = user.id
            # Anonymous rows are stored with share_publicly=False (anonymous
            # callers can't choose visibility). Now that we know who the user
            # is, apply their default so they appear in the public attendee
            # list immediately — matching what would have happened if they
            # had been logged in when they first clicked "going".
            row.share_publicly = user.share_attendance_default
            session.add(row)
            existing_attending_ids.add(row.event_id)

    # Share token: if the user already owns one, keep it. Otherwise claim the
    # device's token; on conflict drop the device-only token. (Share tokens
    # are still keyed by the legacy device_id only — the cookie is for
    # write-side state dedupe, not link sharing.)
    if device_id:
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


def _validate_tag_ids(session: Session, tag_ids: list[int]) -> list[int]:
    """Return a deduped list of tag IDs that exist and are enabled.

    Raises ``HTTPException(400)`` if any of the supplied IDs do not match an
    enabled tag — better to fail loudly than silently drop preferences.
    """
    if not tag_ids:
        return []
    deduped = list(dict.fromkeys(int(t) for t in tag_ids))
    rows = session.exec(
        select(Tag.id).where(Tag.id.in_(deduped), Tag.enabled == True)  # noqa: E712
    ).all()
    found = {row for row in rows}
    missing = [t for t in deduped if t not in found]
    if missing:
        raise HTTPException(
            status_code=400, detail=f"Unknown or disabled tag IDs: {missing}"
        )
    return deduped


def _replace_preferred_tags(session: Session, user: User, tag_ids: list[int]) -> None:
    """Replace the user's preferred tag rows in one shot."""
    session.exec(delete(UserPreferredTag).where(UserPreferredTag.user_id == user.id))
    for tid in tag_ids:
        session.add(UserPreferredTag(user_id=user.id, tag_id=tid))


def _load_preferred_tag_ids(session: Session, user: User) -> list[int]:
    rows = session.exec(
        select(UserPreferredTag.tag_id).where(UserPreferredTag.user_id == user.id)
    ).all()
    return sorted(int(r) for r in rows)


def _serialize_preferences(session: Session, user: User) -> UserPreferencesResponse:
    area: Optional[PreferredAreaResponse] = None
    if (
        user.preferred_area_min_lat is not None
        and user.preferred_area_min_lng is not None
        and user.preferred_area_max_lat is not None
        and user.preferred_area_max_lng is not None
        and user.preferred_area_label
    ):
        area = PreferredAreaResponse(
            min_lat=user.preferred_area_min_lat,
            min_lng=user.preferred_area_min_lng,
            max_lat=user.preferred_area_max_lat,
            max_lng=user.preferred_area_max_lng,
            label=user.preferred_area_label,
        )
    home_location: Optional[HomeLocationResponse] = None
    if user.home_lat is not None and user.home_lng is not None and user.home_label:
        home_location = HomeLocationResponse(
            lat=user.home_lat,
            lng=user.home_lng,
            label=user.home_label,
        )
    return UserPreferencesResponse(
        share_attendance_default=user.share_attendance_default,
        preferred_area=area,
        preferred_tag_ids=_load_preferred_tag_ids(session, user),
        home_location=home_location,
        set_at=user.preferences_set_at,
    )


def _apply_anon_preferences(
    session: Session,
    user: User,
    anon_prefs: Optional[AnonPreferencesPayload],
) -> None:
    """Merge ``localStorage`` prefs into a fresh user row.

    Applied only when ``user.preferences_set_at IS NULL``. A returning user
    signing in on a second device keeps their saved prefs untouched (the
    frontend surfaces a non-blocking toast in that case).
    """
    if anon_prefs is None or user.preferences_set_at is not None:
        return
    if anon_prefs.preferred_area is not None:
        area = anon_prefs.preferred_area
        if area.min_lat >= area.max_lat or area.min_lng >= area.max_lng:
            # Bad bbox — silently skip rather than failing sign-in.
            return
        user.preferred_area_min_lat = area.min_lat
        user.preferred_area_min_lng = area.min_lng
        user.preferred_area_max_lat = area.max_lat
        user.preferred_area_max_lng = area.max_lng
        user.preferred_area_label = area.label
    if anon_prefs.home_location is not None:
        home = anon_prefs.home_location
        user.home_lat = home.lat
        user.home_lng = home.lng
        user.home_label = home.label
    try:
        tag_ids = _validate_tag_ids(session, anon_prefs.preferred_tag_ids)
    except HTTPException:
        # Stale tag IDs from localStorage — drop them, don't fail sign-in.
        tag_ids = []
    _replace_preferred_tags(session, user, tag_ids)
    user.preferences_set_at = datetime.utcnow()
    session.add(user)
    session.commit()


def _notify_admin_new_user(user: User) -> None:
    admin_email = get_admin_email()
    if not admin_email:
        return
    send_new_user_notification(user, admin_email)


@router.post("/google")
@limiter.limit("10/minute")
def login_with_google(
    request: Request,
    body: GoogleLoginRequest,
    background_tasks: BackgroundTasks,
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

    if _active_block_for_identity(
        session, provider="google", provider_subject=provider_subject
    ):
        return JSONResponse(
            status_code=403,
            content={"detail": "This account is blocked from signing in"},
        )

    user, is_new_user = _upsert_user_from_claims(
        session,
        email=email,
        name=name,
        picture=picture,
        provider_subject=provider_subject,
    )
    _merge_device_data(session, user, body.device_id, anon_id=read_anon_id(request))
    _apply_anon_preferences(session, user, body.anon_preferences)
    session.refresh(user)
    if is_new_user:
        background_tasks.add_task(_notify_admin_new_user, user)

    is_admin = _is_admin_email(user.email)
    response = JSONResponse(
        content={
            "user_id": str(user.id),
            "email": user.email,
            "name": user.display_name or user.email,
            "handle": user.handle,
            "avatar_url": user.avatar_url,
            "is_admin": is_admin,
            "is_new_user": is_new_user,
            "share_attendance_default": user.share_attendance_default,
            "share_attendance_default_audience": (
                user.share_attendance_default_audience
                or ("public" if user.share_attendance_default else "private")
            ),
            "preferences": _serialize_preferences(session, user).model_dump(
                mode="json"
            ),
            # Phase E (E2): include friend_count on the login response so
            # the AudiencePicker zero-friends hint can render immediately
            # after sign-in without waiting for the next /auth/me cycle.
            "friend_count": _friend_count(session, user.id),
            # Phase E (E3): ISO-8601 timestamp of onboarding completion
            # (or skip). ``None`` means the frontend should redirect to
            # ``/onboarding/follow`` after first-load.
            "onboarded_at": (
                user.onboarded_at.isoformat() if user.onboarded_at else None
            ),
            # True when the user has never onboarded OR the server-side
            # ``CURRENT_ONBOARDING_VERSION`` was bumped since they last
            # completed the wizard (forced re-onboarding).
            "needs_onboarding": (
                user.onboarded_at is None
                or (user.onboarding_version or 0) < get_current_onboarding_version()
            ),
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


def _friend_count(session: Session, user_id) -> int:
    """Count mutual follows (``friends``) for ``user_id``.

    Used by ``/auth/me`` and ``/auth/google`` so the frontend
    AudiencePicker can render the Phase E zero-friends hint right
    after sign-in. Kept here (not in deps/social) to preserve the
    one-way auth → social import direction.
    """
    f1 = aliased(UserFollow)
    f2 = aliased(UserFollow)
    return int(
        session.exec(
            select(func.count())
            .select_from(f1)
            .join(
                f2,
                (f2.follower_id == f1.followee_id) & (f2.followee_id == f1.follower_id),
            )
            .where(f1.follower_id == user_id)
        ).one()
    )


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
    path = scenario_file_with_default(Path(scenario_dir), "mock-users.yaml")
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
def get_me(
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
):
    """Return the current authenticated user."""
    # Lazily mint a share_code for accounts that predate the column.
    if not user.share_code:
        _ensure_share_code(session, user)
        session.commit()
        session.refresh(user)
    friend_count = _friend_count(session, user.id)
    return {
        "user_id": str(user.id),
        "email": user.email,
        "name": user.display_name or user.email,
        "handle": user.handle,
        "share_code": user.share_code,
        "avatar_url": user.avatar_url,
        "is_admin": _is_admin_email(user.email),
        "share_attendance_default": user.share_attendance_default,
        "share_attendance_default_audience": (
            user.share_attendance_default_audience
            or ("public" if user.share_attendance_default else "private")
        ),
        "preferences": _serialize_preferences(session, user).model_dump(mode="json"),
        "friend_count": friend_count,
        # Phase E (E3): see /auth/google for shape; ``None`` triggers the
        # onboarding redirect on first signed-in navigation.
        "onboarded_at": (user.onboarded_at.isoformat() if user.onboarded_at else None),
        # True when the user has never onboarded OR the server-side
        # ``CURRENT_ONBOARDING_VERSION`` was bumped since they last
        # completed the wizard (forced re-onboarding).
        "needs_onboarding": (
            user.onboarded_at is None
            or (user.onboarding_version or 0) < get_current_onboarding_version()
        ),
        # Re-engagement / notification preferences (see /auth/notification-preferences).
        "timezone": user.timezone,
        # Phase G: six per-feature × per-channel gates.
        "email_event_reminders_enabled": user.email_event_reminders_enabled,
        "email_social_activity_enabled": user.email_social_activity_enabled,
        "email_interest_matches_enabled": user.email_interest_matches_enabled,
        "push_event_reminders_enabled": user.push_event_reminders_enabled,
        "push_social_activity_enabled": user.push_social_activity_enabled,
        "push_interest_matches_enabled": user.push_interest_matches_enabled,
        # Legacy aliases derived from the new flags. Kept for one release so
        # older frontend clients still work (Phase G §G.9 step 5 drops them).
        "reminder_email_enabled": user.email_event_reminders_enabled,
        "activity_email_enabled": (
            user.email_social_activity_enabled
            and user.email_interest_matches_enabled
        ),
        "push_enabled": (
            user.push_event_reminders_enabled
            and user.push_social_activity_enabled
            and user.push_interest_matches_enabled
        ),
        "interest_notifications_enabled": (
            user.email_interest_matches_enabled
            and user.push_interest_matches_enabled
        ),
    }


@router.patch("/preferences", response_model=UserPreferencesResponse)
def update_preferences(
    payload: UpdatePreferencesRequest,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
):
    """Partial update of the authenticated user's preferences.

    ``share_attendance_default`` keeps its existing partial-update semantics
    (omit → untouched). For the new fields:

    * ``preferred_area`` — omit (``None``-by-default) leaves the area
      untouched. To clear it, pass an explicit ``{"preferred_area": null}``
      with ``__clear__`` semantics via ``preferred_tag_ids: []`` and the
      separate ``DELETE`` endpoint pattern is intentionally avoided here
      — callers send a fresh full payload.
    * ``preferred_tag_ids`` — omit leaves untouched; ``[]`` clears.

    ``preferences_set_at`` is bumped on any successful save (including
    explicit empty) so the anon→authed merge knows the user has opted in.
    """
    touched_prefs = False
    if payload.share_attendance_default is not None:
        user.share_attendance_default = payload.share_attendance_default
        # Mark the preference as explicitly chosen so future default-flip
        # migrations skip this user.
        user.share_attendance_default_set_by_user = True

    # Use ``model_fields_set`` to distinguish "omitted" from "explicit null".
    fields_set = payload.model_fields_set
    if "preferred_area" in fields_set:
        touched_prefs = True
        if payload.preferred_area is None:
            user.preferred_area_min_lat = None
            user.preferred_area_min_lng = None
            user.preferred_area_max_lat = None
            user.preferred_area_max_lng = None
            user.preferred_area_label = None
        else:
            area = payload.preferred_area
            if area.min_lat >= area.max_lat or area.min_lng >= area.max_lng:
                raise HTTPException(
                    status_code=400,
                    detail="Invalid preferred_area: min must be < max",
                )
            user.preferred_area_min_lat = area.min_lat
            user.preferred_area_min_lng = area.min_lng
            user.preferred_area_max_lat = area.max_lat
            user.preferred_area_max_lng = area.max_lng
            user.preferred_area_label = area.label

    if "preferred_tag_ids" in fields_set:
        touched_prefs = True
        validated = _validate_tag_ids(session, payload.preferred_tag_ids or [])
        _replace_preferred_tags(session, user, validated)

    if "home_location" in fields_set:
        touched_prefs = True
        if payload.home_location is None:
            user.home_lat = None
            user.home_lng = None
            user.home_label = None
        else:
            home = payload.home_location
            user.home_lat = home.lat
            user.home_lng = home.lng
            user.home_label = home.label

    if touched_prefs:
        user.preferences_set_at = datetime.utcnow()

    session.add(user)
    session.commit()
    session.refresh(user)
    return _serialize_preferences(session, user)


class UpdateNotificationPreferencesRequest(BaseModel):
    """Partial update of the user's notification/email preferences.

    All fields optional; omitted fields are left untouched. Legacy
    four-flag names are accepted as aliases that write through to the
    corresponding new per-feature × per-channel flags (Phase G).
    """

    timezone: Optional[str] = None
    # Phase G: per-feature × per-channel gates.
    email_event_reminders_enabled: Optional[bool] = None
    email_social_activity_enabled: Optional[bool] = None
    email_interest_matches_enabled: Optional[bool] = None
    push_event_reminders_enabled: Optional[bool] = None
    push_social_activity_enabled: Optional[bool] = None
    push_interest_matches_enabled: Optional[bool] = None
    # Legacy aliases — removed in the cleanup PR (§G.9 step 5).
    reminder_email_enabled: Optional[bool] = None
    activity_email_enabled: Optional[bool] = None
    push_enabled: Optional[bool] = None
    interest_notifications_enabled: Optional[bool] = None


def _is_valid_timezone(name: str) -> bool:
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

    try:
        ZoneInfo(name)
        return True
    except (ZoneInfoNotFoundError, ValueError):
        return False


# Map legacy field name → tuple of new User attributes to write-through.
# Setting a legacy flag flips every derived new flag to match, preserving
# the pre-Phase-G "one master toggle" behaviour for older clients.
_LEGACY_WRITE_THROUGH: dict[str, tuple[str, ...]] = {
    "reminder_email_enabled": ("email_event_reminders_enabled",),
    "activity_email_enabled": (
        "email_social_activity_enabled",
        "email_interest_matches_enabled",
    ),
    "push_enabled": (
        "push_event_reminders_enabled",
        "push_social_activity_enabled",
        "push_interest_matches_enabled",
    ),
    "interest_notifications_enabled": (
        "email_interest_matches_enabled",
        "push_interest_matches_enabled",
    ),
}

# New flags — direct passthrough.
_NEW_FLAGS: tuple[str, ...] = (
    "email_event_reminders_enabled",
    "email_social_activity_enabled",
    "email_interest_matches_enabled",
    "push_event_reminders_enabled",
    "push_social_activity_enabled",
    "push_interest_matches_enabled",
)


@router.patch("/notification-preferences")
def update_notification_preferences(
    payload: UpdateNotificationPreferencesRequest,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
):
    """Update per-feature × per-channel email/push toggles + timezone."""
    fields_set = payload.model_fields_set
    if "timezone" in fields_set and payload.timezone is not None:
        tz = payload.timezone.strip()
        if len(tz) > 64 or not _is_valid_timezone(tz):
            raise HTTPException(status_code=400, detail="Invalid timezone")
        user.timezone = tz

    # Apply the six new flags first so a same-payload combination of legacy
    # + new gives the legacy write-through the final say (matches the
    # backfill AND-semantics documented in §G.5).
    for flag in _NEW_FLAGS:
        if flag in fields_set:
            value = getattr(payload, flag)
            if value is not None:
                setattr(user, flag, value)

    for legacy, targets in _LEGACY_WRITE_THROUGH.items():
        if legacy in fields_set:
            value = getattr(payload, legacy)
            if value is not None:
                for target in targets:
                    setattr(user, target, value)

    session.add(user)
    session.commit()
    session.refresh(user)
    return {
        "timezone": user.timezone,
        "email_event_reminders_enabled": user.email_event_reminders_enabled,
        "email_social_activity_enabled": user.email_social_activity_enabled,
        "email_interest_matches_enabled": user.email_interest_matches_enabled,
        "push_event_reminders_enabled": user.push_event_reminders_enabled,
        "push_social_activity_enabled": user.push_social_activity_enabled,
        "push_interest_matches_enabled": user.push_interest_matches_enabled,
        # Legacy mirror (removed in cleanup PR).
        "reminder_email_enabled": user.email_event_reminders_enabled,
        "activity_email_enabled": (
            user.email_social_activity_enabled
            and user.email_interest_matches_enabled
        ),
        "push_enabled": (
            user.push_event_reminders_enabled
            and user.push_social_activity_enabled
            and user.push_interest_matches_enabled
        ),
        "interest_notifications_enabled": (
            user.email_interest_matches_enabled
            and user.push_interest_matches_enabled
        ),
    }


@router.get("/geolocate-ip", response_model=Optional[IPGeolocationResponse])
async def geolocate_ip_endpoint(
    request: Request,
    _user: User = Depends(require_user),
):
    """Best-effort IP -> city geo prefill for the home-pin picker.

    Returns 204 when the IP is private or geolocation fails (silent-fail
    so the caller falls back to browser geolocation or manual city
    typeahead per PRD §8 Step 2).
    """
    from backend.services.ip_geolocation import geolocate_ip

    ip = get_client_ip(request)
    geo = await geolocate_ip(ip)
    if not geo:
        return JSONResponse(status_code=204, content=None)
    lat = geo.get("lat")
    lng = geo.get("lon")
    if lat is None or lng is None:
        return JSONResponse(status_code=204, content=None)
    parts = [p for p in (geo.get("city"), geo.get("country")) if p]
    label = ", ".join(parts) if parts else "My area"
    return IPGeolocationResponse(lat=float(lat), lng=float(lng), label=label)


@router.get("/unsubscribe")
def unsubscribe(
    token: str = Query(...),
    session: Session = Depends(get_session),
):
    """One-click email unsubscribe via a signed token (no auth required).

    Flips the matching email preference off. Always returns 200 with a
    generic result so the link can't be used to probe account existence.
    """
    from uuid import UUID

    from backend.services.email_tokens import (
        UNSUBSCRIBE_CATEGORIES,
        verify_unsubscribe_token,
    )

    result = verify_unsubscribe_token(token)
    if result is None:
        return {"status": "invalid"}
    user_id, category = result
    columns = UNSUBSCRIBE_CATEGORIES[category]
    try:
        uid = UUID(user_id)
    except (ValueError, AttributeError):
        return {"status": "invalid"}
    user = session.get(User, uid)
    if user is not None and user.deleted_at is None:
        for column in columns:
            setattr(user, column, False)
        session.add(user)
        session.commit()
    return {"status": "unsubscribed", "category": category}


# --- Profile (display_name + handle) -----------------------------------------

# Crockford-style base32 alphabet (no I/L/O/U) — short, unambiguous, URL-safe.
# Used for ``users.share_code``, the opaque attribution identifier appended
# to shared event URLs.
_SHARE_CODE_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"
_SHARE_CODE_LEN = 8
_SHARE_CODE_MAX_TRIES = 6


def _generate_share_code() -> str:
    """Return an 8-char base32 token from a CSPRNG."""
    import secrets

    return "".join(secrets.choice(_SHARE_CODE_ALPHABET) for _ in range(_SHARE_CODE_LEN))


def _ensure_share_code(session: Session, user: User) -> None:
    """Lazily backfill ``share_code`` for users that predate the column.

    Idempotent: no-op when the user already has one. Caller is responsible
    for the surrounding commit.
    """
    if user.share_code:
        return
    for _ in range(_SHARE_CODE_MAX_TRIES):
        candidate = _generate_share_code()
        # Defensive uniqueness check; the unique index enforces the
        # invariant but trying once at the application layer avoids the
        # noisy IntegrityError path on the happy collisions-are-rare case.
        clash = session.exec(
            select(User.id).where(User.share_code == candidate)
        ).first()
        if clash is None:
            user.share_code = candidate
            session.add(user)
            return
    # Astronomically unlikely with 32^8 ≈ 1.1e12 keyspace; surface as 500
    # rather than silently returning a None code.
    raise HTTPException(status_code=500, detail="Failed to allocate share code")


# Lowercase ASCII; must start with letter to avoid handles that look like
# numeric IDs or that would clash with future numeric routes.
_HANDLE_PATTERN = re.compile(r"^[a-z][a-z0-9_]{2,23}$")

# Reserved handles that map to existing routes, generic terms, or names we
# want to keep available for app-owned profiles. Lowercase comparisons.
_RESERVED_HANDLES: frozenset[str] = frozenset(
    {
        "admin",
        "admins",
        "administrator",
        "support",
        "help",
        "contact",
        "about",
        "privacy",
        "terms",
        "login",
        "logout",
        "signin",
        "signup",
        "register",
        "account",
        "settings",
        "profile",
        "user",
        "users",
        "u",
        "me",
        "home",
        "events",
        "event",
        "calendar",
        "share",
        "shared",
        "api",
        "auth",
        "static",
        "assets",
        "public",
        "movida",
        "joinmovida",
        "official",
        "system",
        "root",
        "moderator",
        "mod",
    }
)


def _normalize_handle(raw: str) -> str:
    return raw.strip().lower()


def _validate_handle(raw: str) -> tuple[Optional[str], Optional[str]]:
    """Return (normalized_handle, error_reason). Reason is human-readable."""
    h = _normalize_handle(raw)
    if not h:
        return None, "Handle is required"
    if not _HANDLE_PATTERN.match(h):
        return None, (
            "3–24 chars, letters/numbers/underscore, must start with a letter"
        )
    if h in _RESERVED_HANDLES:
        return None, "This handle is reserved"
    return h, None


def _handle_in_use(session: Session, handle: str, exclude_user_id) -> bool:
    stmt = select(User.id).where(func.lower(User.handle) == handle)
    if exclude_user_id is not None:
        stmt = stmt.where(User.id != exclude_user_id)
    return session.exec(stmt).first() is not None


def _default_handle_base(raw: str) -> str:
    text = unicodedata.normalize("NFKD", raw or "")
    text = text.encode("ascii", "ignore").decode("ascii").lower()
    base = re.sub(r"[^a-z0-9]+", "_", text).strip("_")
    if not base:
        base = "member"
    if not base[0].isalpha():
        base = f"u_{base}"
    if len(base) < 3:
        base = (base + "xxx")[:3]
    return base[:24].strip("_")


def _generate_default_handle(
    session: Session,
    *,
    name: str,
    email: str,
    exclude_user_id,
) -> str:
    sources = [name, email.split("@", 1)[0], "member"]
    bases: list[str] = []
    for source in sources:
        base = _default_handle_base(source)
        if base not in bases:
            bases.append(base)

    for base in bases:
        for suffix in [""] + [f"_{i}" for i in range(2, 100)]:
            candidate = f"{base[: 24 - len(suffix)]}{suffix}"
            normalized, reason = _validate_handle(candidate)
            if normalized is None or reason is not None:
                continue
            if not _handle_in_use(session, normalized, exclude_user_id=exclude_user_id):
                return normalized

    raise HTTPException(status_code=500, detail="Failed to allocate handle")


@router.get("/handle-available", response_model=HandleAvailabilityResponse)
def handle_available(
    handle: str = Query(..., min_length=1, max_length=32),
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
):
    """Live availability check for the handle picker."""
    normalized, reason = _validate_handle(handle)
    if normalized is None:
        return HandleAvailabilityResponse(handle=handle, available=False, reason=reason)
    if _handle_in_use(session, normalized, exclude_user_id=user.id):
        return HandleAvailabilityResponse(
            handle=normalized, available=False, reason="Already taken"
        )
    return HandleAvailabilityResponse(handle=normalized, available=True)


@router.patch("/profile")
@limiter.limit("20/hour")
def update_profile(
    request: Request,
    payload: UpdateProfileRequest,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
):
    """Update editable identity fields (display_name and/or handle)."""
    if payload.display_name is not None:
        name = payload.display_name.strip()
        if not name:
            raise HTTPException(status_code=422, detail="Display name cannot be blank")
        user.display_name = name

    if payload.handle is not None:
        normalized, reason = _validate_handle(payload.handle)
        if normalized is None:
            raise HTTPException(status_code=422, detail=reason or "Invalid handle")
        if _handle_in_use(session, normalized, exclude_user_id=user.id):
            raise HTTPException(status_code=409, detail="Handle already taken")
        user.handle = normalized

    session.add(user)
    session.commit()
    session.refresh(user)
    return {
        "display_name": user.display_name,
        "handle": user.handle,
    }


@router.post("/logout")
def logout():
    """Clear the session cookie and rotate the anonymous-id cookie.

    Rotating ``movida_aid`` on logout prevents the next anonymous session
    on the same browser from inheriting the previous user's anonymous
    dedupe identity (otherwise saves/going made anonymously after logout
    would attach to the same server-side row group as the previous user).
    """
    response = JSONResponse(content={"status": "logged out"})
    response.delete_cookie(key=_COOKIE_NAME)
    clear_anon_id(response)
    return response


def purge_user_account(session: Session, user_id) -> None:
    """Hard-delete personal rows and soft-anonymise the user row.

    Shared by the self-service ``DELETE /api/auth/me`` flow and the admin
    ``DELETE /api/social/admin/users/{handle}`` flow so the cleanup logic
    (especially the social-edge cascade fixed for the friends-graph
    regression) lives in one place. Caller commits.
    """
    session.exec(delete(UserSavedEvent).where(UserSavedEvent.user_id == user_id))
    session.exec(
        delete(UserEventAttendance).where(UserEventAttendance.user_id == user_id)
    )
    session.exec(delete(ShareToken).where(ShareToken.user_id == user_id))
    # Drop social edges in both directions so deleted users no longer
    # inflate other users' follower / friend counts and disappear from
    # subscription lists. (Hard-delete: these rows carry no standalone
    # meaning once the account is gone.)
    session.exec(
        delete(UserFollow).where(
            (UserFollow.follower_id == user_id) | (UserFollow.followee_id == user_id)
        )
    )
    session.exec(
        delete(CalendarSubscription).where(
            (CalendarSubscription.subscriber_id == user_id)
            | (CalendarSubscription.target_user_id == user_id)
        )
    )

    # Soft-anonymise ratings rather than hard-delete so aggregate scores
    # (count + average) shown to other users remain stable.
    user_ratings = session.exec(
        select(EventRating).where(EventRating.user_id == user_id)
    ).all()
    for rating in user_ratings:
        rating.user_id = None
        rating.is_anonymous = True
        session.add(rating)

    db_user = session.get(User, user_id)
    if db_user is not None:
        db_user.email = f"deleted-{db_user.id}@example.invalid"
        db_user.display_name = None
        db_user.avatar_url = None
        db_user.deleted_at = datetime.utcnow()
        session.add(db_user)


@router.delete("/me")
@limiter.limit("5/hour")
def delete_me(
    request: Request,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
):
    """GDPR: hard-delete the user's personal rows + soft-delete the account."""
    purge_user_account(session, user.id)
    session.commit()
    response = JSONResponse(content={"status": "deleted"})
    response.delete_cookie(key=_COOKIE_NAME)
    clear_anon_id(response)
    return response


@router.get("/saved-events")
def get_my_saved_events(
    request: Request,
    user: User | None = Depends(get_current_user_optional),
    session: Session = Depends(get_session),
):
    """Return event_ids saved by the current identity.

    Authed: returns rows owned by ``user_id`` across all devices.
    Anonymous: returns rows owned by the ``movida_aid`` cookie identity
    (so the frontend can replace its local cache from server truth even
    before sign-in). Returns an empty list when neither identity is
    available (cookie blocked, first-ever visit).

    Also returns ``events: [{event_id, audience}]`` so callers can render
    a per-saved-event audience picker without an extra round trip.
    Anonymous rows always report ``audience='private'``.
    """
    if user is not None:
        rows = session.exec(
            select(UserSavedEvent.event_id, UserSavedEvent.audience).where(
                UserSavedEvent.user_id == user.id
            )
        ).all()
        # Collapse cross-device rows to one entry per event_id; most-permissive
        # audience wins on collapse (public > friends > private).
        order = {"private": 0, "friends": 1, "public": 2}
        by_event: dict[str, str] = {}
        for event_id, audience in rows:
            current = by_event.get(event_id, "private")
            incoming = audience or "private"
            if order.get(incoming, 0) > order.get(current, 0):
                by_event[event_id] = incoming
            else:
                by_event.setdefault(event_id, current)
        events = [
            {"event_id": eid, "audience": aud} for eid, aud in sorted(by_event.items())
        ]
        return {
            "event_ids": [e["event_id"] for e in events],
            "events": events,
        }
    anon_id = read_anon_id(request)
    if not anon_id:
        return {"event_ids": [], "events": []}
    rows = session.exec(
        select(UserSavedEvent.event_id).where(
            UserSavedEvent.device_id == anon_id,
            UserSavedEvent.user_id.is_(None),
        )
    ).all()
    event_ids = sorted({r for r in rows})
    events = [{"event_id": eid, "audience": "private"} for eid in event_ids]
    return {"event_ids": event_ids, "events": events}


@router.get("/attending-events")
def get_my_attending_events(
    request: Request,
    user: User | None = Depends(get_current_user_optional),
    session: Session = Depends(get_session),
):
    """Return events the current identity is attending, with the per-event
    ``share_publicly`` flag so the UI can render the correct toggle state
    without re-querying.

    Authed: collapses cross-device rows for ``user_id``; ``share_publicly``
    is True if any device has it set. Anonymous: returns rows owned by the
    ``movida_aid`` cookie identity (always ``share_publicly=False`` because
    anonymous rows can never opt in to public sharing). Returns an empty
    list when neither identity is available.
    """
    if user is not None:
        rows = session.exec(
            select(
                UserEventAttendance.event_id,
                UserEventAttendance.share_publicly,
                UserEventAttendance.share_audience,
            ).where(UserEventAttendance.user_id == user.id)
        ).all()
        # A user may have rows on multiple devices for the same event; collapse
        # to one entry per event_id, treating share_publicly=True on any device
        # as the canonical state (since one row gating visibility is enough).
        by_event: dict[str, dict] = {}
        for event_id, share_publicly, share_audience in rows:
            entry = by_event.setdefault(
                event_id, {"share_publicly": False, "share_audience": "private"}
            )
            entry["share_publicly"] = entry["share_publicly"] or bool(share_publicly)
            # Most-permissive wins on collapse (public > friends > private).
            order = {"private": 0, "friends": 1, "public": 2}
            if order.get(share_audience or "private", 0) > order.get(
                entry["share_audience"], 0
            ):
                entry["share_audience"] = share_audience or "private"
        events = [
            {
                "event_id": eid,
                "share_publicly": v["share_publicly"],
                "share_audience": v["share_audience"],
            }
            for eid, v in sorted(by_event.items())
        ]
        return {
            "event_ids": [e["event_id"] for e in events],
            "events": events,
        }
    anon_id = read_anon_id(request)
    if not anon_id:
        return {"event_ids": [], "events": []}
    rows = session.exec(
        select(
            UserEventAttendance.event_id,
            UserEventAttendance.share_publicly,
        ).where(
            UserEventAttendance.device_id == anon_id,
            UserEventAttendance.user_id.is_(None),
        )
    ).all()
    by_event: dict[str, bool] = {}
    for event_id, share_publicly in rows:
        by_event[event_id] = by_event.get(event_id, False) or bool(share_publicly)
    events = [
        {"event_id": eid, "share_publicly": share, "share_audience": "private"}
        for eid, share in sorted(by_event.items())
    ]
    return {
        "event_ids": [e["event_id"] for e in events],
        "events": events,
    }


# ---------------------------------------------------------------------------
# Phase E (E7) — referral redemption
# ---------------------------------------------------------------------------


@router.post("/redeem-referral", response_model=RedeemReferralResponse)
@limiter.limit("60/hour")
def redeem_referral(
    request: Request,
    body: RedeemReferralRequest,
    session: Session = Depends(get_session),
    viewer: User = Depends(require_user),
):
    """Phase E (E7): redeem an invite code after sign-up.

    Side effects when ``consent=True`` and the code resolves to an
    inviter who is NOT the viewer:

      1. Insert ``UserFollow(follower=viewer, target=inviter)``.
      2. Insert ``UserFollow(follower=inviter, target=viewer)``.
         The pair makes them friends immediately so the per-event
         ``friends`` audience starts working for both.
            3. Subscribe both users to each other's calendars.
            4. Increment ``user_referrals.used_count`` (best-effort).
            5. Fire ``notify_new_follower`` for the inviter (so they see
         "@viewer joined via your link") AND ``notify_new_friend``
         on both sides via the same notification side-effect path
         used by the regular follow flow.

    To avoid leaking information about who owns which code, the
    endpoint returns 200 with an empty ``inviter_handle`` if the
    code is unknown, the inviter is the viewer themselves, or the
    inviter account is soft-deleted. Only ``consent=False`` returns
    400 — that's a deliberate client error.
    """
    if not body.consent:
        raise HTTPException(status_code=400, detail="Consent required")

    code = (body.code or "").strip().upper()
    if not code:
        return RedeemReferralResponse(inviter_handle=None, mutual_follow_created=False)

    referral = session.exec(
        select(UserReferral).where(func.upper(UserReferral.code) == code)
    ).first()
    if referral is None:
        return RedeemReferralResponse(inviter_handle=None, mutual_follow_created=False)

    inviter = session.exec(
        select(User)
        .where(User.id == referral.inviter_user_id)
        .where(User.deleted_at.is_(None))
    ).first()
    if inviter is None or inviter.id == viewer.id:
        return RedeemReferralResponse(inviter_handle=None, mutual_follow_created=False)

    # Insert both follow edges, idempotently. We're intentionally
    # importing the notification helper at call time to avoid a
    # circular import with backend.services.notifications which
    # imports from this module's parent package.
    from backend.services.notifications import (
        notify_new_follower as _notify_new_follower,
        notify_new_friend as _notify_new_friend,
    )

    created_edges = 0
    for follower_id, target_id in (
        (viewer.id, inviter.id),
        (inviter.id, viewer.id),
    ):
        _, follow_created, _, _ = ensure_approved_follow_with_subscription(
            session,
            follower_id,
            target_id,
        )
        if follow_created:
            created_edges += 1

    # Bump the counter even for re-redemptions so the inviter can see
    # repeat clicks if we ever surface link analytics.
    referral.used_count = int(referral.used_count or 0) + 1
    session.add(referral)
    session.commit()

    if created_edges > 0:
        # Notify the inviter that someone joined via their link AND
        # both sides that they're now friends (E6 toast surfaces on
        # the next poll). These rows live on the same session so we
        # commit them together below; without that commit the rows
        # were silently dropped on request teardown (get_session has
        # no auto-commit).
        _notify_new_follower(session, followee=inviter, follower=viewer)
        _notify_new_friend(session, viewer, inviter)
        session.commit()

    return RedeemReferralResponse(
        inviter_handle=inviter.handle,
        mutual_follow_created=created_edges > 0,
    )


# ---------------------------------------------------------------------------
# Phase E (D2) — share-link doubles as referral
# ---------------------------------------------------------------------------


@router.post("/redeem-share-follow", response_model=RedeemShareFollowResponse)
@limiter.limit("30/hour")
def redeem_share_follow(
    request: Request,
    body: RedeemShareFollowRequest,
    session: Session = Depends(get_session),
    viewer: User = Depends(require_user),
):
    """Phase 3 (D2): one-way follow on share-link redemption.

    Mirrors ``redeem_referral`` but:

    * looks up the sharer by ``User.share_code`` (the opaque token
      already in every ``?ref=share&src=`` URL) rather than by an
      invite code from ``user_referrals``;
    * does NOT bump ``user_referrals.used_count`` — share-link
      conversions are tracked on their own surface and stay out of
      the invite leaderboard (D2 decision);
    * creates ONLY the viewer→sharer follow edge (one-way). Sharing
      a link is not strong enough consent for the sharer to befriend
      a stranger who clicked it; the sharer gets a regular
      new-follower notification and can follow back manually via the
      existing UI (GDPR-safer than auto-mutual).
    * runs on its own ``30/hour`` per-IP rate-limit bucket, separate
      from the ``60/hour`` cap on ``redeem-referral``.

    Idempotent on the follow edge (re-redemption is a no-op). To
    avoid leaking information about who owns which share_code the
    endpoint returns 200 with an empty ``sharer_handle`` when the
    code is unknown, points at the viewer themselves, or to a
    soft-deleted account. ``consent=false`` is the only client error.
    """
    if not body.consent:
        raise HTTPException(status_code=400, detail="Consent required")

    code = (body.share_code or "").strip().lower()
    if not code:
        return RedeemShareFollowResponse(sharer_handle=None, follow_created=False)

    sharer = session.exec(
        select(User).where(User.share_code == code).where(User.deleted_at.is_(None))
    ).first()
    if sharer is None or sharer.id == viewer.id:
        return RedeemShareFollowResponse(sharer_handle=None, follow_created=False)

    from backend.services.notifications import (
        notify_new_follower as _notify_new_follower,
    )

    _, follow_created, _, _ = ensure_approved_follow_with_subscription(
        session,
        viewer.id,
        sharer.id,
    )

    session.commit()

    if follow_created:
        # Same commit-ordering caveat as redeem_referral: get_session
        # has no auto-commit, so we must explicitly commit AFTER the
        # notification helper or its row is dropped on teardown.
        _notify_new_follower(session, followee=sharer, follower=viewer)
        session.commit()

    return RedeemShareFollowResponse(
        sharer_handle=sharer.handle,
        follow_created=follow_created,
    )
