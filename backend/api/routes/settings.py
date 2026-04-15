from datetime import datetime, timedelta

from fastapi import APIRouter, Depends
from sqlmodel import Session

from backend.api.deps import require_admin
from backend.api.schemas import SiteSettingsResponse, SiteSettingsUpdateRequest
from backend.config.loader import get_sync_interval_minutes
from backend.db.database import get_session
from backend.db.models import SiteSetting

router = APIRouter(prefix="/api/settings", tags=["settings"])

DEFAULT_SINCE_YEARS = 2


def _default_since_date() -> str:
    return (datetime.utcnow() - timedelta(days=DEFAULT_SINCE_YEARS * 365)).strftime(
        "%Y-%m-%d"
    )


def _get_since_date(session: Session) -> str:
    """Get the since_date setting from the DB, or default to 2 years ago."""
    try:
        row = session.get(SiteSetting, "since_date")
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


def _get_bool_setting(session: Session, key: str, default: bool = False) -> bool:
    """Get a boolean setting from the DB."""
    try:
        row = session.get(SiteSetting, key)
        if row:
            return row.value.lower() == "true"
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
        sync_interval_minutes=_get_sync_interval(session),
        show_prices=_get_bool_setting(session, "show_prices"),
        show_popularity=_get_bool_setting(session, "show_popularity"),
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

    if body.sync_interval_minutes is not None:
        row = session.get(SiteSetting, "sync_interval_minutes")
        if row:
            row.value = str(body.sync_interval_minutes)
        else:
            row = SiteSetting(
                key="sync_interval_minutes", value=str(body.sync_interval_minutes)
            )
        session.add(row)

    if body.show_prices is not None:
        _set_bool_setting(session, "show_prices", body.show_prices)

    if body.show_popularity is not None:
        _set_bool_setting(session, "show_popularity", body.show_popularity)

    session.commit()

    return SiteSettingsResponse(
        since_date=_get_since_date(session),
        sync_interval_minutes=_get_sync_interval(session),
        show_prices=_get_bool_setting(session, "show_prices"),
        show_popularity=_get_bool_setting(session, "show_popularity"),
    )
