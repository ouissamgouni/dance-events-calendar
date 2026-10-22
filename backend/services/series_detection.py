"""Recurring-event ("series") detection for CachedEvent rows.

An event *series* is a cluster of CachedEvent rows suspected of being
different occurrences of the same recurring event — a weekly social, or the
yearly editions of a festival (this repo has no ``recurringEventId``/iCalUID
captured during sync, so series identity is inferred, not structural).

Two-step algorithm (same SQLite/Postgres portability constraint as
``backend.services.duplicate_detection`` — no trigram extension):

  1. An indexed SQL query narrows candidates to active events — upcoming or
     already ended — whose start is within ``max_gap_days`` of the target's.
     Calendars may differ (a festival's yearly editions are often listed by
     different organizers/aggregators).
  2. Each candidate is compared in Python (``_is_match``):
       - start gap of at least ``MIN_OCCURRENCE_SEPARATION_HOURS`` (closer
         starts are the same occurrence — duplicate detection's territory);
       - title similarity on normalized titles with years/edition markers
         and generic words ("salsa", "festival", ...) removed;
       - location: same place_id, within ``venue_radius_m``, same city, or a
         textual match; never more than ``max_distance_km`` apart. With no
         location data at all, only same-calendar events can match.

Detected pairs are grouped by membership: if the matched event already
belongs to a pending series the new event joins it; a resolved series is
joined and reopened as pending (when ``join_resolved_enabled``) so an admin
re-confirms; dismissed series and events an admin removed from a series
(``EventSeriesExclusion``) are never touched. Once two events have been
recorded together, the scan won't regroup that pair.

Thresholds are admin-tunable site settings (``load_config``).

Unlike duplicate resolution, approving/dismissing a series never hides or
blocks any member event — every occurrence stays independently visible.
"""

from __future__ import annotations

import bisect
import difflib
import math
import re
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlmodel import Session, select

from backend.db.models import (
    CachedEvent,
    EventSeries,
    EventSeriesExclusion,
    EventSeriesMember,
    EventSeriesScanLog,
    SiteSetting,
)

# Two events whose starts are closer together than this are treated as the
# same occurrence (near-duplicate territory), not different occurrences of
# a series — skip them here so the two features don't overlap.
MIN_OCCURRENCE_SEPARATION_HOURS = 20

# Minimum ratio on normalized location text (fallback when coordinates and
# city don't decide).
LOCATION_SIMILARITY_THRESHOLD = 0.6

DEFAULT_GENERIC_TITLE_WORDS = (
    "salsa", "bachata", "kizomba", "zouk", "mambo", "tango", "son", "cha",
    "rueda", "semba", "kompa", "latin", "latino", "afro", "sensual", "dance",
    "dancing", "festival", "fest", "congress", "weekend", "marathon",
    "social", "night", "party", "workshop", "workshops", "bootcamp",
    "edition", "official", "event", "international", "int", "world", "the",
    "and", "of", "at", "in", "by", "with", "a", "de", "la", "le", "el", "y",
    "et", "du", "des", "en",
)  # fmt: skip

SETTING_KEYS = {
    "auto_detect_enabled": "series_auto_detect_enabled",
    "title_similarity_pct": "series_title_similarity_pct",
    "max_gap_days": "series_max_gap_days",
    "venue_radius_m": "series_venue_radius_m",
    "max_distance_km": "series_max_distance_km",
    "cross_calendar_enabled": "series_cross_calendar_enabled",
    "join_resolved_enabled": "series_join_resolved_enabled",
    "generic_title_words": "series_generic_title_words",
}


@dataclass(frozen=True)
class SeriesDetectionConfig:
    auto_detect_enabled: bool = False
    title_similarity_pct: int = 72
    max_gap_days: int = 395  # a yearly edition plus a month of drift
    venue_radius_m: int = 300
    max_distance_km: int = 50
    cross_calendar_enabled: bool = True
    join_resolved_enabled: bool = True
    generic_title_words: tuple[str, ...] = DEFAULT_GENERIC_TITLE_WORDS


DEFAULT_CONFIG = SeriesDetectionConfig()

