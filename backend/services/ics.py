"""Shared iCalendar (RFC 5545) rendering for downloads and live feeds."""

from datetime import datetime, timezone

from backend.db.models import CachedEvent


def ics_escape(text: str) -> str:
    """Escape special characters for iCalendar text values."""
    return (
        text.replace("\\", "\\\\")
        .replace(";", "\\;")
        .replace(",", "\\,")
        .replace("\n", "\\n")
        .replace("\r", "")
    )


def fold_ics_line(line: str, limit: int = 75) -> list[str]:
    parts: list[str] = []
    remaining = line
    first = True
    while remaining:
        prefix = "" if first else " "
        available = limit - len(prefix.encode("utf-8"))
        end = 0
        size = 0
        for end, character in enumerate(remaining, start=1):
            character_size = len(character.encode("utf-8"))
            if size + character_size > available:
                end -= 1
                break
            size += character_size
        if end == 0:
            end = 1
        parts.append(f"{prefix}{remaining[:end]}")
        remaining = remaining[end:]
        first = False
    return parts or [""]


def render_ics(lines: list[str]) -> str:
    return (
        "\r\n".join(folded for line in lines for folded in fold_ics_line(line)) + "\r\n"
    )


def build_ics(
    events: list[CachedEvent],
    *,
    calendar_name: str | None = None,
    refresh_hours: int | None = None,
    prodid: str = "-//Movida//EN",
) -> str:
    """Build an iCalendar string from a list of events.

    ``calendar_name`` and ``refresh_hours`` add the metadata that calendar
    clients (Apple/Google) use when a URL is *subscribed* to rather than
    imported once: a human-readable name and a polling hint.
    """
    now = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        f"PRODID:{prodid}",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
    ]
    if calendar_name:
        lines.append(f"NAME:{ics_escape(calendar_name)}")
        lines.append(f"X-WR-CALNAME:{ics_escape(calendar_name)}")
    if refresh_hours:
        lines.append(f"REFRESH-INTERVAL;VALUE=DURATION:PT{refresh_hours}H")
        lines.append(f"X-PUBLISHED-TTL:PT{refresh_hours}H")
    for e in events:
        lines.append("BEGIN:VEVENT")
        lines.append(f"UID:{e.event_id}@movida")
        lines.append(f"DTSTAMP:{now}")
        if e.all_day:
            lines.append(f"DTSTART;VALUE=DATE:{e.start.strftime('%Y%m%d')}")
            lines.append(f"DTEND;VALUE=DATE:{e.end.strftime('%Y%m%d')}")
        else:
            lines.append(f"DTSTART:{e.start.strftime('%Y%m%dT%H%M%SZ')}")
            lines.append(f"DTEND:{e.end.strftime('%Y%m%dT%H%M%SZ')}")
        lines.append(f"SUMMARY:{ics_escape(e.title)}")
        if e.location:
            lines.append(f"LOCATION:{ics_escape(e.location)}")
        if e.description:
            lines.append(f"DESCRIPTION:{ics_escape(e.description)}")
        lines.append("END:VEVENT")
    lines.append("END:VCALENDAR")
    return render_ics(lines)
