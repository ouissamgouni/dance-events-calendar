"""Near-duplicate detection for upcoming CachedEvent rows.

Two-step algorithm, designed to work identically on SQLite (unit tests)
and Postgres (dev/staging/prod) without needing a Postgres-only trigram
extension:

  1. An indexed SQL query narrows the search to active, upcoming events
     whose ``start`` falls within a small window of the target event's
     ``start`` (across ALL calendars, not just the same one).
  2. The (small) candidate set from step 1 is compared in Python using
     ``difflib.SequenceMatcher`` on normalized titles; only pairs at or
     above ``TITLE_SIMILARITY_THRESHOLD`` are considered duplicates.

Detected pairs are grouped via a simple union-find-by-membership: if a
matched event already belongs to an existing group, the new event joins
that group; otherwise a new group is created. Once two events have ever
been recorded together in a group (pending, resolved, or dismissed), the
scan won't recreate a group for that same pair — this is what makes an
admin's "Keep" / "Not a duplicate" decision sticky across future scans.
"""

from __future__ import annotations

import difflib
import re
from datetime import datetime, timedelta

from sqlmodel import Session, select

from backend.db.models import (
    CachedEvent,
    EventDuplicateGroup,
    EventDuplicateMember,
    EventDuplicateScanLog,
    SiteSetting,
)

# Candidate window: how far apart two events' start times may be to still
# be considered for a title match. Generous enough to catch "same event,
# slightly different time" listings across calendars.
CANDIDATE_WINDOW_HOURS = 36

# Minimum difflib.SequenceMatcher ratio (0-1) on normalized titles for a
# pair to be flagged as a likely duplicate.
TITLE_SIMILARITY_THRESHOLD = 0.72

_WHITESPACE_RE = re.compile(r"\s+")


def _normalize_title(title: str) -> str:
    return _WHITESPACE_RE.sub(" ", (title or "").strip().lower())


def _title_similarity(a: str, b: str) -> float:
    return difflib.SequenceMatcher(
        None, _normalize_title(a), _normalize_title(b)
    ).ratio()


def _is_auto_detect_enabled(session: Session) -> bool:
    """Mirrors the defensive style of ``_get_bool_setting`` in
    ``api/routes/settings.py``: never let a settings lookup issue break the
    calling sync/edit flow."""
    try:
        row = session.get(SiteSetting, "duplicate_auto_detect_enabled")
        if row:
            return row.value.lower() == "true"
    except Exception:
        pass
    return False


def _existing_pair_recorded(session: Session, event_id_a: str, event_id_b: str) -> bool:
    """True if event_id_a and event_id_b already co-occur in any group."""
    group_ids_a = set(
        session.exec(
            select(EventDuplicateMember.group_id).where(
                EventDuplicateMember.event_id == event_id_a
            )
        ).all()
    )
    if not group_ids_a:
        return False
    group_ids_b = set(
        session.exec(
            select(EventDuplicateMember.group_id).where(
                EventDuplicateMember.event_id == event_id_b
            )
        ).all()
    )
    return bool(group_ids_a & group_ids_b)


def find_candidate_matches(
    session: Session, event: CachedEvent, *, now: datetime | None = None
) -> list[CachedEvent]:
    """Active, upcoming events (any calendar) with a similar title and a
    start time within ``CANDIDATE_WINDOW_HOURS`` of ``event.start``."""
    now = now or datetime.utcnow()
    window = timedelta(hours=CANDIDATE_WINDOW_HOURS)

    narrowed = session.exec(
        select(CachedEvent).where(
            CachedEvent.event_id != event.event_id,
            CachedEvent.deleted_at == None,  # noqa: E711
            CachedEvent.is_hidden == False,  # noqa: E712
            CachedEvent.end > now,
            CachedEvent.start >= event.start - window,
            CachedEvent.start <= event.start + window,
        )
    ).all()

    return [
        c
        for c in narrowed
        if _title_similarity(event.title, c.title) >= TITLE_SIMILARITY_THRESHOLD
    ]


