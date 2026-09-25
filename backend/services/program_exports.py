import csv
import io
from datetime import datetime, timezone
from urllib.parse import quote
from zoneinfo import ZoneInfo

from backend.config.loader import get_public_app_url
from backend.db.models import CachedEvent, SchedulePublication
from backend.services.ics import ics_escape, render_ics
from backend.services.schedules import program_day_for, utc_isoformat


def _datetime(value: str | datetime) -> datetime:
    if isinstance(value, datetime):
        return value
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _utc(value: str | datetime) -> datetime:
    parsed = _datetime(value)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _ics_datetime(value: str | datetime) -> str:
    return _utc(value).strftime("%Y%m%dT%H%M%SZ")


def _lookup(rows: list[dict]) -> dict[object, dict]:
    return {row["id"]: row for row in rows}


def build_program_projection(
    event: CachedEvent,
    publication: SchedulePublication,
    *,
    days: list[str] | None = None,
    include_cancelled: bool = True,
    selected_sessions: list[tuple[dict, str]] | None = None,
) -> dict:
    snapshot = publication.snapshot
    available_days = [str(value) for value in snapshot.get("days", [])]
    selected_days = available_days if days is None else days
    unknown_days = sorted(set(selected_days) - set(available_days))
    if unknown_days:
        raise ValueError(f"Unknown program day: {unknown_days[0]}")

    timezone_name = snapshot["timezone"]
    day_start_hour = snapshot.get("day_start_hour", 6)
    local_timezone = ZoneInfo(timezone_name)
    venues = _lookup(snapshot.get("venues", []))
    rooms = _lookup(snapshot.get("rooms", []))
    levels = _lookup(snapshot.get("levels", []))
    activity_types = _lookup(snapshot.get("activity_types", []))
    source_sessions = (
        selected_sessions
        if selected_sessions is not None
        else [
            (row, "cancelled" if row.get("is_cancelled") else "active")
            for row in snapshot.get("sessions", [])
        ]
    )
    sessions = []
    for row, status in source_sessions:
        if status != "active" and not include_cancelled:
            continue
        start = _utc(row["start"])
        end = _utc(row["end"])
        program_day = program_day_for(start, timezone_name, day_start_hour).isoformat()
        if days is not None and program_day not in selected_days:
            continue
        room = rooms.get(row.get("room_id"), {})
        venue = venues.get(row.get("venue_id") or room.get("venue_id"), {})
        level = levels.get(row.get("level_id"), {})
        activity_type = activity_types.get(row.get("activity_type_id"), {})
        local_start = start.astimezone(local_timezone)
        local_end = end.astimezone(local_timezone)
        sessions.append(
            {
                "id": str(row["id"]),
                "title": row["title"],
                "instructors": row.get("instructors"),
                "start": utc_isoformat(start),
                "end": utc_isoformat(end),
                "program_day": program_day,
                "local_date": local_start.date().isoformat(),
                "local_start_time": local_start.strftime("%H:%M"),
                "local_end_time": local_end.strftime("%H:%M"),
                "venue": venue.get("name"),
                "room": room.get("name"),
                "address": venue.get("address"),
                "level": level.get("label"),
                "activity_type": activity_type.get("name"),
                "attendee_note": row.get("attendee_note"),
                "status": status,
                "venue_sort_order": venue.get("sort_order", 0),
                "room_sort_order": room.get("sort_order", 0),
            }
        )
    sessions.sort(
        key=lambda row: (
            row["start"],
            row["venue_sort_order"],
            row["room_sort_order"],
            row["title"].casefold(),
        )
    )
    for row in sessions:
        row.pop("venue_sort_order")
        row.pop("room_sort_order")

    app_url = get_public_app_url().rstrip("/")
    return {
        "event_id": event.event_id,
        "event_title": event.title,
        "program_url": f"{app_url}/event/{quote(event.event_id, safe='')}/program",
        "timezone": timezone_name,
        "day_start_hour": day_start_hour,
        "available_days": available_days,
        "selected_days": selected_days,
        "version": publication.version,
        "published_at": utc_isoformat(publication.published_at),
        "sessions": sessions,
    }


def render_program_ics(projection: dict, *, my_plan: bool = False) -> str:
    calendar_name = (
        f"{projection['event_title']} - My Plan"
        if my_plan
        else f"{projection['event_title']} Program"
    )
    published_at = _ics_datetime(projection["published_at"])
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Movida//Event Program//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        f"NAME:{ics_escape(calendar_name)}",
        f"X-WR-CALNAME:{ics_escape(calendar_name)}",
        f"X-WR-TIMEZONE:{ics_escape(projection['timezone'])}",
    ]
    for session in projection["sessions"]:
        location = ", ".join(
            value
            for value in (session["room"], session["venue"], session["address"])
            if value
        )
        description = "\n".join(
            value
            for value in (
                f"Instructors: {session['instructors']}"
                if session["instructors"]
                else None,
                f"Activity: {session['activity_type']}"
                if session["activity_type"]
                else None,
                f"Level: {session['level']}" if session["level"] else None,
                session["attendee_note"],
            )
            if value
        )
        lines.extend(
            [
                "BEGIN:VEVENT",
                f"UID:{session['id']}@program.joinmovida.com",
                f"SEQUENCE:{projection['version']}",
                f"DTSTAMP:{published_at}",
                f"LAST-MODIFIED:{published_at}",
                f"DTSTART:{_ics_datetime(session['start'])}",
                f"DTEND:{_ics_datetime(session['end'])}",
                f"SUMMARY:{ics_escape(session['title'])}",
            ]
        )
        if location:
            lines.append(f"LOCATION:{ics_escape(location)}")
        if description:
            lines.append(f"DESCRIPTION:{ics_escape(description)}")
        lines.append(f"URL:{projection['program_url']}")
        if session["status"] != "active":
            lines.append("STATUS:CANCELLED")
        lines.append("END:VEVENT")
    lines.append("END:VCALENDAR")
    return render_ics(lines)


def _safe_csv_cell(value: object) -> object:
    if isinstance(value, str) and value.lstrip().startswith(("=", "+", "-", "@")):
        return f"'{value}"
    return value


def render_program_csv(projection: dict) -> bytes:
    output = io.StringIO(newline="")
    writer = csv.writer(output, lineterminator="\r\n")
    writer.writerow(
        [
            "Event",
            "Program day",
            "Date",
            "Start time",
            "End time",
            "Time zone",
            "Session",
            "Instructors",
            "Activity type",
            "Level",
            "Venue",
            "Room",
            "Address",
            "Status",
            "Notes",
        ]
    )
    for session in projection["sessions"]:
        writer.writerow(
            [
                _safe_csv_cell(projection["event_title"]),
                session["program_day"],
                session["local_date"],
                session["local_start_time"],
                session["local_end_time"],
                projection["timezone"],
                _safe_csv_cell(session["title"]),
                _safe_csv_cell(session["instructors"] or ""),
                _safe_csv_cell(session["activity_type"] or ""),
                _safe_csv_cell(session["level"] or ""),
                _safe_csv_cell(session["venue"] or ""),
                _safe_csv_cell(session["room"] or ""),
                _safe_csv_cell(session["address"] or ""),
                session["status"].title(),
                _safe_csv_cell(session["attendee_note"] or ""),
            ]
        )
    return b"\xef\xbb\xbf" + output.getvalue().encode("utf-8")
