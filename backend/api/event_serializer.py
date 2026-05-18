"""Helper to serialize CachedEvent rows into ``EventResponse`` payloads.

Centralizes the batch-fetch of view counts, going counts, tags, and
calendar colors so endpoints that surface event lists (Phase D profile
tabs, etc.) don't have to re-implement the N+1-avoidance pattern.

The two existing call sites in ``backend.api.routes.events`` predate this
helper; they remain inline to keep that diff out of Phase D.
"""

from typing import Iterable

from sqlalchemy import func
from sqlmodel import Session, select

from backend.api.routes.tags import get_event_tags
from backend.api.schemas import EventResponse
from backend.db.models import (
    CachedEvent,
    CalendarSetting,
    EventView,
    SiteSetting,
    UserEventAttendance,
)
from backend.services.popularity import compute_popularity_scores, get_saved_counts


def _trending_settings(session: Session) -> tuple[bool, int, int]:
    """Read the trending feature flag + window/floor knobs from SiteSetting.

    Returns ``(enabled, window_days, floor_going)``. Defaults match the
    same values used in ``backend.api.routes.settings``.
    """
    enabled = False
    window_days = 30
    floor_going = 3
    try:
        row = session.get(SiteSetting, "trending_enabled")
        if row and row.value.lower() == "true":
            enabled = True
        row = session.get(SiteSetting, "trending_window_days")
        if row and row.value.isdigit():
            window_days = int(row.value)
        row = session.get(SiteSetting, "trending_floor_going")
        if row and row.value.lstrip("-").isdigit():
            floor_going = int(row.value)
    except Exception:
        pass
    return enabled, window_days, floor_going


def serialize_events(
    session: Session, events: Iterable[CachedEvent]
) -> list[EventResponse]:
    """Hydrate a list of CachedEvent rows into ``EventResponse`` payloads.

    Batch-fetches view counts, going counts, tags, and calendar colors in
    one query each to avoid N+1. Order of returned items mirrors the input
    order (callers sort upstream).
    """
    events_list = list(events)
    if not events_list:
        return []

    event_ids = [e.event_id for e in events_list]
    calendar_ids = list({e.calendar_id for e in events_list})

    color_rows = session.exec(
        select(CalendarSetting.calendar_id, CalendarSetting.color).where(
            CalendarSetting.calendar_id.in_(calendar_ids)
        )
    ).all()
    color_map = {row[0]: row[1] for row in color_rows}

    view_rows = session.exec(
        select(EventView.event_id, func.count(EventView.id))
        .where(EventView.event_id.in_(event_ids))
        .group_by(EventView.event_id)
    ).all()
    view_counts = {row[0]: row[1] for row in view_rows}

    going_rows = session.exec(
        select(UserEventAttendance.event_id, func.count(UserEventAttendance.id))
        .where(UserEventAttendance.event_id.in_(event_ids))
        .group_by(UserEventAttendance.event_id)
    ).all()
    going_counts = {row[0]: row[1] for row in going_rows}

    saved_counts = get_saved_counts(session, event_ids)

    trending_on, window_days, floor_going = _trending_settings(session)
    if trending_on:
        scores = compute_popularity_scores(
            session,
            events_list,
            window_days=window_days,
            floor_going=floor_going,
        )
    else:
        scores = {}

    tags_map = get_event_tags(session, event_ids)

    return [
        EventResponse(
            event_id=e.event_id,
            calendar_id=e.calendar_id,
            title=e.title,
            description=e.description,
            location=e.location,
            start=e.start,
            end=e.end,
            all_day=e.all_day,
            latitude=e.latitude,
            longitude=e.longitude,
            color=color_map.get(e.calendar_id),
            view_count=view_counts.get(e.event_id, 0),
            going_count=going_counts.get(e.event_id, 0),
            saved_count=saved_counts.get(e.event_id, 0),
            popularity_score=scores.get(e.event_id, 0.0),
            price_min=e.price_min,
            price_max=e.price_max,
            price_currency=e.price_currency,
            price_is_free=e.price_is_free,
            links=e.links,
            tags=tags_map.get(e.event_id, []),
        )
        for e in events_list
    ]
