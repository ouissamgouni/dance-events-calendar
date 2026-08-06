"""Recurring-event ("series") detection for CachedEvent rows.

An event *series* is a cluster of CachedEvent rows suspected of being
different occurrences of the same recurring event — e.g. a weekly milonga
that gets synced from Google Calendar as a separate row per week (this repo
has no ``recurringEventId``/iCalUID captured during sync, so series
identity is inferred, not structural).

Two-step algorithm, mirroring ``backend.services.duplicate_detection``
(same SQLite/Postgres portability constraint — no trigram extension):

  1. An indexed SQL query narrows the search to active events in the SAME
     calendar within a generous date window of the target event's start.
  2. The (small) candidate set from step 1 is compared in Python:
     ``difflib.SequenceMatcher`` on normalized titles (and, when both
     events have one, normalized locations) must clear their respective
     thresholds. Candidates whose start times are within
     ``MIN_OCCURRENCE_SEPARATION_HOURS`` of the target are skipped — those
     are near-duplicate territory (same occurrence, not a different one),
     handled instead by ``duplicate_detection``.

Detected pairs are grouped via the same union-find-by-membership scheme as
duplicate detection: if a matched event already belongs to an existing
pending series, the new event joins that series; otherwise a new series is
created. Once two events have ever been recorded together in a series
(pending, resolved, or dismissed), the scan won't recreate a group for that
same pair — an admin's "Approve" / "Not a series" decision is sticky.

Unlike duplicate resolution, approving/dismissing a series never hides or
blocks any member event — every occurrence stays independently visible.
"""

from __future__ import annotations

import difflib
import re
from datetime import datetime, timedelta

from sqlmodel import Session, select

from backend.db.models import (
    CachedEvent,
    EventSeries,
    EventSeriesMember,
    EventSeriesScanLog,
    SiteSetting,
)

# Candidate window: how far apart two events' start times may be to still
# be considered as different occurrences of the same series. Generous
# enough to catch monthly/biweekly cadences, not just weekly.
CANDIDATE_WINDOW_DAYS = 120

# Two events whose starts are closer together than this are treated as the
# same occurrence (near-duplicate territory), not different occurrences of
# a series — skip them here so the two features don't overlap.
MIN_OCCURRENCE_SEPARATION_HOURS = 20

# Minimum difflib.SequenceMatcher ratio (0-1) on normalized titles for a
# pair to be flagged as a likely series match.
TITLE_SIMILARITY_THRESHOLD = 0.72

# Minimum ratio on normalized locations when BOTH events have one set.
# When either event has no location, the location check is skipped
# (title + calendar + cadence alone still has to clear the bar).
LOCATION_SIMILARITY_THRESHOLD = 0.6

_WHITESPACE_RE = re.compile(r"\s+")


class SeriesMembershipConflict(ValueError):
    """One or more events already belong to a series — the single-membership
    invariant (an event is in at most one series) would be violated."""

    def __init__(self, conflicts: dict[str, int]) -> None:
        self.conflicts = conflicts  # event_id -> existing series_id
        super().__init__("One or more events already belong to a series")


def _series_ids_for_events(session: Session, event_ids: list[str]) -> dict[str, int]:
    """Map each of ``event_ids`` that is already a series member to its series id."""
    if not event_ids:
        return {}
    rows = session.exec(
        select(EventSeriesMember.event_id, EventSeriesMember.series_id).where(
            EventSeriesMember.event_id.in_(event_ids)
        )
    ).all()
    return {event_id: series_id for event_id, series_id in rows}


def _series_of(session: Session, event_id: str) -> EventSeries | None:
    member = session.exec(
        select(EventSeriesMember).where(EventSeriesMember.event_id == event_id)
    ).first()
    if member is None:
        return None
    return session.get(EventSeries, member.series_id)


def _normalize(text: str) -> str:
    return _WHITESPACE_RE.sub(" ", (text or "").strip().lower())


def _similarity(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, _normalize(a), _normalize(b)).ratio()


def _is_auto_detect_enabled(session: Session) -> bool:
    """Mirrors the defensive style of ``duplicate_detection._is_auto_detect_enabled``:
    never let a settings lookup issue break the calling sync/edit flow."""
    try:
        row = session.get(SiteSetting, "series_auto_detect_enabled")
        if row:
            return row.value.lower() == "true"
    except Exception:
        pass
    return False


