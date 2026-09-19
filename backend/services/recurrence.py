"""Expansion of user-declared event recurrence into concrete occurrences.

Two mutually exclusive inputs, mirroring ``EventSuggestion``:

- ``recurrence_rule`` — an RFC 5545 RRULE line whose DTSTART is the event's
  own ``start``. Weekly/monthly/yearly only. May be open-ended (no UNTIL and
  no COUNT), in which case occurrences are materialised over a rolling window
  rather than all at once — see ``backend/services/recurrence_extension.py``.
- ``recurrence_dates`` — explicit ``{"start": .., "end": ..}`` occurrences, each
  free to carry its own duration. RDATE cannot express per-occurrence
  durations, which is why this is a separate field rather than more RRULE text.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any, Iterable, Optional, Sequence

from dateutil.rrule import rrulestr

logger = logging.getLogger(__name__)

# Rows materialised by a single expansion. Also the hard ceiling on an
# explicit-date list, and what bounds a COUNT=9999-style rule.
MAX_OCCURRENCES = 52
# Rolling materialisation window for open-ended rules.
MAX_HORIZON_DAYS = 366
# Absolute ceiling for a series, however many times the extension job runs.
MAX_SERIES_OCCURRENCES = 520

ALLOWED_FREQUENCIES = frozenset({"WEEKLY", "MONTHLY", "YEARLY"})

Occurrence = tuple[datetime, datetime]


def normalize_rule(rule: str) -> str:
    """Return ``rule`` as a single ``RRULE:``-prefixed line."""
    cleaned = " ".join(str(rule).split()).strip()
    if not cleaned:
        raise ValueError("Recurrence rule is empty")
    if "\n" in cleaned or "\r" in cleaned:
        raise ValueError("Recurrence rule must be a single line")
    upper = cleaned.upper()
    if upper.startswith("RRULE:"):
        return "RRULE:" + cleaned[len("RRULE:") :].strip()
    if (
        upper.startswith("DTSTART")
        or upper.startswith("RDATE")
        or upper.startswith("EXDATE")
    ):
        raise ValueError("Only a single RRULE line is supported")
    return "RRULE:" + cleaned


def _rule_parts(rule: str) -> dict[str, str]:
    body = normalize_rule(rule)[len("RRULE:") :]
    parts: dict[str, str] = {}
    for chunk in body.split(";"):
        if not chunk:
            continue
        name, _, value = chunk.partition("=")
        parts[name.strip().upper()] = value.strip()
    return parts


def validate_rule(rule: str) -> str:
    """Validate and normalize an RRULE, raising ``ValueError`` if unusable."""
    normalized = normalize_rule(rule)
    parts = _rule_parts(normalized)
    freq = parts.get("FREQ", "").upper()
    if freq not in ALLOWED_FREQUENCIES:
        raise ValueError(
            "Recurrence FREQ must be one of " + ", ".join(sorted(ALLOWED_FREQUENCIES))
        )
    if "UNTIL" in parts and "COUNT" in parts:
        raise ValueError("Recurrence cannot set both UNTIL and COUNT")
    try:
        rrulestr(normalized, dtstart=datetime(2000, 1, 1))
    except Exception as exc:  # dateutil raises bare ValueError/TypeError
        raise ValueError(f"Invalid recurrence rule: {exc}") from exc
    return normalized


def is_open_ended(rule: Optional[str]) -> bool:
    """True when the rule repeats forever (no UNTIL and no COUNT)."""
    if not rule:
        return False
    try:
        parts = _rule_parts(rule)
    except ValueError:
        return False
    return "UNTIL" not in parts and "COUNT" not in parts


def _coerce_datetime(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        text = value.strip()
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        parsed = datetime.fromisoformat(text)
        return parsed.replace(tzinfo=None) if parsed.tzinfo else parsed
    raise ValueError(f"Expected a datetime, got {type(value).__name__}")


def normalize_dates(items: Iterable[Any]) -> list[Occurrence]:
    """Parse, validate, de-duplicate and sort explicit occurrences."""
    occurrences: list[Occurrence] = []
    seen: set[datetime] = set()
    for item in items:
        if isinstance(item, dict):
            raw_start, raw_end = item.get("start"), item.get("end")
        else:
            raw_start, raw_end = (
                getattr(item, "start", None),
                getattr(item, "end", None),
            )
        if raw_start is None or raw_end is None:
            raise ValueError("Each recurrence date needs a start and an end")
        start = _coerce_datetime(raw_start)
        end = _coerce_datetime(raw_end)
        if end <= start:
            raise ValueError("Each recurrence date must end after it starts")
        if start in seen:
            continue
        seen.add(start)
        occurrences.append((start, end))
    occurrences.sort(key=lambda pair: pair[0])
    return occurrences[:MAX_OCCURRENCES]


def expand_occurrences(
    start: datetime,
    end: datetime,
    recurrence_rule: Optional[str] = None,
    recurrence_dates: Optional[Sequence[Any]] = None,
    *,
    limit: Optional[int] = None,
    horizon_end: Optional[datetime] = None,
) -> list[Occurrence]:
    """Materialise ``(start, end)`` pairs for one suggestion.

    Always expands from the original start so an occurrence's index is stable
    across calls — the index is what the CachedEvent id is derived from.
    """
    cap = max(1, min(limit or MAX_OCCURRENCES, MAX_SERIES_OCCURRENCES))

    if recurrence_dates:
        return normalize_dates(recurrence_dates)[:cap]

    if not recurrence_rule:
        return [(start, end)]

    try:
        normalized = validate_rule(recurrence_rule)
        rule = rrulestr(normalized, dtstart=start)
    except ValueError:
        logger.warning(
            "Unusable recurrence rule %r; falling back to a single occurrence",
            recurrence_rule,
        )
        return [(start, end)]

    duration = end - start
    horizon = horizon_end or (start + timedelta(days=MAX_HORIZON_DAYS))
    occurrences: list[Occurrence] = []
    for occurrence_start in rule:
        if occurrence_start > horizon:
            break
        occurrences.append((occurrence_start, occurrence_start + duration))
        if len(occurrences) >= cap:
            break
    return occurrences or [(start, end)]
