"""Upcoming events similar to one the viewer attended: shared dance styles, nearby by reach."""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import func
from sqlmodel import Session, col, select

from backend.db.models import (
    CachedEvent,
    CalendarSetting,
    EventSeries,
    EventSeriesMember,
    EventTag,
    Tag,
    TagGroup,
    User,
    UserEventAttendance,
    UserInterestProfile,
    UserSavedEvent,
)
from backend.services import app_settings
from backend.services.event_visibility import apply_event_visibility, discovery_clause
from backend.services.tag_hierarchy import drop_superseded_parents

DANCE_STYLE_GROUP_SLUG = "dance-style"
KM_PER_DEG_LAT = 111.32
MIN_RESULTS_BEFORE_WIDEN = 3
POSITIVE_SENTIMENTS = {"amazing", "great"}
NEGATIVE_SENTIMENTS = {"disappointing", "bad"}

# Reviewed event reach -> (radius setting, allowed candidate reaches, Explorer reach filter).
_REACH_RULES: dict[str, tuple[str, Optional[tuple[str, ...]], str]] = {
    "local": ("similar_events_radius_local_km", None, "any"),
    "regional": (
        "similar_events_radius_regional_km",
        ("regional", "international"),
        "regional_plus",
    ),
    "international": (
        "similar_events_radius_international_km",
        ("international",),
        "international",
    ),
}


@dataclass
class SimilarArea:
    label: Optional[str]
    min_lat: float
    min_lng: float
    max_lat: float
    max_lng: float
    center_lat: Optional[float] = None
    center_lng: Optional[float] = None
    radius_km: Optional[float] = None


@dataclass
class SimilarEventsResult:
    event_ids: list[str] = field(default_factory=list)
    style_tag_ids: list[int] = field(default_factory=list)
    reach_filter: str = "any"
    area: Optional[SimilarArea] = None


def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371.0 * math.asin(math.sqrt(min(1.0, a)))


def _radius_area(
    label: Optional[str], lat: float, lng: float, radius_km: float
) -> SimilarArea:
    dlat = radius_km / KM_PER_DEG_LAT
    dlng = radius_km / (KM_PER_DEG_LAT * max(0.01, math.cos(math.radians(lat))))
    return SimilarArea(
        label=label,
        min_lat=max(-90.0, lat - dlat),
        max_lat=min(90.0, lat + dlat),
        min_lng=max(-180.0, lng - dlng),
        max_lng=min(180.0, lng + dlng),
        center_lat=lat,
        center_lng=lng,
        radius_km=radius_km,
    )


def _dance_style_tag_ids(session: Session, event_id: str) -> list[int]:
    ids = session.exec(
        select(EventTag.tag_id)
        .join(Tag, Tag.id == EventTag.tag_id)
        .join(TagGroup, TagGroup.id == Tag.group_id)
        .where(EventTag.event_id == event_id, TagGroup.slug == DANCE_STYLE_GROUP_SLUG)
    ).all()
    return drop_superseded_parents(session, ids)


def _parent_tag_ids(session: Session, tag_ids: list[int]) -> list[int]:
    if not tag_ids:
        return []
    parents = session.exec(
        select(Tag.parent_tag_id).where(
            col(Tag.id).in_(tag_ids), col(Tag.parent_tag_id).is_not(None)
        )
    ).all()
    return list(dict.fromkeys([*tag_ids, *(int(p) for p in parents)]))


def _international_area(session: Session, viewer: User) -> Optional[SimilarArea]:
    profile = session.exec(
        select(UserInterestProfile)
        .where(
            UserInterestProfile.user_id == viewer.id,
            UserInterestProfile.reach_filter == "international",
        )
        .order_by(
            col(UserInterestProfile.is_active).desc(), col(UserInterestProfile.id)
        )
    ).first()
    if profile is None:
        return None
    return SimilarArea(
        label=profile.area_label,
        min_lat=profile.min_lat,
        min_lng=profile.min_lng,
        max_lat=profile.max_lat,
        max_lng=profile.max_lng,
    )


def _series_event_ids(session: Session, event_id: str) -> set[str]:
    series_id = session.exec(
        select(EventSeriesMember.series_id)
        .join(EventSeries, EventSeries.id == EventSeriesMember.series_id)
        .where(EventSeriesMember.event_id == event_id, EventSeries.status == "resolved")
    ).first()
    if series_id is None:
        return set()
    return set(
        session.exec(
            select(EventSeriesMember.event_id).where(
                EventSeriesMember.series_id == series_id
            )
        ).all()
    )


