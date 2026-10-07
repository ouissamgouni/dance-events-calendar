"""IANA time zone of an event, resolved from the most trustworthy signal available."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from functools import lru_cache
from typing import Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import event, inspect
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


def valid_timezone(name: Optional[str]) -> Optional[str]:
    if not name:
        return None
    try:
        ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return None
    return name


def to_event_local(value: datetime, tz_name: Optional[str]) -> datetime:
    """A stored UTC instant as wall-clock time in ``tz_name`` (UTC when unknown)."""
    aware = value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value
    return aware.astimezone(ZoneInfo(valid_timezone(tz_name) or "UTC"))


@lru_cache(maxsize=1)
def _finder():
    from timezonefinder import TimezoneFinder

    return TimezoneFinder()


def tz_for_point(
    latitude: Optional[float], longitude: Optional[float]
) -> Optional[str]:
    if latitude is None or longitude is None:
        return None
    try:
        return valid_timezone(_finder().timezone_at(lat=latitude, lng=longitude))
    except ValueError:
        logger.warning("No time zone for point (%s, %s)", latitude, longitude)
        return None


def resolve_event_timezone(
    *,
    explicit: Optional[str] = None,
    latitude: Optional[float] = None,
    longitude: Optional[float] = None,
    source_event: Optional[str] = None,
    source_calendar: Optional[str] = None,
    submitter: Optional[str] = None,
) -> Optional[str]:
    """Explicit choice > venue > source event zone > source calendar zone > submitter browser."""
    return (
        valid_timezone(explicit)
        or tz_for_point(latitude, longitude)
        or valid_timezone(source_event)
        or valid_timezone(source_calendar)
        or valid_timezone(submitter)
    )


def _sync_timezone_with_venue(obj) -> None:
    if obj.latitude is None or obj.longitude is None:
        return
    state = inspect(obj)
    if state.pending:
        if obj.timezone:
            return
    else:
        moved = (
            state.attrs.latitude.history.has_changes()
            or state.attrs.longitude.history.has_changes()
        )
        if not moved or state.attrs.timezone.history.has_changes():
            return
    obj.timezone = tz_for_point(obj.latitude, obj.longitude) or obj.timezone


@event.listens_for(Session, "before_flush")
def _venue_timezones(session, _flush_context, _instances) -> None:
    # Keeps the zone in step with geocoding wherever coordinates get written.
    from backend.db.models import CachedEvent, EventSuggestion

    for obj in (*session.new, *session.dirty):
        if isinstance(obj, (CachedEvent, EventSuggestion)):
            _sync_timezone_with_venue(obj)
