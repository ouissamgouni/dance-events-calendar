from datetime import datetime, timedelta

from fastapi import APIRouter, Depends
from sqlmodel import Session

from backend.api.deps import require_admin
from backend.api.schemas import SiteSettingsResponse, SiteSettingsUpdateRequest
from backend.config.loader import get_auto_sync_enabled, get_sync_interval_minutes
from backend.db.database import get_session
from backend.db.models import SiteSetting

router = APIRouter(prefix="/api/settings", tags=["settings"])

DEFAULT_SINCE_DAYS = 183  # ~6 months


def _default_since_date() -> str:
    return (datetime.utcnow() - timedelta(days=DEFAULT_SINCE_DAYS)).strftime("%Y-%m-%d")


def _get_since_date(session: Session) -> str:
    """Get the since_date setting from the DB, or default to 6 months ago."""
    try:
        row = session.get(SiteSetting, "since_date")
        if row and isinstance(row.value, str):
            return row.value
    except Exception:
        pass
    return _default_since_date()


def _get_sync_since_date(session: Session) -> str:
    """Get the sync_since_date setting from the DB, or default to 6 months ago.

    Independent from ``since_date`` (which controls UI display filtering).
    Used as the lower bound when fetching events from upstream calendars.
    """
    try:
        row = session.get(SiteSetting, "sync_since_date")
        if row and isinstance(row.value, str):
            return row.value
    except Exception:
        pass
    return _default_since_date()


def _get_sync_interval(session: Session) -> int:
    """Get sync_interval_minutes from DB, fallback to env/default."""
    try:
        row = session.get(SiteSetting, "sync_interval_minutes")
        if row and row.value.isdigit():
            return int(row.value)
    except Exception:
        pass
    return get_sync_interval_minutes()


def _get_auto_sync_enabled(session: Session) -> bool:
    """Get auto_sync_enabled from DB, fallback to env/scenario/default."""
    try:
        row = session.get(SiteSetting, "auto_sync_enabled")
        if row:
            return row.value.lower() == "true"
    except Exception:
        pass
    return get_auto_sync_enabled()


def _get_auto_sync_mode(session: Session) -> str:
    """Get auto_sync_mode from DB ('incremental' | 'reseed'), default 'incremental'."""
    try:
        row = session.get(SiteSetting, "auto_sync_mode")
        if row and row.value in {"incremental", "reseed"}:
            return row.value
    except Exception:
        pass
    return "incremental"


def _get_bool_setting(session: Session, key: str, default: bool = False) -> bool:
    """Get a boolean setting from the DB."""
    try:
        row = session.get(SiteSetting, key)
        if row:
            return row.value.lower() == "true"
    except Exception:
        pass
    return default


def _get_int_setting(session: Session, key: str, default: int) -> int:
    """Get an integer setting from the DB."""
    try:
        row = session.get(SiteSetting, key)
        if row and row.value.isdigit():
            return int(row.value)
    except Exception:
        pass
    return default


def _get_str_setting(session: Session, key: str, default: str) -> str:
    """Get a string setting from the DB."""
    try:
        row = session.get(SiteSetting, key)
        if row and isinstance(row.value, str) and row.value:
            return row.value
    except Exception:
        pass
    return default


def _set_bool_setting(session: Session, key: str, value: bool) -> None:
    """Set a boolean setting in the DB."""
    row = session.get(SiteSetting, key)
    if row:
        row.value = str(value).lower()
    else:
        row = SiteSetting(key=key, value=str(value).lower())
    session.add(row)


@router.get("", response_model=SiteSettingsResponse)
def get_settings(session: Session = Depends(get_session)):
    """Public endpoint — returns site settings needed by the frontend."""
    return SiteSettingsResponse(
        since_date=_get_since_date(session),
        sync_since_date=_get_sync_since_date(session),
        sync_interval_minutes=_get_sync_interval(session),
        auto_sync_enabled=_get_auto_sync_enabled(session),
        auto_sync_mode=_get_auto_sync_mode(session),
        show_prices=_get_bool_setting(session, "show_prices"),
        show_popularity=_get_bool_setting(session, "show_popularity"),
        show_ratings=_get_bool_setting(session, "show_ratings"),
        popularity_threshold=_get_int_setting(session, "popularity_threshold", 10),
        event_color_bar_color=_get_str_setting(
            session, "event_color_bar_color", "#64748b"
        ),
    )


@router.put("", response_model=SiteSettingsResponse)
def update_settings(
    body: SiteSettingsUpdateRequest,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """Admin-only — update site settings."""
    if body.since_date is not None:
        # Validate it's a real date
        datetime.strptime(body.since_date, "%Y-%m-%d")
        row = session.get(SiteSetting, "since_date")
        if row:
            row.value = body.since_date
        else:
            row = SiteSetting(key="since_date", value=body.since_date)
        session.add(row)

    if body.sync_since_date is not None:
        datetime.strptime(body.sync_since_date, "%Y-%m-%d")
        row = session.get(SiteSetting, "sync_since_date")
        if row:
            row.value = body.sync_since_date
        else:
            row = SiteSetting(key="sync_since_date", value=body.sync_since_date)
        session.add(row)

    if body.sync_interval_minutes is not None:
        row = session.get(SiteSetting, "sync_interval_minutes")
        if row:
            row.value = str(body.sync_interval_minutes)
        else:
            row = SiteSetting(
                key="sync_interval_minutes", value=str(body.sync_interval_minutes)
            )
        session.add(row)

    if body.auto_sync_enabled is not None:
        _set_bool_setting(session, "auto_sync_enabled", body.auto_sync_enabled)

    if body.auto_sync_mode is not None:
        row = session.get(SiteSetting, "auto_sync_mode")
        if row:
            row.value = body.auto_sync_mode
        else:
            row = SiteSetting(key="auto_sync_mode", value=body.auto_sync_mode)
        session.add(row)

    if body.show_prices is not None:
        _set_bool_setting(session, "show_prices", body.show_prices)

    if body.show_popularity is not None:
        _set_bool_setting(session, "show_popularity", body.show_popularity)

    if body.show_ratings is not None:
        _set_bool_setting(session, "show_ratings", body.show_ratings)

    if body.popularity_threshold is not None:
        row = session.get(SiteSetting, "popularity_threshold")
        if row:
            row.value = str(body.popularity_threshold)
        else:
            row = SiteSetting(
                key="popularity_threshold", value=str(body.popularity_threshold)
            )
        session.add(row)

    if body.event_color_bar_color is not None:
        row = session.get(SiteSetting, "event_color_bar_color")
        if row:
            row.value = body.event_color_bar_color
        else:
            row = SiteSetting(
                key="event_color_bar_color", value=body.event_color_bar_color
            )
        session.add(row)

    session.commit()

    return SiteSettingsResponse(
        since_date=_get_since_date(session),
        sync_since_date=_get_sync_since_date(session),
        sync_interval_minutes=_get_sync_interval(session),
        auto_sync_enabled=_get_auto_sync_enabled(session),
        auto_sync_mode=_get_auto_sync_mode(session),
        show_prices=_get_bool_setting(session, "show_prices"),
        show_popularity=_get_bool_setting(session, "show_popularity"),
        show_ratings=_get_bool_setting(session, "show_ratings"),
        popularity_threshold=_get_int_setting(session, "popularity_threshold", 10),
        event_color_bar_color=_get_str_setting(
            session, "event_color_bar_color", "#64748b"
        ),
    )
