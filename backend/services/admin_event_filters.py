"""Admin events list: extra filter/sort clauses over ``CachedEvent``."""

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Optional

from sqlalchemy import String, and_, cast, func, not_, or_, union_all
from sqlalchemy.orm import aliased
from sqlmodel import col, select

from backend.db.models import (
    CachedEvent,
    EventLinkClick,
    EventMessage,
    EventPromoCode,
    EventRating,
    EventSchedule,
    EventSeries,
    EventSeriesMember,
    EventTag,
    EventUserAsset,
    EventView,
    SchedulePublication,
    UserEventAttendance,
    UserSavedEvent,
)
from backend.services.event_assets import KIND_MEMORY

PRICE_LABELS = {"paid": "Paid", "free": "Free", "unknown": "Unknown"}
DISCOUNT_LABELS = {"active": "Active", "expired": "Expired"}
PROGRAM_LABELS = {"published": "Published", "draft": "Draft", "none": "None"}
REACH_LABELS = {
    "local": "Local",
    "regional": "Regional",
    "international": "International",
    "unset": "Unset",
}
COUNT_KINDS = ("going", "saved", "engaged", "ratings", "messages", "memories")
SORT_KEYS = (
    "start",
    "submitted",
    "title",
    "price",
    "views",
    "clicks",
    *COUNT_KINDS,
)


def csv_pattern(values) -> str:
    alt = "|".join(values)
    return rf"^({alt})(,({alt}))*$"


def csv_values(value: Optional[str]) -> list[str]:
    return [v for v in (value or "").split(",") if v]


@dataclass(frozen=True)
class AdminEventFilters:
    search: Optional[str] = None
    audience: Optional[str] = None
    status: Optional[str] = None
    flags: Optional[str] = None
    calendar_id: Optional[str] = None
    tag_ids: Optional[str] = None
    geo_status: Optional[str] = None
    ungeolocated: Optional[bool] = None
    future_only: Optional[bool] = None
    include_past: bool = False
    price: Optional[str] = None
    discount: Optional[str] = None
    program: Optional[str] = None
    reach: Optional[str] = None
    going_min: Optional[int] = None
    saved_min: Optional[int] = None
    engaged_min: Optional[int] = None
    has_ratings: Optional[bool] = None
    has_messages: Optional[bool] = None
    has_memories: Optional[bool] = None
    has_organizer: Optional[bool] = None
    has_image: Optional[bool] = None
    has_links: Optional[bool] = None
    has_tags: Optional[bool] = None
    in_series: Optional[bool] = None
    start_from: Optional[date] = None
    start_to: Optional[date] = None


def price_clause(value: str):
    not_free = or_(
        col(CachedEvent.price_is_free).is_(None),
        col(CachedEvent.price_is_free).is_(False),
    )
    if value == "free":
        return col(CachedEvent.price_is_free).is_(True)
    if value == "paid":
        return and_(not_free, col(CachedEvent.price_min).is_not(None))
    return and_(not_free, col(CachedEvent.price_min).is_(None))


def discount_clause(value: str, now: Optional[datetime] = None):
    now = now or datetime.now(timezone.utc)
    codes = select(EventPromoCode.event_id).where(EventPromoCode.status == "approved")
    if value == "active":
        codes = codes.where(
            or_(
                col(EventPromoCode.expires_at).is_(None),
                col(EventPromoCode.expires_at) > now,
            )
        )
    else:
        codes = codes.where(col(EventPromoCode.expires_at) <= now)
    return col(CachedEvent.event_id).in_(codes)


def _published_schedule_ids():
    return select(EventSchedule.event_id).join(
        SchedulePublication, SchedulePublication.schedule_id == EventSchedule.id
    )


def program_clause(value: str):
    scheduled = select(EventSchedule.event_id)
    if value == "published":
        return col(CachedEvent.event_id).in_(_published_schedule_ids())
    if value == "draft":
        return and_(
            col(CachedEvent.event_id).in_(scheduled),
            col(CachedEvent.event_id).not_in(_published_schedule_ids()),
        )
    return col(CachedEvent.event_id).not_in(scheduled)


def reach_clause(value: str):
    if value == "unset":
        return col(CachedEvent.reach).is_(None)
    return CachedEvent.reach == value


