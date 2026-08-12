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
    UserConsistencyAchievement,
    UserEventAttendance,
    UserMilestone,
)


# --- Consistency achievements (recurring) ---------------------------------
#
# Reward sustained participation over a rolling 12 calendar months (the current
# month plus the 11 before it). An "active month" is any calendar month with at
# least one attended event; months need not be consecutive. Unlike the one-time
# milestone catalog, consistency levels RECUR: each distinct "period" (a run
# where the rolling active-month count stays >= the entry threshold) can earn
# every level again. Everything here is recomputed deterministically from the
# user's attended-event months, so there is no drift and no background job.
CONSISTENCY_WINDOW = 12
CONSISTENCY_ENTRY = 3  # active months in the window needed to open a period
# (key, name, icon, threshold, description) ordered by ascending active-month
# threshold.
CONSISTENCY_LEVELS: list[tuple[str, str, str, int, str]] = [
    ("consistency_3", "Consistent", "📅", 3, "Active 3 of the last 12 months"),
    ("consistency_5", "Committed", "🗓️", 5, "Active 5 of the last 12 months"),
    ("consistency_8", "Year-Rounder", "🎆", 8, "Active 8 of the last 12 months"),
    ("consistency_10", "Unstoppable", "🔥", 10, "Active 10 of the last 12 months"),
    (
        "consistency_12",
        "Dance Lifestyle",
        "💎",
        12,
        "Active all 12 of the last 12 months",
    ),
]


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


def top_dance_style(session: Session, event_ids: list[str]) -> str | None:
    """Human label of the dance style tagged on the most attended events.

    ``None`` when no attended event carries a dance-style tag. Ties break on the
    tag's ordinal then label for a stable result.
    """
    if not event_ids:
        return None
    rows = session.exec(
        select(Tag.label, func.count().label("n"))
        .join(EventTag, EventTag.tag_id == Tag.id)
        .join(TagGroup, TagGroup.id == Tag.group_id)
        .where(TagGroup.slug == "dance-style")
        .where(EventTag.event_id.in_(event_ids))
        .group_by(Tag.id, Tag.label, Tag.ordinal)
        .order_by(func.count().desc(), Tag.ordinal, Tag.label)
    ).first()
    if rows is None:
        return None
    label = rows[0] if isinstance(rows, (tuple, list)) else rows.label
    return label


def _month_index(dt: datetime) -> int:
    """Absolute calendar-month index (year*12 + month-1) for rolling-window math."""
    return dt.year * 12 + (dt.month - 1)


def _month_label(index: int) -> str:
    """``"YYYY-MM"`` label for a month index (client formats the human range)."""
    year, month = divmod(index, 12)
    return f"{year:04d}-{month + 1:02d}"


def active_month_indices(events: list[CachedEvent]) -> set[int]:
    """Distinct calendar months (as indices) with at least one attended event."""
    return {_month_index(e.start) for e in events}


def monthly_activity(events: list[CachedEvent]) -> list[dict]:
    """Per-month attended-event counts as ``[{"month": "YYYY-MM", "count": n}]``.

    Only months with at least one event are emitted (oldest first); the client
    fills the gaps between the first and last active year for the heatmap grid.
    """
    counts: dict[int, int] = {}
    for e in events:
        idx = _month_index(e.start)
        counts[idx] = counts.get(idx, 0) + 1
    return [
        {"month": _month_label(idx), "count": counts[idx]} for idx in sorted(counts)
    ]