_WHITESPACE_RE = re.compile(r"\s+")
_YEAR_RE = re.compile(r"\b(?:19|20)\d{2}\b")
_EDITION_RE = re.compile(
    r"\b\d+\s*(?:st|nd|rd|th)?\s*edition\b|\bedition\s*\d+\b|\b\d+(?:st|nd|rd|th)\b",
    re.IGNORECASE,
)
_HEAD_SPLIT_RE = re.compile(r"\s[-|\u2013\u2014:]\s|\s\(|\*")
_NON_WORD_RE = re.compile(r"[^\w\s]+")
_EMPTY_PARENS_RE = re.compile(r"\(\s*\)|\[\s*\]")
_EDGE_PUNCT = " -|\u2013\u2014:,*"


class SeriesMembershipConflict(ValueError):
    """One or more events already belong to a series — the single-membership
    invariant (an event is in at most one series) would be violated."""

    def __init__(self, conflicts: dict[str, int]) -> None:
        self.conflicts = conflicts  # event_id -> existing series_id
        super().__init__("One or more events already belong to a series")


def _parse_words(raw: str) -> tuple[str, ...]:
    return tuple(w for w in (p.strip().lower() for p in raw.split(",")) if w)


def load_config(session: Session) -> SeriesDetectionConfig:
    values: dict = {}
    for field, key in SETTING_KEYS.items():
        row = session.get(SiteSetting, key)
        if row is None:
            continue
        default = getattr(DEFAULT_CONFIG, field)
        if isinstance(default, bool):
            values[field] = row.value.lower() == "true"
        elif isinstance(default, int):
            if row.value.isdigit():
                values[field] = int(row.value)
        else:
            values[field] = _parse_words(row.value)
    return SeriesDetectionConfig(**values)


def save_config(session: Session, updates: dict) -> SeriesDetectionConfig:
    for field, value in updates.items():
        if value is None or field not in SETTING_KEYS:
            continue
        if isinstance(value, bool):
            stored = str(value).lower()
        elif isinstance(value, int):
            stored = str(value)
        else:
            stored = ",".join(_parse_words(",".join(value)))
        key = SETTING_KEYS[field]
        row = session.get(SiteSetting, key)
        if row:
            row.value = stored
        else:
            row = SiteSetting(key=key, value=stored)
        session.add(row)
    session.commit()
    return load_config(session)


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


def _strip_editions(title: str) -> str:
    text = unicodedata.normalize("NFKC", title or "")
    text = _YEAR_RE.sub(" ", text)
    return _EDITION_RE.sub(" ", text)


def _title_tokens(text: str) -> list[str]:
    return [w for w in _NON_WORD_RE.sub(" ", text.lower()).split() if not w.isdigit()]


def _token_score(a: list[str], b: list[str], generic: frozenset[str]) -> float:
    if not a or not b:
        return 0.0
    da = [w for w in a if w not in generic]
    db = [w for w in b if w not in generic]
    if not da and not db:
        # Nothing distinctive ("Salsa Marathon" vs "Salsa Weekend"): exact words only.
        return 1.0 if set(a) == set(b) else 0.0
    if not da or not db:
        return 0.0
    in_order = difflib.SequenceMatcher(None, " ".join(da), " ".join(db)).ratio()
    any_order = difflib.SequenceMatcher(
        None, " ".join(sorted(da)), " ".join(sorted(db))
    ).ratio()
    return max(in_order, any_order)


def _title_score(a: str, b: str, generic: frozenset[str]) -> float:
    """Best similarity between the full titles and between their heads (the
    part before " - ", "(" or "|"), ignoring years, editions and generic words."""
    sa, sb = _strip_editions(a), _strip_editions(b)
    full = _token_score(_title_tokens(sa), _title_tokens(sb), generic)
    head = _token_score(
        _title_tokens(_HEAD_SPLIT_RE.split(sa)[0]),
        _title_tokens(_HEAD_SPLIT_RE.split(sb)[0]),
        generic,
    )
    return max(full, head)


def canonical_series_title(title: str) -> str:
    text = _EMPTY_PARENS_RE.sub(" ", _strip_editions(title))
    text = _WHITESPACE_RE.sub(" ", text).strip(_EDGE_PUNCT)
    return text or title


def _distance_km(a: CachedEvent, b: CachedEvent) -> float | None:
    if None in (a.latitude, a.longitude, b.latitude, b.longitude):
        return None
    p1, p2 = math.radians(a.latitude), math.radians(b.latitude)
    dp = p2 - p1
    dl = math.radians(b.longitude - a.longitude)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))


def _location_text_match(a: str, b: str) -> bool:
    a, b = _normalize(a), _normalize(b)
    return (
        a in b
        or b in a
        or a.split(",")[0].strip() == b.split(",")[0].strip()
        or _similarity(a, b) >= LOCATION_SIMILARITY_THRESHOLD
    )