def _add_to_group_or_create(
    session: Session, event_id: str, matched_event_id: str, *, source: str
) -> EventDuplicateGroup | None:
    """Ensure event_id and matched_event_id are recorded together in a
    pending group. Returns the (possibly newly created) group, or None if
    this pair was already recorded (skipped)."""
    if _existing_pair_recorded(session, event_id, matched_event_id):
        return None

    # Join an existing pending group containing either event, if any.
    existing_member = session.exec(
        select(EventDuplicateMember).where(
            EventDuplicateMember.event_id.in_([event_id, matched_event_id])
        )
    ).first()

    group: EventDuplicateGroup | None = None
    if existing_member is not None:
        candidate_group = session.get(EventDuplicateGroup, existing_member.group_id)
        if candidate_group is not None and candidate_group.status == "pending":
            group = candidate_group

    if group is None:
        group = EventDuplicateGroup(status="pending", source=source)
        session.add(group)
        session.flush()  # assign group.id

    for eid in (event_id, matched_event_id):
        already = session.exec(
            select(EventDuplicateMember).where(
                EventDuplicateMember.group_id == group.id,
                EventDuplicateMember.event_id == eid,
            )
        ).first()
        if not already:
            session.add(EventDuplicateMember(group_id=group.id, event_id=eid))

    return group


def detect_duplicates_for_event(
    session: Session,
    event_id: str,
    *,
    scan_type: str = "incremental",
    triggered_by_event_id: str | None = None,
    triggered_by_admin: str | None = None,
) -> EventDuplicateScanLog:
    """Run candidate detection for a single event and persist any new
    duplicate group(s). Always logs a scan-log row, even when nothing is
    found."""
    log = EventDuplicateScanLog(
        scan_type=scan_type,
        triggered_by_event_id=triggered_by_event_id or event_id,
        triggered_by_admin=triggered_by_admin,
    )
    session.add(log)
    session.flush()

    groups_created = 0
    candidates_found = 0
    try:
        event = session.get(CachedEvent, event_id)
        if (
            event is not None
            and event.deleted_at is None
            and not event.is_hidden
            and event.end > datetime.utcnow()
        ):
            matches = find_candidate_matches(session, event)
            candidates_found = len(matches)
            for match in matches:
                group = _add_to_group_or_create(
                    session, event.event_id, match.event_id, source="auto"
                )
                if group is not None:
                    groups_created += 1
        log.status = "completed"
    except Exception:
        log.status = "failed"
        raise
    finally:
        log.finished_at = datetime.utcnow()
        log.candidates_found = candidates_found
        log.groups_created = groups_created
        session.add(log)
        session.commit()

    return log


def maybe_detect_duplicates_for_event(session: Session, event_id: str) -> None:
    """No-op unless ``duplicate_auto_detect_enabled`` site setting is on.
    Call this after an event insert/update commit in the sync/admin paths."""
    if not _is_auto_detect_enabled(session):
        return
    detect_duplicates_for_event(session, event_id, scan_type="incremental")


def run_full_scan(
    session: Session, *, triggered_by_admin: str | None = None
) -> EventDuplicateScanLog:
    """On-demand full scan across all active, upcoming events. Available
    regardless of the auto-detect feature flag."""
    log = EventDuplicateScanLog(scan_type="full", triggered_by_admin=triggered_by_admin)
    session.add(log)
    session.flush()

    groups_created = 0
    candidates_found = 0
    try:
        now = datetime.utcnow()
        events = session.exec(
            select(CachedEvent)
            .where(
                CachedEvent.deleted_at == None,  # noqa: E711
                CachedEvent.is_hidden == False,  # noqa: E712
                CachedEvent.end > now,
            )
            .order_by(CachedEvent.start)
        ).all()

        seen_pairs: set[tuple[str, str]] = set()
        for event in events:
            matches = find_candidate_matches(session, event, now=now)
            for match in matches:
                pair = tuple(sorted((event.event_id, match.event_id)))
                if pair in seen_pairs:
                    continue
                seen_pairs.add(pair)
                candidates_found += 1
                group = _add_to_group_or_create(
                    session, event.event_id, match.event_id, source="auto"
                )
                if group is not None:
                    groups_created += 1
        log.status = "completed"
    except Exception:
        log.status = "failed"
        raise
    finally:
        log.finished_at = datetime.utcnow()
        log.candidates_found = candidates_found
        log.groups_created = groups_created
        session.add(log)
        session.commit()

    return log


