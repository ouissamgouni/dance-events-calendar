"""Heuristic tag-suggestion enrichment stage.

Generates pending ``TagSuggestion`` rows (``source='heuristic'``) for
synced events based on keyword/synonym matching against the current tag
taxonomy. Suggestions are **never auto-applied** — admins approve/reject
through the existing tag-suggestion review UI.

Persistence model
-----------------
Unlike the other stages (link/price/geocoding) which mutate the
``CachedEvent`` row in-place, this stage writes to a *different* table
(``tag_suggestions``). It uses the new ``process_with_session`` hook on
``EnrichmentStage`` to access the active session.

The fallback ``process(event)`` (no session) is intentionally a no-op —
the parallel ``EventPipelineProcessor`` path used by admin Sync Jobs
does not generate auto suggestions inline. Admins can run them on demand
afterwards via the bulk "Suggest tags" admin action.

Idempotency / rejection memory
------------------------------
* ``should_process`` returns False if any auto suggestion already exists for
  the event (any status). The on-demand admin endpoint can pass a
  ``replace_existing_pending=True`` flag to delete pending rows first
  (handled in the route, not the stage).
* Tags already applied to the event (``EventTag``) are excluded.
* Tags rejected by an admin within ``REJECTION_SUPPRESSION_DAYS`` are
  excluded — prevents the stage from re-suggesting tags admins explicitly
  said no to. After the window the stage is allowed to try again, on the
  assumption that the event content (or admin opinion) may have changed.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta

from sqlmodel import Session, select

from backend.db.models import CachedEvent, EventTag, TagSuggestion
from backend.services.pipeline.base import EnrichmentStage
from backend.services.tag_suggester import (
    TagCandidate,
    TaxonomySnapshot,
    load_taxonomy,
    suggest_tags,
)

logger = logging.getLogger(__name__)

REJECTION_SUPPRESSION_DAYS: int = 30


class TagSuggestionStage(EnrichmentStage):
    @property
    def name(self) -> str:
        return "tag_suggestion"

    def should_process(self, event: CachedEvent) -> bool:
        # Need *some* text to match against.
        if not (event.title or event.description or event.location):
            return False
        # The actual "no auto-source rows yet for this event" check is done inside
        # ``process_with_session`` because it requires DB access.
        return True

    def process(self, event: CachedEvent) -> bool:
        # No-op fallback for the parallel processor path (no session).
        # Admins can run the bulk "Suggest tags" action after the sync.
        return True

    def process_with_session(
        self, session: Session, event: CachedEvent
    ) -> bool:
        # Skip if any auto suggestion already exists for this event (idempotent).
        already = session.exec(
            select(TagSuggestion.id)
            .where(TagSuggestion.event_id == event.event_id)
            .where(TagSuggestion.source == "heuristic")
            .limit(1)
        ).first()
        if already is not None:
            return True

        snapshot = load_taxonomy(session)
        excluded = excluded_tag_ids_for_event(session, event.event_id)
        candidates = suggest_tags(
            snapshot,
            title=event.title,
            description=event.description,
            location=event.location,
            excluded_tag_ids=excluded,
        )
        persist_suggestions(session, event.event_id, candidates)
        return True


def excluded_tag_ids_for_event(session: Session, event_id: str) -> set[int]:
    """Tags that should NOT be suggested for the event.

    Includes:
    * Tags already applied (``EventTag``).
    * Tags whose auto suggestion was rejected within the suppression window.
    """
    excluded: set[int] = set()

    applied = session.exec(
        select(EventTag.tag_id).where(EventTag.event_id == event_id)
    ).all()
    excluded.update(t for t in applied if t is not None)

    cutoff = datetime.utcnow() - timedelta(days=REJECTION_SUPPRESSION_DAYS)
    rejected = session.exec(
        select(TagSuggestion.tag_id)
        .where(TagSuggestion.event_id == event_id)
        .where(TagSuggestion.source == "heuristic")
        .where(TagSuggestion.status == "rejected")
        .where(TagSuggestion.reviewed_at != None)  # noqa: E711
        .where(TagSuggestion.reviewed_at >= cutoff)
    ).all()
    excluded.update(t for t in rejected if t is not None)

    return excluded


def persist_suggestions(
    session: Session,
    event_id: str,
    candidates: list[TagCandidate],
) -> list[TagSuggestion]:
    """Insert ``TagSuggestion`` rows for the given candidates.

    Idempotency: if a pending auto suggestion already exists for
    ``(event_id, tag_id)`` it is skipped (the partial unique index in the
    Alembic migration also defends at the DB level).
    """
    if not candidates:
        return []

    # Pre-load existing pending auto-source rows for this event in a single query.
    existing = session.exec(
        select(TagSuggestion.tag_id)
        .where(TagSuggestion.event_id == event_id)
        .where(TagSuggestion.source == "heuristic")
        .where(TagSuggestion.status == "pending")
    ).all()
    existing_ids = {tid for tid in existing if tid is not None}

    inserted: list[TagSuggestion] = []
    for cand in candidates:
        if cand.tag_id in existing_ids:
            continue
        row = TagSuggestion(
            event_id=event_id,
            tag_id=cand.tag_id,
            status="pending",
            source="heuristic",
            confidence=cand.confidence,
            matched_terms=list(cand.matched_terms),
        )
        session.add(row)
        inserted.append(row)
    if inserted:
        session.flush()
    return inserted


def delete_pending_ai_suggestions(session: Session, event_id: str) -> int:
    """Remove all pending auto suggestions for an event (used by 'Re-run')."""
    rows = session.exec(
        select(TagSuggestion)
        .where(TagSuggestion.event_id == event_id)
        .where(TagSuggestion.source == "heuristic")
        .where(TagSuggestion.status == "pending")
    ).all()
    count = 0
    for row in rows:
        session.delete(row)
        count += 1
    if count:
        session.flush()
    return count
