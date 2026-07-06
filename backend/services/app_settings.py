"""Runtime accessors for the admin-configurable global notification gates.

These wrap the env-var-based getters in ``backend.config.loader`` with a
``SiteSetting`` lookup so the admin UI (``PUT /api/settings``) can toggle
kill switches without requiring a redeploy. Env vars remain the fallback
for local dev / test environments where the DB row is unset.

Callers should prefer these helpers over the raw ``get_*`` functions in
``config.loader`` for any value the admin panel exposes.
"""

from __future__ import annotations

from typing import Optional

from sqlmodel import Session

from backend.config import loader
from backend.db.database import get_engine
from backend.db.models import SiteSetting


DEFAULT_DIGEST_SCHEDULE = "tue,fri @ 09:00"
DEFAULT_INTEREST_MATCH_MAX_EVENTS_PER_EMAIL = 10


def _open_session(session: Optional[Session]) -> tuple[Session, bool]:
    """Return ``(session, opened_here)`` so callers can pass an existing one."""
    if session is not None:
        return session, False
    return Session(get_engine()), True


def _get_bool_row(session: Session, key: str) -> Optional[bool]:
    row = session.get(SiteSetting, key)
    if row is None or row.value is None:
        return None
    normalized = str(row.value).strip().lower()
    if normalized in ("1", "true", "yes", "on"):
        return True
    if normalized in ("0", "false", "no", "off"):
        return False
    return None


def _get_int_row(session: Session, key: str) -> Optional[int]:
    row = session.get(SiteSetting, key)
    if row is None or row.value is None:
        return None
    try:
        return int(row.value)
    except (TypeError, ValueError):
        return None


def _get_str_row(session: Session, key: str) -> Optional[str]:
    row = session.get(SiteSetting, key)
    if row is None or row.value is None:
        return None
    value = str(row.value).strip()
    return value or None


def get_event_reminders_enabled(session: Optional[Session] = None) -> bool:
    s, opened = _open_session(session)
    try:
        override = _get_bool_row(s, "event_reminders_enabled")
    finally:
        if opened:
            s.close()
    if override is not None:
        return override
    return loader.get_event_reminders_enabled()


def get_activity_digest_email_enabled(session: Optional[Session] = None) -> bool:
    s, opened = _open_session(session)
    try:
        override = _get_bool_row(s, "activity_digest_email_enabled")
    finally:
        if opened:
            s.close()
    if override is not None:
        return override
    return loader.get_activity_digest_email_enabled()


def get_interest_match_notifications_enabled(session: Optional[Session] = None) -> bool:
    s, opened = _open_session(session)
    try:
        override = _get_bool_row(s, "interest_match_notifications_enabled")
    finally:
        if opened:
            s.close()
    if override is not None:
        return override
    return loader.get_interest_match_notifications_enabled()


def get_web_push_enabled(session: Optional[Session] = None) -> bool:
    s, opened = _open_session(session)
    try:
        override = _get_bool_row(s, "web_push_enabled")
    finally:
        if opened:
            s.close()
    if override is not None:
        return override
    return loader.get_web_push_enabled()


def get_reminder_lead_hours(session: Optional[Session] = None) -> int:
    s, opened = _open_session(session)
    try:
        override = _get_int_row(s, "reminder_lead_hours")
    finally:
        if opened:
            s.close()
    if override is not None and override > 0:
        return override
    return loader.get_reminder_lead_hours()


def get_activity_digest_schedule(session: Optional[Session] = None) -> str:
    s, opened = _open_session(session)
    try:
        override = _get_str_row(s, "activity_digest_schedule")
    finally:
        if opened:
            s.close()
    return override or DEFAULT_DIGEST_SCHEDULE


def get_interest_match_max_events_per_email(session: Optional[Session] = None) -> int:
    """Max number of matched events shown inline in an interest-match
    digest email before the rest are collapsed behind a "Discover more"
    CTA linking to the "For you" page."""
    s, opened = _open_session(session)
    try:
        override = _get_int_row(s, "interest_match_max_events_per_email")
    finally:
        if opened:
            s.close()
    if override is not None and override > 0:
        return override
    return DEFAULT_INTEREST_MATCH_MAX_EVENTS_PER_EMAIL