def _candidates(
    session: Session,
    event: CachedEvent,
    viewer: User,
    style_ids: list[int],
    area: SimilarArea,
    allowed_reaches: Optional[tuple[str, ...]],
    now: datetime,
) -> list[tuple[CachedEvent, int]]:
    calendar_ids = select(CalendarSetting.calendar_id).where(
        CalendarSetting.show_events == True  # noqa: E712
    )
    style_matches = func.count(EventTag.tag_id).label("style_matches")
    query = (
        select(CachedEvent, style_matches)
        .join(EventTag, EventTag.event_id == CachedEvent.event_id)
        .where(
            col(EventTag.tag_id).in_(style_ids),
            col(CachedEvent.calendar_id).in_(calendar_ids),
            col(CachedEvent.deleted_at).is_(None),
            CachedEvent.is_hidden == False,  # noqa: E712
            CachedEvent.start >= now,
            CachedEvent.event_id != event.event_id,
            col(CachedEvent.latitude).is_not(None),
            col(CachedEvent.longitude).is_not(None),
            CachedEvent.latitude >= area.min_lat,
            CachedEvent.latitude <= area.max_lat,
            CachedEvent.longitude >= area.min_lng,
            CachedEvent.longitude <= area.max_lng,
            col(CachedEvent.event_id).not_in(
                select(UserSavedEvent.event_id).where(
                    UserSavedEvent.user_id == viewer.id
                )
            ),
            col(CachedEvent.event_id).not_in(
                select(UserEventAttendance.event_id).where(
                    UserEventAttendance.user_id == viewer.id
                )
            ),
        )
        .group_by(CachedEvent.event_id)
    )
    if allowed_reaches is not None:
        query = query.where(col(CachedEvent.reach).in_(allowed_reaches))
    query = apply_event_visibility(query, session).where(discovery_clause())
    rows = session.exec(query).all()
    if area.radius_km is None:
        return list(rows)
    return [
        (ev, matches)
        for ev, matches in rows
        if _haversine_km(area.center_lat, area.center_lng, ev.latitude, ev.longitude)
        <= area.radius_km
    ]


def similar_events(
    session: Session,
    event: CachedEvent,
    viewer: User,
    sentiment: Optional[str] = None,
    now: Optional[datetime] = None,
) -> SimilarEventsResult:
    now = now or datetime.now(timezone.utc)
    reach = event.reach if event.reach in _REACH_RULES else "local"
    radius_key, allowed_reaches, reach_filter = _REACH_RULES[reach]
    style_ids = _dance_style_tag_ids(session, event.event_id)
    result = SimilarEventsResult(style_tag_ids=style_ids, reach_filter=reach_filter)
    if not style_ids or event.latitude is None or event.longitude is None:
        return result

    label = event.city or event.location
    area = _international_area(session, viewer) if reach == "international" else None
    if area is None:
        radius = app_settings.get_review_home_prompt_int(radius_key, session)
        area = _radius_area(label, event.latitude, event.longitude, radius)
    result.area = area

    # Widen until enough: specific styles, then their parent families, then double radius.
    ladder: list[tuple[list[int], SimilarArea]] = [(style_ids, area)]
    family_ids = _parent_tag_ids(session, style_ids)
    if family_ids != style_ids:
        ladder.append((family_ids, area))
    if area.radius_km is not None:
        ladder.append(
            (
                family_ids,
                _radius_area(
                    label, event.latitude, event.longitude, area.radius_km * 2
                ),
            )
        )
    rows: list[tuple[CachedEvent, int]] = []
    for ids, step_area in ladder:
        rows = _candidates(session, event, viewer, ids, step_area, allowed_reaches, now)
        if len(rows) >= MIN_RESULTS_BEFORE_WIDEN:
            break

    series_ids = _series_event_ids(session, event.event_id)
    if sentiment in NEGATIVE_SENTIMENTS:
        rows = [(ev, m) for ev, m in rows if ev.event_id not in series_ids]

    going: dict[str, int] = {}
    if rows:
        going = dict(
            session.exec(
                select(UserEventAttendance.event_id, func.count(UserEventAttendance.id))
                .where(
                    col(UserEventAttendance.event_id).in_(
                        [ev.event_id for ev, _ in rows]
                    )
                )
                .group_by(UserEventAttendance.event_id)
            ).all()
        )
    pin_series = sentiment in POSITIVE_SENTIMENTS
    rows.sort(
        key=lambda r: (
            0 if pin_series and r[0].event_id in series_ids else 1,
            -r[1],
            r[0].start,
            -going.get(r[0].event_id, 0),
        )
    )
    limit = app_settings.get_review_home_prompt_int("similar_events_limit", session)
    result.event_ids = [ev.event_id for ev, _ in rows[:limit]]
    return result


def similar_events_count(
    session: Session, event: CachedEvent, viewer: User, now: Optional[datetime] = None
) -> int:
    return len(similar_events(session, event, viewer, now=now).event_ids)
