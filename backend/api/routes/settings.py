from datetime import datetime, timedelta

from fastapi import APIRouter, Depends
from sqlmodel import Session

from backend.api.deps import require_admin
from backend.api.schemas import SiteSettingsResponse, SiteSettingsUpdateRequest
from backend.config.loader import get_auto_sync_enabled, get_sync_interval_minutes
from backend.db.database import get_session
from backend.db.models import SiteSetting
from backend.services import app_settings

router = APIRouter(prefix="/api/settings", tags=["settings"])

DEFAULT_SINCE_DAYS = 183  # ~6 months
DEFAULT_EXPLORER_PERIOD = "next_3_months"
ALLOWED_DEFAULT_EXPLORER_PERIODS = {
    "this_weekend",
    "next_weekend",
    "next_7_days",
    "next_30_days",
    "next_3_months",
    "next_6_months",
    "this_season",
    "next_season_1",
    "next_season_2",
    "next_season_3",
}


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


def _get_default_explorer_period(session: Session) -> str:
    value = _get_str_setting(
        session, "default_explorer_period", DEFAULT_EXPLORER_PERIOD
    )
    if value in ALLOWED_DEFAULT_EXPLORER_PERIODS:
        return value
    return DEFAULT_EXPLORER_PERIOD


def _set_bool_setting(session: Session, key: str, value: bool) -> None:
    """Set a boolean setting in the DB."""
    row = session.get(SiteSetting, key)
    if row:
        row.value = str(value).lower()
    else:
        row = SiteSetting(key=key, value=str(value).lower())
    session.add(row)


def _build_response(session: Session) -> SiteSettingsResponse:
    """Assemble the full settings snapshot. Called by both GET and PUT."""
    return SiteSettingsResponse(
        since_date=_get_since_date(session),
        sync_since_date=_get_sync_since_date(session),
        sync_interval_minutes=_get_sync_interval(session),
        auto_sync_enabled=_get_auto_sync_enabled(session),
        auto_sync_mode=_get_auto_sync_mode(session),
        show_prices=_get_bool_setting(session, "show_prices"),
        show_popularity=_get_bool_setting(session, "show_popularity", default=True),
        show_ratings=_get_bool_setting(session, "show_ratings"),
        popularity_threshold=_get_int_setting(session, "popularity_threshold", 10),
        following_badge_enabled=_get_bool_setting(session, "following_badge_enabled"),
        unseen_state_enabled=_get_bool_setting(session, "unseen_state_enabled"),
        trending_enabled=_get_bool_setting(session, "trending_enabled", default=True),
        trending_banner_enabled=_get_bool_setting(
            session, "trending_banner_enabled", default=True
        ),
        trending_window_days=_get_int_setting(session, "trending_window_days", 30),
        trending_floor_going=_get_int_setting(session, "trending_floor_going", 3),
        trending_top_n=_get_int_setting(session, "trending_top_n", 3),
        trending_top_percent=_get_int_setting(session, "trending_top_percent", 100),
        event_color_bar_color=_get_str_setting(
            session, "event_color_bar_color", "#64748b"
        ),
        tag_sort_mode=_get_str_setting(session, "tag_sort_mode", "group"),
        default_explorer_period=_get_default_explorer_period(session),
        promo_codes_enabled=_get_bool_setting(session, "promo_codes_enabled"),
        organizer_claims_enabled=_get_bool_setting(session, "organizer_claims_enabled"),
        for_you_rail_enabled=_get_bool_setting(session, "for_you_rail_enabled"),
        your_next_events_rail_enabled=_get_bool_setting(
            session, "your_next_events_rail_enabled", default=True
        ),
        # These 6 gates are DB-first with an env-var fallback (see
        # backend/services/app_settings.py); read through that module here
        # so the admin UI always reflects the *effective* value (not just
        # whatever happens to be in site_settings) — previously this used
        # the local DB-only `_get_bool_setting` helper above, which ignored
        # the env fallback entirely and made e.g. web_push_enabled show
        # "disabled" even when WEB_PUSH_ENABLED=true was set at the env/fly
        # level with no site_settings override yet.
        event_reminders_enabled=app_settings.get_event_reminders_enabled(session),
        activity_digest_email_enabled=app_settings.get_activity_digest_email_enabled(
            session
        ),
        interest_match_notifications_enabled=app_settings.get_interest_match_notifications_enabled(
            session
        ),
        web_push_enabled=app_settings.get_web_push_enabled(session),
        reminder_lead_hours=app_settings.get_reminder_lead_hours(session),
        activity_digest_schedule=app_settings.get_activity_digest_schedule(session),
        interest_match_max_events_per_email=app_settings.get_interest_match_max_events_per_email(
            session
        ),
    )