def create_manual_group(
    session: Session, event_ids: list[str], *, triggered_by_admin: str | None = None
) -> EventDuplicateGroup:
    """Admin-initiated ad-hoc grouping (EventsPanel bulk "Flag as
    duplicates" action, or per-event "Flag as duplicate" picker). Always
    creates a new group — manual flags are intentional, not deduped
    against prior decisions."""
    group = EventDuplicateGroup(status="pending", source="manual")
    session.add(group)
    session.flush()
    for event_id in event_ids:
        session.add(EventDuplicateMember(group_id=group.id, event_id=event_id))

    log = EventDuplicateScanLog(
        scan_type="manual_pair",
        triggered_by_admin=triggered_by_admin,
        status="completed",
        finished_at=datetime.utcnow(),
        candidates_found=len(event_ids),
        groups_created=1,
    )
    session.add(log)
    session.commit()
    session.refresh(group)
    return group


def keep_event(
    session: Session,
    group_id: int,
    keep_event_id: str,
    *,
    admin_email: str | None = None,
) -> EventDuplicateGroup:
    """Resolve a group: keep ``keep_event_id``, block+reject the rest."""
    group = session.get(EventDuplicateGroup, group_id)
    if group is None:
        raise ValueError("Duplicate group not found")

    from backend.db.models import BlockedEvent

    members = session.exec(
        select(EventDuplicateMember).where(EventDuplicateMember.group_id == group_id)
    ).all()
    member_ids = {m.event_id for m in members}
    if keep_event_id not in member_ids:
        raise ValueError("keep_event_id is not a member of this group")

    kept_event = session.get(CachedEvent, keep_event_id)
    kept_title = kept_event.title if kept_event else keep_event_id

    for event_id in member_ids:
        if event_id == keep_event_id:
            continue
        event = session.get(CachedEvent, event_id)
        if event is None:
            continue
        event.is_hidden = True
        event.rejected_duplicate_reason = f"Duplicate of {keep_event_id} — {kept_title}"
        event.updated_at = datetime.utcnow()
        session.add(event)
        if not session.get(BlockedEvent, event_id):
            session.add(BlockedEvent(event_id=event_id))

    group.status = "resolved"
    group.kept_event_id = keep_event_id
    group.resolved_at = datetime.utcnow()
    group.resolved_by_admin = admin_email
    session.add(group)
    session.commit()
    session.refresh(group)
    return group


def dismiss_group(
    session: Session, group_id: int, *, admin_email: str | None = None
) -> EventDuplicateGroup:
    """Mark a group as not-actually-duplicates. The pair(s) stay recorded
    so future scans won't recreate the group."""
    group = session.get(EventDuplicateGroup, group_id)
    if group is None:
        raise ValueError("Duplicate group not found")
    group.status = "dismissed"
    group.resolved_at = datetime.utcnow()
    group.resolved_by_admin = admin_email
    session.add(group)
    session.commit()
    session.refresh(group)
    return group


def get_groups_for_event(session: Session, event_id: str) -> list[EventDuplicateGroup]:
    """Pending duplicate groups (if any) that include this event — used by
    the admin event-detail panel's "Potential duplicates" section."""
    group_ids = session.exec(
        select(EventDuplicateMember.group_id).where(
            EventDuplicateMember.event_id == event_id
        )
    ).all()
    if not group_ids:
        return []
    return session.exec(
        select(EventDuplicateGroup).where(
            EventDuplicateGroup.id.in_(group_ids),
            EventDuplicateGroup.status == "pending",
        )
    ).all()