def count_query(kind: str):
    """``(event_id, n)`` per event for ``kind``; callers add ``where``."""
    if kind == "engaged":
        pairs = union_all(
            select(UserEventAttendance.event_id, UserEventAttendance.device_id),
            select(UserSavedEvent.event_id, UserSavedEvent.device_id),
        ).subquery()
        return (
            select(
                pairs.c.event_id,
                func.count(func.distinct(pairs.c.device_id)).label("n"),
            ).group_by(pairs.c.event_id),
            pairs.c.event_id,
        )
    model, extra = {
        "going": (UserEventAttendance, None),
        "saved": (UserSavedEvent, None),
        "ratings": (EventRating, EventRating.status != "rejected"),
        "messages": (EventMessage, col(EventMessage.deleted_at).is_(None)),
        "memories": (EventUserAsset, EventUserAsset.kind == KIND_MEMORY),
        "views": (EventView, None),
        "clicks": (EventLinkClick, None),
    }[kind]
    stmt = select(model.event_id, func.count().label("n")).group_by(model.event_id)
    if extra is not None:
        stmt = stmt.where(extra)
    return stmt, model.event_id


def _min_count_clause(kind: str, minimum: int):
    counts = count_query(kind)[0].subquery()
    return col(CachedEvent.event_id).in_(
        select(counts.c.event_id).where(counts.c.n >= minimum)
    )


def _has_clause(name: str):
    if name == "has_ratings":
        return col(CachedEvent.event_id).in_(
            select(EventRating.event_id).where(EventRating.status != "rejected")
        )
    if name == "has_messages":
        return col(CachedEvent.event_id).in_(
            select(EventMessage.event_id).where(col(EventMessage.deleted_at).is_(None))
        )
    if name == "has_memories":
        return col(CachedEvent.event_id).in_(
            select(EventUserAsset.event_id).where(EventUserAsset.kind == KIND_MEMORY)
        )
    if name == "has_organizer":
        return col(CachedEvent.organizer_user_id).is_not(None)
    if name == "has_image":
        return or_(
            col(CachedEvent.image_key).is_not(None),
            col(CachedEvent.image_url).is_not(None),
        )
    if name == "has_links":
        # JSON columns persist Python None as the JSON literal 'null'.
        return func.coalesce(cast(CachedEvent.links, String), "null").not_in(
            ("null", "[]")
        )
    if name == "has_tags":
        return col(CachedEvent.event_id).in_(select(EventTag.event_id))
    # in_series: mirrors admin._in_series_ids.
    other = aliased(CachedEvent)
    recurring = (
        select(other.suggestion_id)
        .where(other.suggestion_id.is_not(None))
        .group_by(other.suggestion_id)
        .having(func.count() > 1)
    )
    grouped = (
        select(EventSeriesMember.event_id)
        .join(EventSeries, EventSeries.id == EventSeriesMember.series_id)
        .where(EventSeries.status == "resolved")
    )
    return or_(
        col(CachedEvent.event_id).in_(grouped),
        and_(
            col(CachedEvent.suggestion_id).is_not(None),
            col(CachedEvent.suggestion_id).in_(recurring),
        ),
    )


HAS_FILTERS = (
    "has_ratings",
    "has_messages",
    "has_memories",
    "has_organizer",
    "has_image",
    "has_links",
    "has_tags",
    "in_series",
)


MIN_FILTERS = ("going_min", "saved_min", "engaged_min")

DIMENSION_FIELDS = (
    "audience",
    "status",
    "flags",
    "calendar_id",
    "tag_ids",
    "geo_status",
    "price",
    "discount",
    "program",
    "reach",
    *MIN_FILTERS,
    *HAS_FILTERS,
)

# Mirrors the frontend quick views.
QUICK_VIEWS = {
    "all": {},
    "review": {"status": "new"},
    "changes": {"flags": "changes"},
    "public": {"flags": "wants_public"},
    "geo": {"geo_status": "ungeolocated"},
    "untagged": {"has_tags": False},
}


def apply_extra_filters(stmt, f: AdminEventFilters):
    """Price/discount/program/reach facets, counts, has-X switches and dates."""
    for values, clause in (
        (f.price, price_clause),
        (f.discount, discount_clause),
        (f.program, program_clause),
        (f.reach, reach_clause),
    ):
        selected = csv_values(values)
        if selected:
            stmt = stmt.where(or_(*(clause(v) for v in selected)))
    for kind, minimum in (
        ("going", f.going_min),
        ("saved", f.saved_min),
        ("engaged", f.engaged_min),
    ):
        if minimum:
            stmt = stmt.where(_min_count_clause(kind, minimum))
    for name in HAS_FILTERS:
        value = getattr(f, name)
        if value is not None:
            clause = _has_clause(name)
            stmt = stmt.where(clause if value else not_(clause))
    # Naive UTC, matching the admin upcoming filter.
    if f.start_from:
        stmt = stmt.where(CachedEvent.start >= datetime.combine(f.start_from, time.min))
    if f.start_to:
        stmt = stmt.where(
            CachedEvent.start
            < datetime.combine(f.start_to + timedelta(days=1), time.min)
        )
    return stmt