def _existing_pair_recorded(session: Session, event_id_a: str, event_id_b: str) -> bool:
    """True if event_id_a and event_id_b already co-occur in any series."""
    series_ids_a = set(
        session.exec(
            select(EventSeriesMember.series_id).where(
                EventSeriesMember.event_id == event_id_a
            )
        ).all()
    )
    if not series_ids_a:
        return False
    series_ids_b = set(
        session.exec(
            select(EventSeriesMember.series_id).where(
                EventSeriesMember.event_id == event_id_b
            )
        ).all()
    )
    return bool(series_ids_a & series_ids_b)


def find_candidate_matches(
    session: Session, event: CachedEvent, *, now: datetime | None = None
) -> list[CachedEvent]:
    """Active events in the same calendar, within ``CANDIDATE_WINDOW_DAYS``
    of ``event.start``, with a similar title (and location, when both are
    set) and a start time far enough away to not be a near-duplicate."""
    now = now or datetime.utcnow()
    window = timedelta(days=CANDIDATE_WINDOW_DAYS)
    min_gap = timedelta(hours=MIN_OCCURRENCE_SEPARATION_HOURS)

    narrowed = session.exec(
        select(CachedEvent).where(
            CachedEvent.event_id != event.event_id,
            CachedEvent.calendar_id == event.calendar_id,
            CachedEvent.deleted_at == None,  # noqa: E711
            CachedEvent.is_hidden == False,  # noqa: E712
            CachedEvent.end > now,
            CachedEvent.start >= event.start - window,
            CachedEvent.start <= event.start + window,
        )
    ).all()

    matches = []
    for c in narrowed:
        if abs(c.start - event.start) < min_gap:
            continue
        if _similarity(event.title, c.title) < TITLE_SIMILARITY_THRESHOLD:
            continue
        if event.location and c.location:
            if _similarity(event.location, c.location) < LOCATION_SIMILARITY_THRESHOLD:
                continue
        matches.append(c)
    return matches


def _add_to_series_or_create(
    session: Session,
    event_id: str,
    matched_event_id: str,
    canonical_title: str,
    *,
    source: str,
) -> EventSeries | None:
    """Ensure event_id and matched_event_id are recorded together in a
    pending series. Returns the (possibly newly created) series, or None
    if this pair was already recorded (skipped)."""
    if _existing_pair_recorded(session, event_id, matched_event_id):
        return None

    series_a = _series_of(session, event_id)
    series_b = _series_of(session, matched_event_id)

    # Single-membership invariant: an event belongs to at most one series,
    # so never span two series or disturb a resolved/dismissed membership.
    if series_a is not None and series_b is not None:
        return None

    series: EventSeries | None = None
    if series_a is not None and series_a.status == "pending":
        series = series_a
    elif series_b is not None and series_b.status == "pending":
        series = series_b
    elif series_a is not None or series_b is not None:
        return None

    if series is None:
        series = EventSeries(
            status="pending", source=source, canonical_title=canonical_title
        )
        session.add(series)
        session.flush()  # assign series.id

    for eid in (event_id, matched_event_id):
        if _series_of(session, eid) is None:
            session.add(EventSeriesMember(series_id=series.id, event_id=eid))

    return series


