"""Rolling materialisation of open-ended recurring suggestions.

An RRULE with neither UNTIL nor COUNT repeats forever, but occurrences are
stored as concrete CachedEvent rows, so they can only ever be materialised over
a finite window. This job walks that window forward on every scheduler tick so
"Ends: Never" behaves as advertised instead of silently stopping a year out.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta

from sqlmodel import Session, col, select

from backend.db.database import get_engine
from backend.db.models import CachedEvent, EventSuggestion
from backend.services.recurrence import (
    MAX_HORIZON_DAYS,
    MAX_SERIES_OCCURRENCES,
    is_open_ended,
)

logger = logging.getLogger(__name__)


def run_once() -> dict:
    """Extend every approved open-ended series up to the rolling horizon."""
    from backend.api.routes.suggestions import (
        _apply_creator_going,
        _apply_suggestion_tags,
        _link_occurrences_to_series,
        _upsert_occurrences_from_suggestion,
    )

    horizon_end = datetime.utcnow() + timedelta(days=MAX_HORIZON_DAYS)
    extended = 0
    created = 0

    with Session(get_engine()) as session:
        suggestions = session.exec(
            select(EventSuggestion)
            .where(EventSuggestion.status == "approved")
            .where(col(EventSuggestion.recurrence_rule).is_not(None))
        ).all()

        for suggestion in suggestions:
            if not is_open_ended(suggestion.recurrence_rule):
                continue
            before = len(
                session.exec(
                    select(CachedEvent).where(
                        CachedEvent.suggestion_id == suggestion.id
                    )
                ).all()
            )
            if before >= MAX_SERIES_OCCURRENCES:
                continue

            calendar_id = suggestion.assigned_calendar_id
            if not calendar_id and suggestion.created_event_id:
                anchor = session.get(CachedEvent, suggestion.created_event_id)
                calendar_id = anchor.calendar_id if anchor else None
            if not calendar_id:
                continue

            try:
                events = _upsert_occurrences_from_suggestion(
                    session,
                    suggestion,
                    review_status="reviewed",
                    calendar_id=calendar_id,
                    latitude=suggestion.latitude,
                    longitude=suggestion.longitude,
                    limit=MAX_SERIES_OCCURRENCES,
                    horizon_end=horizon_end,
                )
            except Exception:
                logger.exception(
                    "Failed to extend recurring suggestion %s", suggestion.id
                )
                session.rollback()
                continue

            if len(events) <= before:
                continue

            if suggestion.suggested_tag_ids:
                for event in events[before:]:
                    _apply_suggestion_tags(
                        session, event.event_id, suggestion.suggested_tag_ids
                    )
            _apply_creator_going(session, suggestion, events[before:], fan_out=False)
            _link_occurrences_to_series(
                session, suggestion, events, suggestion.reviewed_by
            )
            session.commit()
            extended += 1
            created += len(events) - before

    return {"series_extended": extended, "occurrences_created": created}