def rolling_active_count(
    months: set[int], at_index: int, window: int = CONSISTENCY_WINDOW
) -> int:
    """Active months within the ``window`` calendar months ending at ``at_index``."""
    low = at_index - (window - 1)
    return sum(1 for mi in months if low <= mi <= at_index)


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
    now = datetime.utcnow()
    months = active_month_indices(events)
    return {
        "events": events,
        "event_ids": event_ids,
        "total_events": len(events),
        "cities": cities,
        "countries": countries,
        "styles": styles,
        "top_style": top_dance_style(session, event_ids),
        "reviews": reviews_written(session, user.id),
        "active_months_last_12": rolling_active_count(months, _month_index(now)),
        "active_months_this_year": sum(1 for mi in months if mi // 12 == now.year),
        "events_last_30d": events_last_30_days(events),
        "avg_gap_days": average_gap_days(events),
        "first_event_date": events[-1].start if events else None,
        "member_since": user.created_at,
        "dancing_since": user.dancing_since,
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


def timeline_milestone_markers(events: list[CachedEvent]) -> list[dict]:
    """Milestone unlocks placed on the date of the attended event that
    triggered them, for interleaving into the timeline.

    Walks events oldest->newest so count/distinct milestones are attributed to
    the historically-correct event. Review milestones are not event-anchored and
    are omitted here; recurring consistency reaches are emitted separately by
    ``consistency_timeline_markers``.
    """
    ordered = sorted(events, key=lambda e: e.start)
    cities: set[tuple] = set()
    countries: set = set()
    emitted: set[str] = set()
    markers: list[dict] = []
    for i, event in enumerate(ordered, start=1):
        if event.city:
            cities.add((event.city, event.country))
        if event.country:
            countries.add(event.country)
        ctx = {
            "total_events": i,
            "cities": cities,
            "countries": countries,
            "reviews": 0,
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
        "achieved_description",
        "icon",
        "category",
        "threshold",
        "unit",
        "metric",
        "prestige",
    )

    def __init__(
        self,
        key,
        name,
        description,
        achieved_description,
        icon,
        category,
        threshold,
        unit,
        metric,
        prestige,
    ):
        self.key = key
        self.name = name
        self.description = description
        # Past-tense copy shown once unlocked (goal `description` is imperative).
        self.achieved_description = achieved_description
        self.icon = icon
        self.category = category
        self.threshold = threshold
        self.unit = unit
        self.metric = metric
        self.prestige = prestige


def _m_events(ctx: dict) -> int:
    return ctx["total_events"]


def _m_cities(ctx: dict) -> int:
    return len(ctx["cities"])


def _m_countries(ctx: dict) -> int:
    return len(ctx["countries"])


def _m_reviews(ctx: dict) -> int:
    return ctx["reviews"]


MILESTONES: list[Milestone] = [
    Milestone(
        "first_event",
        "First Steps",
        "Attend your first event",
        "Attended your first event",
        "💃",
        "events",
        1,
        "events",
        _m_events,
        1,
    ),
    Milestone(
        "events_5",
        "Regular",
        "Attend 5 events",
        "Attended 5 events",
        "🔥",
        "events",
        5,
        "events",
        _m_events,
        15,
    ),
    Milestone(
        "events_15",
        "Dedicated",
        "Attend 15 events",
        "Attended 15 events",
        "🏆",
        "events",
        15,
        "events",
        _m_events,
        30,
    ),
    Milestone(
        "events_30",
        "Veteran",
        "Attend 30 events",
        "Attended 30 events",
        "👑",
        "events",
        30,
        "events",
        _m_events,
        48,
    ),
    Milestone(
        "events_50",
        "Legend",
        "Attend 50 events",
        "Attended 50 events",
        "✨",
        "events",
        50,
        "events",
        _m_events,
        65,
    ),
    Milestone(
        "events_75",
        "Elite",
        "Attend 75 events",
        "Attended 75 events",
        "🌟",
        "events",
        75,
        "events",
        _m_events,
        80,
    ),
    Milestone(
        "events_100",
        "Icon",
        "Attend 100 events",
        "Attended 100 events",
        "💎",
        "events",
        100,
        "events",
        _m_events,
        90,
    ),
    Milestone(
        "cities_3",
        "City Starter",
        "Dance in 3 cities",
        "Danced in 3 cities",
        "🏙️",
        "cities",
        3,
        "cities",
        _m_cities,
        20,
    ),
    Milestone(
        "cities_5",
        "City Hopper",
        "Dance in 5 cities",
        "Danced in 5 cities",
        "🧳",
        "cities",
        5,
        "cities",
        _m_cities,
        35,
    ),
    Milestone(
        "cities_10",
        "City Explorer",
        "Dance in 10 cities",
        "Danced in 10 cities",
        "🗺️",
        "cities",
        10,
        "cities",
        _m_cities,
        55,
    ),
    Milestone(
        "cities_20",
        "City Collector",
        "Dance in 20 cities",
        "Danced in 20 cities",
        "🚆",
        "cities",
        20,
        "cities",
        _m_cities,
        70,
    ),
    Milestone(
        "cities_30",
        "Urban Nomad",
        "Dance in 30 cities",
        "Danced in 30 cities",
        "🌆",
        "cities",
        30,
        "cities",
        _m_cities,
        82,
    ),
    Milestone(
        "cities_50",
        "City Legend",
        "Dance in 50 cities",
        "Danced in 50 cities",
        "✨",
        "cities",
        50,
        "cities",
        _m_cities,
        95,
    ),
    Milestone(
        "countries_3",
        "Passport Stamped",
        "Dance in 3 countries",
        "Danced in 3 countries",
        "🛂",
        "countries",
        3,
        "countries",
        _m_countries,
        25,
    ),
    Milestone(
        "countries_5",
        "World Dancer",
        "Dance in 5 countries",
        "Danced in 5 countries",
        "✈️",
        "countries",
        5,
        "countries",
        _m_countries,
        45,
    ),
    Milestone(
        "countries_10",
        "Globetrotter",
        "Dance in 10 countries",
        "Danced in 10 countries",
        "🌍",
        "countries",
        10,
        "countries",
        _m_countries,
        65,
    ),
    Milestone(
        "countries_15",
        "World Explorer",
        "Dance in 15 countries",
        "Danced in 15 countries",
        "🧭",
        "countries",
        15,
        "countries",
        _m_countries,
        78,
    ),
    Milestone(
        "countries_25",
        "Global Dancer",
        "Dance in 25 countries",
        "Danced in 25 countries",
        "🌐",
        "countries",
        25,
        "countries",
        _m_countries,
        88,
    ),
    Milestone(
        "countries_40",
        "World Citizen",
        "Dance in 40 countries",
        "Danced in 40 countries",
        "🏆",
        "countries",
        40,
        "countries",
        _m_countries,
        97,
    ),
    Milestone(
        "first_review",
        "Reviewer",
        "Write your first review",
        "Wrote your first review",
        "✍️",
        "reviews",
        1,
        "reviews",
        _m_reviews,
        10,
    ),
    Milestone(
        "reviews_3",
        "Contributor",
        "Write 3 reviews",
        "Wrote 3 reviews",
        "⭐",
        "reviews",
        3,
        "reviews",
        _m_reviews,
        22,
    ),
    Milestone(
        "reviews_10",
        "Critic",
        "Write 10 reviews",
        "Wrote 10 reviews",
        "💬",
        "reviews",
        10,
        "reviews",
        _m_reviews,
        40,
    ),
    Milestone(
        "reviews_25",
        "Trusted Voice",
        "Write 25 reviews",
        "Wrote 25 reviews",
        "📝",
        "reviews",
        25,
        "reviews",
        _m_reviews,
        60,
    ),
    Milestone(
        "reviews_50",
        "Community Guide",
        "Write 50 reviews",
        "Wrote 50 reviews",
        "🏆",
        "reviews",
        50,
        "reviews",
        _m_reviews,
        80,
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
                "achieved_description": m.achieved_description,
                "icon": m.icon,
                "category": m.category,
                "threshold": m.threshold,
                "unit": m.unit,
                "prestige": m.prestige,
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


# --- Consistency achievements (recurring) engine --------------------------


def _record_reaches(period: dict, count: int, month_index: int) -> None:
    """Append any newly-crossed level reaches (upward only, once per period)."""
    reached = {r["key"] for r in period["reaches"]}
    for key, name, icon, threshold, _description in CONSISTENCY_LEVELS:
        if threshold <= count and key not in reached:
            period["reaches"].append(
                {
                    "key": key,
                    "name": name,
                    "icon": icon,
                    "threshold": threshold,
                    "month": month_index,
                }
            )


def _consistency_periods(months: set[int], now_index: int) -> list[dict]:
    """Replay the rolling active-month count month-by-month and split it into
    consistency periods.

    A period opens the month the rolling count first reaches
    ``CONSISTENCY_ENTRY`` and closes once the count drops below it (its ``end``
    is the last month still >= the entry threshold). The period still open at
    ``now_index`` is returned with ``open=True``. Each period records, per
    level, the month its threshold was first crossed upward (the "reach").
    Because the rolling count changes by at most 1 per month, every threshold
    is crossed exactly at its value and the reach month is itself active.
    """
    if not months:
        return []
    periods: list[dict] = []
    current: dict | None = None
    for m in range(min(months), now_index + 1):
        count = rolling_active_count(months, m)
        if current is None:
            if count >= CONSISTENCY_ENTRY:
                current = {"start": m, "end": m, "open": True, "reaches": []}
                _record_reaches(current, count, m)
        elif count >= CONSISTENCY_ENTRY:
            current["end"] = m
            _record_reaches(current, count, m)
        else:
            current["open"] = False
            periods.append(current)
            current = None
    if current is not None:
        current["end"] = now_index
        periods.append(current)
    return periods


def _level_for_count(count: int) -> tuple | None:
    """Highest level whose threshold is met by ``count`` (None below entry)."""
    best = None
    for level in CONSISTENCY_LEVELS:
        if level[3] <= count:
            best = level
    return best


def _earliest_active_in_window(
    months: set[int], at_index: int, window: int = CONSISTENCY_WINDOW
) -> int:
    """Earliest active month still inside the rolling window ending at ``at_index``.

    This is the first month that contributes to the reach count, so it anchors
    the *displayed* period range of an earned card ("first contributing active
    month → reach month"). It may sit in an earlier calendar year than the reach.
    """
    low = at_index - (window - 1)
    return min(mi for mi in months if low <= mi <= at_index)


def consistency_context(events: list[CachedEvent], now: datetime | None = None) -> dict:
    """Full recurring-consistency state derived purely from attended months.

    Models consistency as a chronological trail: every upward reach of a level
    within a period is a permanent "earned" card (repeats are never collapsed),
    ordered by the month it was reached. The current open period also surfaces
    "locked" progress cards for the levels not yet reached. ``top`` condenses the
    lifetime story (strongest level + recurrence) for the all-time card, and
    ``by_year`` classifies each calendar year independently for the yearly card.
    """
    now = now or datetime.utcnow()
    months = active_month_indices(events)
    now_index = _month_index(now)
    active_now = rolling_active_count(months, now_index)
    periods = _consistency_periods(months, now_index)
    open_period = periods[-1] if periods and periods[-1]["open"] else None

    # Earned cards: one per (level, period) reach. Each card's displayed period
    # runs from the earliest active month still in the window at the reach month
    # → the reach month (may cross calendar years). Chronological, no ×N merge.
    earned: list[dict] = []
    for period in periods:
        is_current = period is open_period
        for reach in period["reaches"]:
            start_index = _earliest_active_in_window(months, reach["month"])
            earned.append(
                {
                    "key": f"{reach['key']}:{_month_label(period['start'])}",
                    "level_key": reach["key"],
                    "name": reach["name"],
                    "icon": reach["icon"],
                    "threshold": reach["threshold"],
                    "period_start": _month_label(start_index),
                    "reached": _month_label(reach["month"]),
                    "is_current": is_current,
                }
            )
    earned.sort(key=lambda c: c["reached"])

    # Locked/progress cards: levels not yet reached in the current open period
    # (or every level when no period is open), numerator = current rolling count.
    reached_keys = {r["key"] for r in open_period["reaches"]} if open_period else set()
    locked = [
        {
            "key": key,
            "name": name,
            "icon": icon,
            "threshold": threshold,
            "active_months": active_now,
        }
        for key, name, icon, threshold, _description in CONSISTENCY_LEVELS
        if key not in reached_keys
    ]

    # Strongest lifetime highlight = highest level ever reached (prioritised over
    # repetition of a lower level) + how many times that level recurred.
    counts: dict[str, dict] = {}
    for period in periods:
        for reach in period["reaches"]:
            entry = counts.setdefault(
                reach["key"],
                {
                    "name": reach["name"],
                    "icon": reach["icon"],
                    "threshold": reach["threshold"],
                    "times": 0,
                },
            )
            entry["times"] += 1
    top = None
    if counts:
        strongest_key = max(counts, key=lambda k: counts[k]["threshold"])
        s = counts[strongest_key]
        top = {
            "key": strongest_key,
            "name": s["name"],
            "icon": s["icon"],
            "threshold": s["threshold"],
            "times": s["times"],
        }

    # Per calendar year: distinct active months + the level that count classifies
    # to (independent of rolling periods — used by the yearly passport card).
    by_year: list[dict] = []
    for year in sorted({mi // 12 for mi in months}):
        count = sum(1 for mi in months if mi // 12 == year)
        lvl = _level_for_count(count)
        by_year.append(
            {
                "year": year,
                "active_months": count,
                "key": lvl[0] if lvl else None,
                "name": lvl[1] if lvl else None,
                "icon": lvl[2] if lvl else None,
                "threshold": lvl[3] if lvl else None,
            }
        )

    return {
        "active": open_period is not None,
        "active_months": active_now,
        "window": CONSISTENCY_WINDOW,
        "earned": earned,
        "locked": locked,
        "top": top,
        "by_year": by_year,
        "new": [],
    }


def _latest_event_by_month(events: list[CachedEvent]) -> dict[int, datetime]:
    latest: dict[int, datetime] = {}
    for e in events:
        mi = _month_index(e.start)
        if mi not in latest or e.start > latest[mi]:
            latest[mi] = e.start
    return latest


def consistency_timeline_markers(
    events: list[CachedEvent], now: datetime | None = None
) -> list[dict]:
    """Upward consistency reaches for the timeline — one per (level, period),
    anchored to the latest attended event in the reach month. Recurs: the same
    level appears again for a later period (keys carry the period start)."""
    now = now or datetime.utcnow()
    months = active_month_indices(events)
    now_index = _month_index(now)
    latest_by_month = _latest_event_by_month(events)
    markers: list[dict] = []
    for period in _consistency_periods(months, now_index):
        period_start = _month_label(period["start"])
        for reach in period["reaches"]:
            anchor = latest_by_month.get(reach["month"])
            if anchor is None:
                continue
            markers.append(
                {
                    "key": f"{reach['key']}:{period_start}",
                    "name": reach["name"],
                    "icon": reach["icon"],
                    "date": anchor,
                    "label": f"{reach['threshold']}/{CONSISTENCY_WINDOW} active months",
                    "period_start": _month_label(
                        _earliest_active_in_window(months, reach["month"])
                    ),
                    "period_end": _month_label(reach["month"]),
                }
            )
    return markers


def evaluate_and_persist_consistency(
    session: Session, user, now: datetime | None = None
) -> list[dict]:
    """Reconcile ``UserConsistencyAchievement`` rows with the recomputed periods.

    Inserts a row per newly-reached (level, period) and — the data-correction
    policy — deletes rows whose (level, period) no longer exists once attendance
    is cancelled/deleted (a month drops out of the active set). A normal rolling
    decline never changes the recorded months, so historical achievements are
    only ever removed by a genuine correction, never by quietening down.
    Idempotent. Returns the newly-recorded reaches (for the toast path)."""
    now = now or datetime.utcnow()
    events = attended_events(session, user.id)
    months = active_month_indices(events)
    now_index = _month_index(now)
    rows = session.exec(
        select(UserConsistencyAchievement).where(
            UserConsistencyAchievement.user_id == user.id
        )
    ).all()
    existing = {(r.level_key, r.period_start): r for r in rows}
    latest_by_month = _latest_event_by_month(events)
    valid: set[tuple[str, str]] = set()
    newly: list[dict] = []
    changed = False
    for period in _consistency_periods(months, now_index):
        period_start = _month_label(period["start"])
        for reach in period["reaches"]:
            ident = (reach["key"], period_start)
            valid.add(ident)
            if ident in existing:
                continue
            session.add(
                UserConsistencyAchievement(
                    user_id=user.id,
                    level_key=reach["key"],
                    period_start=period_start,
                    reached_at=latest_by_month.get(reach["month"], now),
                )
            )
            changed = True
            newly.append(
                {
                    "key": reach["key"],
                    "name": reach["name"],
                    "icon": reach["icon"],
                    "period_start": period_start,
                }
            )
    # Prune achievements invalidated by a data correction (cancelled/deleted
    # attendance) — never by an ordinary decline (see docstring).
    for ident, row in existing.items():
        if ident not in valid:
            session.delete(row)
            changed = True
    if changed:
        session.commit()
    return newly


def consistency_view(
    session: Session, user, events: list[CachedEvent] | None = None, now=None
) -> dict:
    """Consistency context plus the unseen reaches (``new``) for the toast."""
    now = now or datetime.utcnow()
    if events is None:
        events = attended_events(session, user.id)
    ctx = consistency_context(events, now)
    lut = {lvl[0]: lvl for lvl in CONSISTENCY_LEVELS}
    unseen = session.exec(
        select(UserConsistencyAchievement)
        .where(UserConsistencyAchievement.user_id == user.id)
        .where(UserConsistencyAchievement.seen_at.is_(None))
    ).all()
    ctx["new"] = [
        {
            "key": r.level_key,
            "name": lut[r.level_key][1],
            "icon": lut[r.level_key][2],
            "period_start": r.period_start,
        }
        for r in unseen
        if r.level_key in lut
    ]
    return ctx


def acknowledge_consistency(session: Session, user, idents: list[str]) -> int:
    """Mark consistency reaches seen. Each ident is ``"level_key:YYYY-MM"``."""
    wanted = set()
    for ident in idents:
        key, sep, period = ident.partition(":")
        if sep:
            wanted.add((key, period))
    if not wanted:
        return 0
    rows = session.exec(
        select(UserConsistencyAchievement)
        .where(UserConsistencyAchievement.user_id == user.id)
        .where(UserConsistencyAchievement.seen_at.is_(None))
    ).all()
    now = datetime.utcnow()
    marked = 0
    for row in rows:
        if (row.level_key, row.period_start) in wanted:
            row.seen_at = now
            marked += 1
    if marked:
        session.commit()
    return marked
