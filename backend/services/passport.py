"""Dance Passport aggregation: a dancer's retrospective journey.

Stats/collections/timeline are computed from events the user marked *Going*
whose ``start`` is already in the past (``UserEventAttendance`` + ``CachedEvent``).
All queries are user-scoped, so private-audience attendances are included — the
owner is the only viewer of their passport.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from uuid import UUID

from sqlalchemy import func
from sqlmodel import Session, select

from backend.db.models import (
    CachedEvent,
    EventRating,
    EventTag,
    Tag,
    TagGroup,
    UserEventAttendance,
    UserMilestone,
)


def attended_events(session: Session, user_id: UUID) -> list[CachedEvent]:
    """Past events (start < now) the user is currently marked Going for.

    Deduplicated by ``event_id`` and ordered newest-first.
    """
    now = datetime.utcnow()
    rows = session.exec(
        select(CachedEvent)
        .join(
            UserEventAttendance,
            UserEventAttendance.event_id == CachedEvent.event_id,
        )
        .where(UserEventAttendance.user_id == user_id)
        .where(CachedEvent.start < now)
        .where(CachedEvent.deleted_at.is_(None))
        .order_by(CachedEvent.start.desc())
    ).all()
    seen: set[str] = set()
    unique: list[CachedEvent] = []
    for event in rows:
        if event.event_id in seen:
            continue
        seen.add(event.event_id)
        unique.append(event)
    return unique


def _style_slugs(session: Session, event_ids: list[str]) -> set[str]:
    if not event_ids:
        return set()
    rows = session.exec(
        select(Tag.slug)
        .join(EventTag, EventTag.tag_id == Tag.id)
        .join(TagGroup, TagGroup.id == Tag.group_id)
        .where(TagGroup.slug == "dance-style")
        .where(EventTag.event_id.in_(event_ids))
    ).all()
    return {slug for slug in rows}


def has_international_reach(session: Session, event_ids: list[str]) -> bool:
    """True if any attended event carries the ``reach:international`` tag."""
    if not event_ids:
        return False
    row = session.exec(
        select(Tag.id)
        .join(EventTag, EventTag.tag_id == Tag.id)
        .join(TagGroup, TagGroup.id == Tag.group_id)
        .where(TagGroup.slug == "reach")
        .where(Tag.slug == "international")
        .where(EventTag.event_id.in_(event_ids))
        .limit(1)
    ).first()
    return row is not None


def longest_month_streak(events: list[CachedEvent]) -> int:
    """Longest run of consecutive calendar months containing >=1 attended event."""
    months = sorted({(e.start.year, e.start.month) for e in events})
    if not months:
        return 0
    best = current = 1
    for prev, nxt in zip(months, months[1:]):
        prev_index = prev[0] * 12 + prev[1]
        next_index = nxt[0] * 12 + nxt[1]
        if next_index - prev_index == 1:
            current += 1
            best = max(best, current)
        else:
            current = 1
    return best


def reviews_written(session: Session, user_id: UUID) -> int:
    return int(
        session.exec(
            select(func.count())
            .select_from(EventRating)
            .where(EventRating.user_id == user_id)
            .where(EventRating.status != "rejected")
        ).one()
    )


def events_last_30_days(events: list[CachedEvent]) -> int:
    """Attended events whose start falls in the trailing 30 days."""
    cutoff = datetime.utcnow() - timedelta(days=30)
    return sum(1 for e in events if e.start >= cutoff)


def average_gap_days(events: list[CachedEvent]) -> float | None:
    """Mean number of days between consecutive attended events.

    ``None`` when fewer than two events (no gap to measure).
    """
    if len(events) < 2:
        return None
    starts = sorted(e.start for e in events)
    span_days = (starts[-1] - starts[0]).total_seconds() / 86400
    return round(span_days / (len(starts) - 1), 1)


def build_stats_context(session: Session, user) -> dict:
    """Compute the raw passport context shared by stats, collections and
    milestone evaluation."""
    events = attended_events(session, user.id)
    event_ids = [e.event_id for e in events]
    cities = {(e.city, e.country) for e in events if e.city}
    countries = {e.country for e in events if e.country}
    styles = _style_slugs(session, event_ids)
    return {
        "events": events,
        "event_ids": event_ids,
        "total_events": len(events),
        "cities": cities,
        "countries": countries,
        "styles": styles,
        "reviews": reviews_written(session, user.id),
        "has_international": has_international_reach(session, event_ids),
        "longest_streak": longest_month_streak(events),
        "events_last_30d": events_last_30_days(events),
        "avg_gap_days": average_gap_days(events),
        "first_event_date": events[-1].start if events else None,
        "member_since": user.created_at,
    }


def collections(events: list[CachedEvent]) -> dict:
    """Group attended events into city/country stamps with counts."""
    city_counts: dict[tuple[str, str | None], int] = {}
    city_coords: dict[tuple[str, str | None], tuple[float, float]] = {}
    country_counts: dict[str, int] = {}
    for event in events:
        if event.city:
            key = (event.city, event.country)
            city_counts[key] = city_counts.get(key, 0) + 1
            if (
                key not in city_coords
                and event.latitude is not None
                and event.longitude is not None
            ):
                city_coords[key] = (event.latitude, event.longitude)
        if event.country:
            country_counts[event.country] = country_counts.get(event.country, 0) + 1
    city_list = [
        {
            "city": city,
            "country": country,
            "count": count,
            "latitude": city_coords.get((city, country), (None, None))[0],
            "longitude": city_coords.get((city, country), (None, None))[1],
        }
        for (city, country), count in sorted(
            city_counts.items(), key=lambda kv: (-kv[1], kv[0][0])
        )
    ]
    country_list = [
        {"country": country, "count": count}
        for country, count in sorted(
            country_counts.items(), key=lambda kv: (-kv[1], kv[0])
        )
    ]
    return {"cities": city_list, "countries": country_list}


def timeline_milestone_markers(
    events: list[CachedEvent], intl_event_ids: set[str]
) -> list[dict]:
    """Milestone unlocks placed on the date of the attended event that
    triggered them, for interleaving into the timeline.

    Walks events oldest->newest so count/distinct/streak/international
    milestones are attributed to the historically-correct event. Review
    milestones are not event-anchored and are omitted here.
    """
    ordered = sorted(events, key=lambda e: e.start)
    cities: set[tuple] = set()
    countries: set = set()
    seen_intl = False
    emitted: set[str] = set()
    markers: list[dict] = []
    for i, event in enumerate(ordered, start=1):
        if event.city:
            cities.add((event.city, event.country))
        if event.country:
            countries.add(event.country)
        if event.event_id in intl_event_ids:
            seen_intl = True
        ctx = {
            "total_events": i,
            "cities": cities,
            "countries": countries,
            "reviews": 0,
            "has_international": seen_intl,
            "longest_streak": longest_month_streak(ordered[:i]),
        }
        for m in MILESTONES:
            if m.category == "reviews" or m.key in emitted:
                continue
            if m.metric(ctx) >= m.threshold:
                emitted.add(m.key)
                markers.append(
                    {
                        "key": m.key,
                        "name": m.name,
                        "icon": m.icon,
                        "date": event.start,
                    }
                )
    return markers


def international_event_ids(session: Session, event_ids: list[str]) -> set[str]:
    """Attended event ids carrying the ``reach:international`` tag."""
    if not event_ids:
        return set()
    rows = session.exec(
        select(EventTag.event_id)
        .join(Tag, Tag.id == EventTag.tag_id)
        .join(TagGroup, TagGroup.id == Tag.group_id)
        .where(TagGroup.slug == "reach")
        .where(Tag.slug == "international")
        .where(EventTag.event_id.in_(event_ids))
    ).all()
    return set(rows)


# --- Milestones (Phase B) -------------------------------------------------
#
# Server-defined catalog. ``metric`` extracts the current progress value for a
# milestone from the stats context built by ``build_stats_context``; a
# milestone is unlocked once that value reaches ``threshold``. ``category``
# groups milestones for the progress-to-next hint on the frontend.


class Milestone:
    __slots__ = (
        "key",
        "name",
        "description",
        "icon",
        "category",
        "threshold",
        "unit",
        "metric",
    )

    def __init__(self, key, name, description, icon, category, threshold, unit, metric):
        self.key = key
        self.name = name
        self.description = description
        self.icon = icon
        self.category = category
        self.threshold = threshold
        self.unit = unit
        self.metric = metric


def _m_events(ctx: dict) -> int:
    return ctx["total_events"]


def _m_cities(ctx: dict) -> int:
    return len(ctx["cities"])


def _m_countries(ctx: dict) -> int:
    return len(ctx["countries"])


def _m_reviews(ctx: dict) -> int:
    return ctx["reviews"]


def _m_streak(ctx: dict) -> int:
    return ctx["longest_streak"]


def _m_international(ctx: dict) -> int:
    return 1 if ctx["has_international"] else 0


MILESTONES: list[Milestone] = [
    Milestone(
        "first_event",
        "First Steps",
        "Attend your first event",
        "🎉",
        "events",
        1,
        "events",
        _m_events,
    ),
    Milestone(
        "events_10",
        "Regular",
        "Attend 10 events",
        "💃",
        "events",
        10,
        "events",
        _m_events,
    ),
    Milestone(
        "events_25",
        "Dedicated",
        "Attend 25 events",
        "🔥",
        "events",
        25,
        "events",
        _m_events,
    ),
    Milestone(
        "events_50",
        "Veteran",
        "Attend 50 events",
        "🏆",
        "events",
        50,
        "events",
        _m_events,
    ),
    Milestone(
        "events_100",
        "Legend",
        "Attend 100 events",
        "👑",
        "events",
        100,
        "events",
        _m_events,
    ),
    Milestone(
        "cities_5",
        "Explorer",
        "Dance in 5 cities",
        "🗺️",
        "cities",
        5,
        "cities",
        _m_cities,
    ),
    Milestone(
        "cities_10",
        "City Hopper",
        "Dance in 10 cities",
        "🏙️",
        "cities",
        10,
        "cities",
        _m_cities,
    ),
    Milestone(
        "countries_3",
        "Passport Stamped",
        "Dance in 3 countries",
        "🛂",
        "countries",
        3,
        "countries",
        _m_countries,
    ),
    Milestone(
        "countries_5",
        "World Dancer",
        "Dance in 5 countries",
        "✈️",
        "countries",
        5,
        "countries",
        _m_countries,
    ),
    Milestone(
        "countries_10",
        "Globetrotter",
        "Dance in 10 countries",
        "🌍",
        "countries",
        10,
        "countries",
        _m_countries,
    ),
    Milestone(
        "first_international",
        "Border Crosser",
        "Attend an international event",
        "🌐",
        "international",
        1,
        "events",
        _m_international,
    ),
    Milestone(
        "first_review",
        "Reviewer",
        "Write your first review",
        "✍️",
        "reviews",
        1,
        "reviews",
        _m_reviews,
    ),
    Milestone(
        "reviews_10",
        "Critic",
        "Write 10 reviews",
        "⭐",
        "reviews",
        10,
        "reviews",
        _m_reviews,
    ),
    Milestone(
        "streak_3_months",
        "Consistent",
        "Dance 3 months in a row",
        "📅",
        "streak",
        3,
        "months",
        _m_streak,
    ),
    Milestone(
        "streak_6_months",
        "Committed",
        "Dance 6 months in a row",
        "🗓️",
        "streak",
        6,
        "months",
        _m_streak,
    ),
    Milestone(
        "streak_12_months",
        "Year-Rounder",
        "Dance 12 months in a row",
        "🎆",
        "streak",
        12,
        "months",
        _m_streak,
    ),
]

MILESTONES_BY_KEY: dict[str, Milestone] = {m.key: m for m in MILESTONES}


def satisfied_keys(ctx: dict) -> list[str]:
    """Milestone keys whose threshold is met by the given stats context."""
    return [m.key for m in MILESTONES if m.metric(ctx) >= m.threshold]


def evaluate_and_persist(session: Session, user) -> list[str]:
    """Insert ``UserMilestone`` rows for newly-satisfied milestones.

    Shared unlock path — reused by the passport GET (lazy unlock) and, later,
    the milestone notification scheduler. Idempotent: already-unlocked keys are
    skipped. Returns the list of newly-unlocked keys (in catalog order).
    """
    ctx = build_stats_context(session, user)
    existing = set(
        session.exec(
            select(UserMilestone.milestone_key).where(UserMilestone.user_id == user.id)
        ).all()
    )
    newly: list[str] = []
    for key in satisfied_keys(ctx):
        if key in existing:
            continue
        session.add(UserMilestone(user_id=user.id, milestone_key=key))
        newly.append(key)
    if newly:
        session.commit()
    return newly


def milestone_view(session: Session, user, ctx: dict) -> list[dict]:
    """Full catalog with per-milestone unlocked/is_new/progress for the UI."""
    rows = {
        r.milestone_key: r
        for r in session.exec(
            select(UserMilestone).where(UserMilestone.user_id == user.id)
        ).all()
    }
    view: list[dict] = []
    for m in MILESTONES:
        row = rows.get(m.key)
        current = m.metric(ctx)
        view.append(
            {
                "key": m.key,
                "name": m.name,
                "description": m.description,
                "icon": m.icon,
                "category": m.category,
                "threshold": m.threshold,
                "unit": m.unit,
                "progress": min(current, m.threshold),
                "unlocked": row is not None,
                "is_new": row is not None and row.seen_at is None,
                "unlocked_at": row.unlocked_at if row else None,
            }
        )
    return view


def acknowledge_milestones(session: Session, user, keys: list[str]) -> int:
    """Stamp ``seen_at`` on the given unlocked milestones (dismiss the toast).

    Only unseen rows are updated, so repeated acks are idempotent. Returns the
    number of rows newly marked seen.
    """
    if not keys:
        return 0
    rows = session.exec(
        select(UserMilestone)
        .where(UserMilestone.user_id == user.id)
        .where(UserMilestone.milestone_key.in_(keys))
        .where(UserMilestone.seen_at.is_(None))
    ).all()
    now = datetime.utcnow()
    for row in rows:
        row.seen_at = now
    if rows:
        session.commit()
    return len(rows)