@router.get("", response_model=SiteSettingsResponse)
def get_settings(session: Session = Depends(get_session)):
    """Public endpoint — returns site settings needed by the frontend."""
    return _build_response(session)


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

    if body.following_badge_enabled is not None:
        _set_bool_setting(
            session, "following_badge_enabled", body.following_badge_enabled
        )

    if body.unseen_state_enabled is not None:
        _set_bool_setting(session, "unseen_state_enabled", body.unseen_state_enabled)

    if body.trending_enabled is not None:
        _set_bool_setting(session, "trending_enabled", body.trending_enabled)

    if body.trending_banner_enabled is not None:
        _set_bool_setting(
            session, "trending_banner_enabled", body.trending_banner_enabled
        )

    if body.trending_window_days is not None:
        row = session.get(SiteSetting, "trending_window_days")
        if row:
            row.value = str(body.trending_window_days)
        else:
            row = SiteSetting(
                key="trending_window_days", value=str(body.trending_window_days)
            )
        session.add(row)

    if body.trending_floor_going is not None:
        row = session.get(SiteSetting, "trending_floor_going")
        if row:
            row.value = str(body.trending_floor_going)
        else:
            row = SiteSetting(
                key="trending_floor_going", value=str(body.trending_floor_going)
            )
        session.add(row)

    if body.trending_top_n is not None:
        row = session.get(SiteSetting, "trending_top_n")
        if row:
            row.value = str(body.trending_top_n)
        else:
            row = SiteSetting(key="trending_top_n", value=str(body.trending_top_n))
        session.add(row)

    if body.trending_top_percent is not None:
        row = session.get(SiteSetting, "trending_top_percent")
        if row:
            row.value = str(body.trending_top_percent)
        else:
            row = SiteSetting(
                key="trending_top_percent", value=str(body.trending_top_percent)
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

    if body.tag_sort_mode is not None:
        row = session.get(SiteSetting, "tag_sort_mode")
        if row:
            row.value = body.tag_sort_mode
        else:
            row = SiteSetting(key="tag_sort_mode", value=body.tag_sort_mode)
        session.add(row)

    if body.default_explorer_period is not None:
        row = session.get(SiteSetting, "default_explorer_period")
        if row:
            row.value = body.default_explorer_period
        else:
            row = SiteSetting(
                key="default_explorer_period", value=body.default_explorer_period
            )
        session.add(row)

    if body.promo_codes_enabled is not None:
        _set_bool_setting(session, "promo_codes_enabled", body.promo_codes_enabled)

    if body.organizer_claims_enabled is not None:
        _set_bool_setting(
            session, "organizer_claims_enabled", body.organizer_claims_enabled
        )

    if body.for_you_rail_enabled is not None:
        _set_bool_setting(session, "for_you_rail_enabled", body.for_you_rail_enabled)

    if body.your_next_events_rail_enabled is not None:
        _set_bool_setting(
            session,
            "your_next_events_rail_enabled",
            body.your_next_events_rail_enabled,
        )

    # Notification global gates.
    if body.event_reminders_enabled is not None:
        _set_bool_setting(
            session, "event_reminders_enabled", body.event_reminders_enabled
        )
    if body.activity_digest_email_enabled is not None:
        _set_bool_setting(
            session, "activity_digest_email_enabled", body.activity_digest_email_enabled
        )
    if body.interest_match_notifications_enabled is not None:
        _set_bool_setting(
            session,
            "interest_match_notifications_enabled",
            body.interest_match_notifications_enabled,
        )
    if body.web_push_enabled is not None:
        _set_bool_setting(session, "web_push_enabled", body.web_push_enabled)
    if body.reminder_lead_hours is not None:
        row = session.get(SiteSetting, "reminder_lead_hours")
        if row:
            row.value = str(body.reminder_lead_hours)
        else:
            row = SiteSetting(
                key="reminder_lead_hours", value=str(body.reminder_lead_hours)
            )
        session.add(row)
    if body.activity_digest_schedule is not None:
        row = session.get(SiteSetting, "activity_digest_schedule")
        if row:
            row.value = body.activity_digest_schedule
        else:
            row = SiteSetting(
                key="activity_digest_schedule", value=body.activity_digest_schedule
            )
        session.add(row)

    if body.interest_match_max_events_per_email is not None:
        row = session.get(SiteSetting, "interest_match_max_events_per_email")
        if row:
            row.value = str(body.interest_match_max_events_per_email)
        else:
            row = SiteSetting(
                key="interest_match_max_events_per_email",
                value=str(body.interest_match_max_events_per_email),
            )
        session.add(row)

    session.commit()

    return _build_response(session)
