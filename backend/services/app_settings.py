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
DEFAULT_DIGEST_PER_KIND_CAP = 5
DEFAULT_DIGEST_MAX_ITEMS = 20


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


def get_milestone_notifications_enabled(session: Optional[Session] = None) -> bool:
    s, opened = _open_session(session)
    try:
        override = _get_bool_row(s, "milestone_notifications_enabled")
    finally:
        if opened:
            s.close()
    if override is not None:
        return override
    return loader.get_milestone_notifications_enabled()


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


def get_digest_v2_enabled(session: Optional[Session] = None) -> bool:
    s, opened = _open_session(session)
    try:
        override = _get_bool_row(s, "digest_v2_enabled")
    finally:
        if opened:
            s.close()
    if override is not None:
        return override
    return loader.get_digest_v2_enabled()


def get_digest_per_kind_cap(session: Optional[Session] = None) -> int:
    s, opened = _open_session(session)
    try:
        override = _get_int_row(s, "digest_per_kind_cap")
    finally:
        if opened:
            s.close()
    if override is not None and override > 0:
        return override
    return loader.get_digest_per_kind_cap()


def get_digest_max_items(session: Optional[Session] = None) -> int:
    s, opened = _open_session(session)
    try:
        override = _get_int_row(s, "digest_max_items")
    finally:
        if opened:
            s.close()
    if override is not None and override > 0:
        return override
    return loader.get_digest_max_items()


def get_review_prompt_enabled(session: Optional[Session] = None) -> bool:
    s, opened = _open_session(session)
    try:
        override = _get_bool_row(s, "review_prompt_enabled")
    finally:
        if opened:
            s.close()
    if override is not None:
        return override
    return loader.get_review_prompt_enabled()


def get_review_prompt_delay_hours(session: Optional[Session] = None) -> int:
    s, opened = _open_session(session)
    try:
        override = _get_int_row(s, "review_prompt_delay_hours")
    finally:
        if opened:
            s.close()
    if override is not None and override > 0:
        return override
    return loader.get_review_prompt_delay_hours()


def get_review_prompt_lookback_hours(session: Optional[Session] = None) -> int:
    s, opened = _open_session(session)
    try:
        override = _get_int_row(s, "review_prompt_lookback_hours")
    finally:
        if opened:
            s.close()
    if override is not None and override > 0:
        return override
    return loader.get_review_prompt_lookback_hours()


def get_for_you_review_window_days(session: Optional[Session] = None) -> int:
    s, opened = _open_session(session)
    try:
        override = _get_int_row(s, "for_you_review_window_days")
    finally:
        if opened:
            s.close()
    if override is not None and override > 0:
        return override
    return loader.get_for_you_review_window_days()


def get_review_mood_headline_min_reviews(session: Optional[Session] = None) -> int:
    s, opened = _open_session(session)
    try:
        override = _get_int_row(s, "review_mood_headline_min_reviews")
    finally:
        if opened:
            s.close()
    if override is not None and override > 0:
        return override
    return loader.get_review_mood_headline_min_reviews()


def get_event_message_cta_min_going(session: Optional[Session] = None) -> int:
    s, opened = _open_session(session)
    try:
        override = _get_int_row(s, "event_message_cta_min_going")
    finally:
        if opened:
            s.close()
    if override is not None and override > 0:
        return override
    return loader.get_event_message_cta_min_going()


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


# Activity features whose email delivery route (instant / digest) the admin
# can configure independently. Each maps to two SiteSetting keys:
# ``<feature>_email_instant`` and ``<feature>_email_digest``.
EMAIL_MODE_FEATURES = (
    "friends_going",
    "social_activity",
    "friend_reviews",
    "friend_milestones",
    "interest_matches",
    "milestone_unlocked",
    "event_messages",
    "suggested_events",
)


def get_feature_email_instant(feature: str, session: Optional[Session] = None) -> bool:
    """Admin route toggle: send ``feature`` emails immediately (non-batched)?

    Defaults to False so features stay digest-only unless an admin opts in.
    """
    s, opened = _open_session(session)
    try:
        override = _get_bool_row(s, f"{feature}_email_instant")
    finally:
        if opened:
            s.close()
    return override if override is not None else False


def get_feature_email_digest(feature: str, session: Optional[Session] = None) -> bool:
    """Admin route toggle: include ``feature`` in the batched digest email?

    Defaults to True (current behaviour for every activity feature).
    """
    s, opened = _open_session(session)
    try:
        override = _get_bool_row(s, f"{feature}_email_digest")
    finally:
        if opened:
            s.close()
    return override if override is not None else True