def detect_series_for_event(
    session: Session,
    event_id: str,
    *,
    scan_type: str = "incremental",
    triggered_by_event_id: str | None = None,
    triggered_by_admin: str | None = None,
) -> EventSeriesScanLog:
    """Run candidate detection for a single event and persist any new
    series. Always logs a scan-log row, even when nothing is found."""
    log = EventSeriesScanLog(
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
                series = _add_to_series_or_create(
                    session, event.event_id, match.event_id, event.title, source="auto"
                )
                if series is not None:
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


def maybe_detect_series_for_event(session: Session, event_id: str) -> None:
    """No-op unless ``series_auto_detect_enabled`` site setting is on.
    Call this after an event insert/update commit in the sync/admin paths."""
    if not _is_auto_detect_enabled(session):
        return
    detect_series_for_event(session, event_id, scan_type="incremental")


def run_full_scan(
    session: Session, *, triggered_by_admin: str | None = None
) -> EventSeriesScanLog:
    """On-demand full scan across all active, upcoming events. Available
    regardless of the auto-detect feature flag."""
    log = EventSeriesScanLog(scan_type="full", triggered_by_admin=triggered_by_admin)
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
                series = _add_to_series_or_create(
                    session, event.event_id, match.event_id, event.title, source="auto"
                )
                if series is not None:
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


def create_manual_series(
    session: Session,
    event_ids: list[str],
    *,
    canonical_title: str | None = None,
    triggered_by_admin: str | None = None,
) -> EventSeries:
    """Admin-initiated ad-hoc grouping ("Group as series" bulk action).
    Creates a new series. Rejects events that already belong to a series
    (single-membership invariant)."""
    conflicts = _series_ids_for_events(session, event_ids)
    if conflicts:
        raise SeriesMembershipConflict(conflicts)
    title = canonical_title or ""
    if not title and event_ids:
        first = session.get(CachedEvent, event_ids[0])
        title = first.title if first else ""
    series = EventSeries(status="pending", source="manual", canonical_title=title)
    session.add(series)
    session.flush()
    for event_id in event_ids:
        session.add(EventSeriesMember(series_id=series.id, event_id=event_id))

    log = EventSeriesScanLog(
        scan_type="manual",
        triggered_by_admin=triggered_by_admin,
        status="completed",
        finished_at=datetime.utcnow(),
        candidates_found=len(event_ids),
        groups_created=1,
    )
    session.add(log)
    session.commit()
    session.refresh(series)
    return series


def add_events_to_series(
    session: Session,
    series_id: int,
    event_ids: list[str],
) -> EventSeries:
    """Append events to an existing series. Rejects the whole operation if
    any event already belongs to a series (single-membership invariant)."""
    series = session.get(EventSeries, series_id)
    if series is None:
        raise ValueError("Series not found")
    conflicts = _series_ids_for_events(session, event_ids)
    if conflicts:
        raise SeriesMembershipConflict(conflicts)
    for event_id in event_ids:
        session.add(EventSeriesMember(series_id=series.id, event_id=event_id))
    session.commit()
    session.refresh(series)
    return series


def rename_series(
    session: Session, series_id: int, canonical_title: str
) -> EventSeries:
    series = session.get(EventSeries, series_id)
    if series is None:
        raise ValueError("Series not found")
    series.canonical_title = canonical_title
    session.add(series)
    session.commit()
    session.refresh(series)
    return series


def approve_series(
    session: Session,
    series_id: int,
    *,
    canonical_title: str | None = None,
    admin_email: str | None = None,
) -> EventSeries:
    """Resolve a series: an admin confirms this really is a recurring
    event. All members stay untouched (still independently visible)."""
    series = session.get(EventSeries, series_id)
    if series is None:
        raise ValueError("Series not found")
    if canonical_title is not None:
        series.canonical_title = canonical_title
    series.status = "resolved"
    series.resolved_at = datetime.utcnow()
    series.resolved_by_admin = admin_email
    session.add(series)
    session.commit()
    session.refresh(series)
    return series


def dismiss_series(
    session: Session, series_id: int, *, admin_email: str | None = None
) -> EventSeries:
    """Mark a series as not-actually-a-series. The pair(s) stay recorded
    so future scans won't recreate the group."""
    series = session.get(EventSeries, series_id)
    if series is None:
        raise ValueError("Series not found")
    series.status = "dismissed"
    series.resolved_at = datetime.utcnow()
    series.resolved_by_admin = admin_email
    session.add(series)
    session.commit()
    session.refresh(series)
    return series


def split_member(session: Session, series_id: int, event_id: str) -> EventSeries | None:
    """Remove a single occurrence from a series ("Split off"/"Remove"). The
    event itself is untouched, only its series membership is removed. When
    fewer than two members remain the series is hard-deleted (a series of
    one is meaningless); returns None in that case, else the series."""
    series = session.get(EventSeries, series_id)
    if series is None:
        raise ValueError("Series not found")
    member = session.exec(
        select(EventSeriesMember).where(
            EventSeriesMember.series_id == series_id,
            EventSeriesMember.event_id == event_id,
        )
    ).first()
    if member is None:
        raise ValueError("Event is not a member of this series")
    session.delete(member)
    session.flush()
    remaining = session.exec(
        select(EventSeriesMember).where(EventSeriesMember.series_id == series_id)
    ).all()
    if len(remaining) < 2:
        for row in remaining:
            session.delete(row)
        session.flush()  # remove member rows before the parent series (FK)
        session.delete(series)
        session.commit()
        return None
    session.commit()
    session.refresh(series)
    return series


def get_series_for_event(
    session: Session,
    event_id: str,
    statuses: tuple[str, ...] = ("pending",),
) -> list[EventSeries]:
    """Series (in the given statuses) that include this event — used by the
    admin event-detail panel's "Part of a series" section. Defaults to
    pending-only; the detail route also includes resolved membership."""
    series_ids = session.exec(
        select(EventSeriesMember.series_id).where(
            EventSeriesMember.event_id == event_id
        )
    ).all()
    if not series_ids:
        return []
    return session.exec(
        select(EventSeries).where(
            EventSeries.id.in_(series_ids),
            EventSeries.status.in_(statuses),
        )
    ).all()
