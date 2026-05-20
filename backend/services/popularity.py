"""Trending / popularity scoring.

Replaces the legacy ``view_count``-only popularity signal with a
commitment-weighted, time-decayed score:

    score = (W_GOING * going_n  +  W_SAVED * saved_n  +  W_VIEW * view_n)
            / (hours_since_created + DECAY_OFFSET) ** DECAY_EXPONENT

where ``*_n`` is the count over the last ``trending_window_days`` (site
setting). Past events return 0 so they never appear as "trending"
regardless of historical counts.

The function is intentionally pure (no DB writes) and computes everything
in two SQL aggregations + one event-row fetch, so it stays O(N) for the
batch of event ids passed in. Call sites are responsible for caching at
the response layer (``Cache-Control`` headers on the existing list
endpoints).
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Iterable

from sqlalchemy import func
from sqlmodel import Session, select

from backend.db.models import (
    CachedEvent,
    EventView,
    UserEventAttendance,
    UserSavedEvent,
)

# Score weights — tuned so a "5 going, 0 saved, 0 views, 1 day old" event
# scores ~5 (clear "warm" tier), and a "12 going, 8 saved, 80 views, 2
# days old" event scores ~12 (clear "hot" tier). See plan write-up for
# worked examples.
W_GOING = 5.0
W_SAVED = 1.0
W_VIEW = 0.05

# Decay: HN-style. Offset of 24h prevents brand-new events from being
# divided by ~0; exponent 0.4 is a gentle decay (a 1-day-old event isn't
# dramatically penalised vs a 5-day-old one, but a 6-month-old event is).
DECAY_OFFSET_HOURS = 24.0
DECAY_EXPONENT = 0.4


def get_saved_counts(
    session: Session,
    event_ids: list[str],
    *,
    since: datetime | None = None,
) -> dict[str, int]:
    """Distinct-saver count per event (UserSavedEvent rows).

    When ``since`` is given, only rows with ``saved_at >= since`` are
    counted — used by the trending window. Rows with no ``since`` give
    the lifetime count surfaced as ``saved_count`` on every payload.
    """
    if not event_ids:
        return {}
    q = (
        select(UserSavedEvent.event_id, func.count(UserSavedEvent.id))
        .where(UserSavedEvent.event_id.in_(event_ids))
        .group_by(UserSavedEvent.event_id)
    )
    if since is not None:
        q = q.where(UserSavedEvent.saved_at >= since)
    return {row[0]: row[1] for row in session.exec(q).all()}


def compute_popularity_scores(
    session: Session,
    events: Iterable[CachedEvent],
    *,
    window_days: int = 30,
    floor_going: int = 3,
    now: datetime | None = None,
) -> dict[str, float]:
    """Return ``{event_id: score}`` using the trending formula.

    Events that fail the absolute Going-floor receive 0 (no false hot
    tier from view-bait). Past events also receive 0.

    The caller must have already loaded the events; we re-use them so we
    don't double-fetch. Aggregations on EventView / UserEventAttendance /
    UserSavedEvent are batched in 3 queries total regardless of N.
    """
    events_list = list(events)
    if not events_list:
        return {}

    now = now or datetime.utcnow()
    since = now - timedelta(days=window_days)

    event_ids = [e.event_id for e in events_list]

    going_rows = session.exec(
        select(UserEventAttendance.event_id, func.count(UserEventAttendance.id))
        .where(
            UserEventAttendance.event_id.in_(event_ids),
            # ``UserEventAttendance`` records the timestamp under
            # ``attending_since`` (the moment the row was materialized
            # as "currently going"); there is no ``created_at`` field.
            UserEventAttendance.attending_since >= since,
        )
        .group_by(UserEventAttendance.event_id)
    ).all()
    going_n = {row[0]: row[1] for row in going_rows}

    saved_n = get_saved_counts(session, event_ids, since=since)

    view_rows = session.exec(
        select(EventView.event_id, func.count(EventView.id))
        .where(
            EventView.event_id.in_(event_ids),
            EventView.created_at >= since,
        )
        .group_by(EventView.event_id)
    ).all()
    view_n = {row[0]: row[1] for row in view_rows}

    scores: dict[str, float] = {}
    for e in events_list:
        # Past events never trend.
        if e.end is not None and e.end < now:
            scores[e.event_id] = 0.0
            continue

        g = going_n.get(e.event_id, 0)
        if g < floor_going:
            scores[e.event_id] = 0.0
            continue

        s = saved_n.get(e.event_id, 0)
        v = view_n.get(e.event_id, 0)

        # ``CachedEvent`` does not have a dedicated ``created_at`` column;
        # ``updated_at`` is set on insert + every sync touch and is the
        # closest proxy to "row freshness" available. UTC is the source
        # of truth (DB stores naive datetimes; we treat them as UTC
        # throughout the codebase).
        ref = getattr(e, "updated_at", None) or e.start
        hours_age = max(0.0, (now - ref).total_seconds() / 3600.0)

        numerator = W_GOING * g + W_SAVED * s + W_VIEW * v
        denominator = (hours_age + DECAY_OFFSET_HOURS) ** DECAY_EXPONENT
        scores[e.event_id] = round(numerator / denominator, 3)

    return scores