def _locations_match(
    a: CachedEvent, b: CachedEvent, cfg: SeriesDetectionConfig
) -> bool | None:
    """True/False when location data decides, None when there's none to compare.
    Coordinates are often city-level geocodes, so city and text also count."""
    distance = _distance_km(a, b)
    if distance is not None and distance > cfg.max_distance_km:
        return False
    if a.place_id and a.place_id == b.place_id:
        return True
    if distance is not None and distance * 1000 <= cfg.venue_radius_m:
        return True
    if (
        a.city
        and b.city
        and _normalize(a.city) == _normalize(b.city)
        and (a.country_code or "").lower() == (b.country_code or "").lower()
    ):
        return True
    if a.location and b.location:
        return _location_text_match(a.location, b.location)
    if distance is not None:
        return False
    return None


def _is_match(
    target: CachedEvent, candidate: CachedEvent, cfg: SeriesDetectionConfig
) -> bool:
    if candidate.event_id == target.event_id:
        return False
    gap = abs(candidate.start - target.start)
    if gap < timedelta(hours=MIN_OCCURRENCE_SEPARATION_HOURS):
        return False
    if gap > timedelta(days=cfg.max_gap_days):
        return False
    same_calendar = candidate.calendar_id == target.calendar_id
    if not same_calendar and not cfg.cross_calendar_enabled:
        return False
    # A shared city name alone doesn't make two titles the same event.
    cities = {w for e in (target, candidate) if e.city for w in _title_tokens(e.city)}
    generic = frozenset(cfg.generic_title_words) | cities
    score = _title_score(target.title, candidate.title, generic)
    if score < cfg.title_similarity_pct / 100:
        return False
    location = _locations_match(target, candidate, cfg)
    if location is None:
        return same_calendar
    return location


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


def _is_excluded(session: Session, series_id: int, event_id: str) -> bool:
    return (
        session.exec(
            select(EventSeriesExclusion.id).where(
                EventSeriesExclusion.series_id == series_id,
                EventSeriesExclusion.event_id == event_id,
            )
        ).first()
        is not None
    )


def _occurrence_taken(session: Session, series_id: int, event_id: str) -> bool:
    """True if the series already has a member for this event's occurrence
    (e.g. the same night cross-posted on another calendar)."""
    event = session.get(CachedEvent, event_id)
    min_gap = timedelta(hours=MIN_OCCURRENCE_SEPARATION_HOURS)
    members = session.exec(
        select(CachedEvent)
        .join(EventSeriesMember, EventSeriesMember.event_id == CachedEvent.event_id)
        .where(EventSeriesMember.series_id == series_id)
    ).all()
    return any(abs(m.start - event.start) < min_gap for m in members)


def _candidate_query(event: CachedEvent, cfg: SeriesDetectionConfig):
    window = timedelta(days=cfg.max_gap_days)
    query = select(CachedEvent).where(
        CachedEvent.event_id != event.event_id,
        CachedEvent.deleted_at == None,  # noqa: E711
        CachedEvent.is_hidden == False,  # noqa: E712
        CachedEvent.start >= event.start - window,
        CachedEvent.start <= event.start + window,
    )
    if not cfg.cross_calendar_enabled:
        query = query.where(CachedEvent.calendar_id == event.calendar_id)
    return query


def find_candidate_matches(
    session: Session,
    event: CachedEvent,
    cfg: SeriesDetectionConfig | None = None,
) -> list[CachedEvent]:
    """Active events (upcoming or ended) that look like another occurrence of
    ``event`` — see the module docstring for the matching rules."""
    cfg = cfg or load_config(session)
    narrowed = session.exec(_candidate_query(event, cfg)).all()
    return [c for c in narrowed if _is_match(event, c, cfg)]


def _add_to_series_or_create(
    session: Session,
    event_id: str,
    matched_event_id: str,
    title: str,
    *,
    source: str,
    cfg: SeriesDetectionConfig = DEFAULT_CONFIG,
) -> EventSeries | None:
    """Ensure event_id and matched_event_id are recorded together in a
    series. Returns the joined/created series, or None when skipped."""
    if _existing_pair_recorded(session, event_id, matched_event_id):
        return None

    series_a = _series_of(session, event_id)
    series_b = _series_of(session, matched_event_id)

    # Single-membership invariant: an event belongs to at most one series.
    if series_a is not None and series_b is not None:
        return None

    existing = series_a or series_b
    if existing is not None:
        newcomer = matched_event_id if series_a is not None else event_id
        if (
            existing.status == "dismissed"
            or _is_excluded(session, existing.id, newcomer)
            or _occurrence_taken(session, existing.id, newcomer)
        ):
            return None
        if existing.status == "resolved":
            if not cfg.join_resolved_enabled:
                return None
            existing.status = "pending"
            existing.resolved_at = None
            existing.resolved_by_admin = None
            session.add(existing)
        session.add(EventSeriesMember(series_id=existing.id, event_id=newcomer))
        session.flush()
        return existing

    series = EventSeries(
        status="pending", source=source, canonical_title=canonical_series_title(title)
    )
    session.add(series)
    session.flush()  # assign series.id
    for eid in (event_id, matched_event_id):
        session.add(EventSeriesMember(series_id=series.id, event_id=eid))
    session.flush()
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
        cfg = load_config(session)
        event = session.get(CachedEvent, event_id)
        if (
            event is not None
            and event.deleted_at is None
            and not event.is_hidden
            and event.end > datetime.now(timezone.utc)
        ):
            matches = find_candidate_matches(session, event, cfg)
            candidates_found = len(matches)
            for match in matches:
                series = _add_to_series_or_create(
                    session,
                    event.event_id,
                    match.event_id,
                    event.title,
                    source="auto",
                    cfg=cfg,
                )
                if series is not None:
                    groups_created += 1
        log.status = "completed"
    except Exception:
        log.status = "failed"
        raise
    finally:
        log.finished_at = datetime.now(timezone.utc)
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
        cfg = load_config(session)
        now = datetime.now(timezone.utc)
        window = timedelta(days=cfg.max_gap_days)
        active = (
            CachedEvent.deleted_at == None,  # noqa: E711
            CachedEvent.is_hidden == False,  # noqa: E712
        )
        targets = session.exec(
            select(CachedEvent)
            .where(*active, CachedEvent.end > now)
            .order_by(CachedEvent.start, CachedEvent.event_id)
        ).all()
        # One in-memory pool instead of a query per target.
        pool = session.exec(
            select(CachedEvent)
            .where(*active, CachedEvent.start >= now - window)
            .order_by(CachedEvent.start, CachedEvent.event_id)
        ).all()
        pool_starts = [e.start for e in pool]

        seen_pairs: set[tuple[str, str]] = set()
        for event in targets:
            lo = bisect.bisect_left(pool_starts, event.start - window)
            hi = bisect.bisect_right(pool_starts, event.start + window)
            for match in pool[lo:hi]:
                pair = tuple(sorted((event.event_id, match.event_id)))
                if pair in seen_pairs or not _is_match(event, match, cfg):
                    continue
                seen_pairs.add(pair)
                candidates_found += 1
                series = _add_to_series_or_create(
                    session,
                    event.event_id,
                    match.event_id,
                    event.title,
                    source="auto",
                    cfg=cfg,
                )
                if series is not None:
                    groups_created += 1
        log.status = "completed"
    except Exception:
        log.status = "failed"
        raise
    finally:
        log.finished_at = datetime.now(timezone.utc)
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
        finished_at=datetime.now(timezone.utc),
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
    for exclusion in session.exec(
        select(EventSeriesExclusion).where(
            EventSeriesExclusion.series_id == series_id,
            EventSeriesExclusion.event_id.in_(event_ids),
        )
    ).all():
        session.delete(exclusion)
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
    series.resolved_at = datetime.now(timezone.utc)
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
    series.resolved_at = datetime.now(timezone.utc)
    series.resolved_by_admin = admin_email
    session.add(series)
    session.commit()
    session.refresh(series)
    return series


def split_member(session: Session, series_id: int, event_id: str) -> EventSeries | None:
    """Remove a single occurrence from a series ("Split off"/"Remove"). The
    event itself is untouched, only its series membership is removed, and
    auto-detection won't re-add it. When fewer than two members remain the
    series is hard-deleted (a series of one is meaningless); returns None in
    that case, else the series."""
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
        exclusions = session.exec(
            select(EventSeriesExclusion).where(
                EventSeriesExclusion.series_id == series_id
            )
        ).all()
        for row in [*remaining, *exclusions]:
            session.delete(row)
        session.flush()  # remove child rows before the parent series (FK)
        session.delete(series)
        session.commit()
        return None
    if not _is_excluded(session, series_id, event_id):
        session.add(EventSeriesExclusion(series_id=series_id, event_id=event_id))
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
