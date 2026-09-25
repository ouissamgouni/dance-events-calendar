from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlmodel import Session, select

from backend.db.models import (
    CachedEvent,
    EventSchedule,
    ScheduleActivityType,
    ScheduleLevel,
    SchedulePublication,
    ScheduleRoom,
    ScheduleSession,
    ScheduleVenue,
)


DEFAULT_ACTIVITY_TYPES = (
    ("Workshop", "blue"),
    ("Bootcamp", "violet"),
    ("Social", "amber"),
    ("Show", "pink"),
    ("Rehearsal", "orange"),
    ("Party", "emerald"),
    ("Afterparty", "indigo"),
    ("Other", "slate"),
)

DANCE_LEVEL_PRESET = (
    ("open-level", "Open Level", None),
    ("beginner", "Beginner", "*"),
    ("intermediate", "Intermediate", "**"),
    ("advanced", "Advanced", "***"),
)


def validate_timezone(value: str) -> str:
    try:
        ZoneInfo(value)
    except ZoneInfoNotFoundError as exc:
        raise ValueError("Unknown IANA timezone") from exc
    return value


def to_utc_naive(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)


def utc_isoformat(value: datetime) -> str:
    utc_value = (
        value
        if value.tzinfo is None
        else value.astimezone(timezone.utc).replace(tzinfo=None)
    )
    return f"{utc_value.isoformat()}Z"


def program_day_for(value: datetime, timezone_name: str, day_start_hour: int) -> date:
    aware = value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value
    local = aware.astimezone(ZoneInfo(timezone_name))
    return (local - timedelta(hours=day_start_hour)).date()


def default_schedule_days(event: CachedEvent, timezone_name: str) -> list[str]:
    start = program_day_for(event.start, timezone_name, 0)
    end = program_day_for(event.end, timezone_name, 0)
    return [
        (start + timedelta(days=offset)).isoformat()
        for offset in range((end - start).days + 1)
    ]


def seed_default_activity_types(session: Session, schedule_id: int) -> None:
    for sort_order, (name, color) in enumerate(DEFAULT_ACTIVITY_TYPES):
        session.add(
            ScheduleActivityType(
                schedule_id=schedule_id,
                name=name,
                color=color,
                sort_order=sort_order,
            )
        )


def seed_dance_level_preset(session: Session, schedule_id: int) -> int:
    existing_rows = session.exec(
        select(ScheduleLevel).where(ScheduleLevel.schedule_id == schedule_id)
    ).all()
    by_external_id = {row.external_id: row for row in existing_rows if row.external_id}
    by_label = {row.label.casefold(): row for row in existing_rows}
    created = 0
    for sort_order, (external_id, label, notation) in enumerate(DANCE_LEVEL_PRESET):
        row = by_external_id.get(external_id) or by_label.get(label.casefold())
        if row is not None:
            if row.external_id is None:
                row.external_id = external_id
                session.add(row)
            continue
        session.add(
            ScheduleLevel(
                schedule_id=schedule_id,
                external_id=external_id,
                label=label,
                notation=notation,
                sort_order=sort_order,
            )
        )
        created += 1
    return created


def apply_dance_level_preset(session: Session, schedule_id: int) -> int:
    created = seed_dance_level_preset(session, schedule_id)
    session.commit()
    return created


def latest_publication(
    session: Session, schedule_id: int
) -> SchedulePublication | None:
    return session.exec(
        select(SchedulePublication)
        .where(SchedulePublication.schedule_id == schedule_id)
        .order_by(SchedulePublication.version.desc())
    ).first()


def published_schedule_event_ids(session: Session, event_ids: list[str]) -> set[str]:
    if not event_ids:
        return set()
    return set(
        session.exec(
            select(EventSchedule.event_id)
            .join(
                SchedulePublication,
                SchedulePublication.schedule_id == EventSchedule.id,
            )
            .where(EventSchedule.event_id.in_(event_ids))
            .distinct()
        ).all()
    )


def session_snapshot(row: ScheduleSession) -> dict:
    return {
        "id": str(row.id),
        "external_id": row.external_id,
        "title": row.title,
        "instructors": row.instructors,
        "start": utc_isoformat(row.start),
        "end": utc_isoformat(row.end),
        "room_id": row.room_id,
        "venue_id": row.venue_id,
        "level_id": row.level_id,
        "activity_type_id": row.activity_type_id,
        "attendee_note": row.attendee_note,
        "allow_plan": row.allow_plan,
        "is_cancelled": row.is_cancelled,
    }


def build_snapshot(session: Session, schedule: EventSchedule) -> dict:
    schedule_id = schedule.id
    venues = session.exec(
        select(ScheduleVenue)
        .where(ScheduleVenue.schedule_id == schedule_id)
        .order_by(ScheduleVenue.sort_order, ScheduleVenue.id)
    ).all()
    rooms = session.exec(
        select(ScheduleRoom)
        .where(ScheduleRoom.schedule_id == schedule_id)
        .order_by(ScheduleRoom.sort_order, ScheduleRoom.id)
    ).all()
    levels = session.exec(
        select(ScheduleLevel)
        .where(ScheduleLevel.schedule_id == schedule_id)
        .order_by(ScheduleLevel.sort_order, ScheduleLevel.id)
    ).all()
    activity_types = session.exec(
        select(ScheduleActivityType)
        .where(ScheduleActivityType.schedule_id == schedule_id)
        .order_by(ScheduleActivityType.sort_order, ScheduleActivityType.id)
    ).all()
    sessions = session.exec(
        select(ScheduleSession)
        .where(
            ScheduleSession.schedule_id == schedule_id,
            ScheduleSession.deleted_at.is_(None),
        )
        .order_by(ScheduleSession.start, ScheduleSession.title)
    ).all()
    return {
        "event_id": schedule.event_id,
        "timezone": schedule.timezone,
        "day_start_hour": schedule.day_start_hour,
        "days": schedule.days,
        "venues": [
            {
                "id": row.id,
                "external_id": row.external_id,
                "name": row.name,
                "address": row.address,
                "sort_order": row.sort_order,
            }
            for row in venues
        ],
        "rooms": [
            {
                "id": row.id,
                "external_id": row.external_id,
                "venue_id": row.venue_id,
                "name": row.name,
                "color": row.color,
                "sort_order": row.sort_order,
            }
            for row in rooms
        ],
        "levels": [
            {
                "id": row.id,
                "external_id": row.external_id,
                "label": row.label,
                "notation": row.notation,
                "sort_order": row.sort_order,
            }
            for row in levels
        ],
        "activity_types": [
            {
                "id": row.id,
                "external_id": row.external_id,
                "name": row.name,
                "color": row.color,
                "sort_order": row.sort_order,
            }
            for row in activity_types
        ],
        "sessions": [session_snapshot(row) for row in sessions],
    }


def compute_issues(session: Session, schedule: EventSchedule) -> list[dict]:
    sessions = session.exec(
        select(ScheduleSession).where(
            ScheduleSession.schedule_id == schedule.id,
            ScheduleSession.deleted_at.is_(None),
        )
    ).all()
    issues: list[dict] = []
    allowed_days = set(schedule.days)
    seen: dict[tuple[str, datetime, int | None], ScheduleSession] = {}
    for row in sessions:
        if row.end <= row.start:
            issues.append(
                _issue(
                    "invalid_time",
                    "error",
                    f"{row.title} ends before it starts",
                    row.id,
                )
            )
        if (
            allowed_days
            and program_day_for(
                row.start, schedule.timezone, schedule.day_start_hour
            ).isoformat()
            not in allowed_days
        ):
            issues.append(
                _issue(
                    "outside_schedule_days",
                    "warning",
                    f"{row.title} is outside the configured days",
                    row.id,
                )
            )
        if row.room_id is None and row.venue_id is None:
            issues.append(
                _issue(
                    "missing_location",
                    "warning",
                    f"{row.title} has no room or venue",
                    row.id,
                )
            )
        key = (row.title.casefold(), row.start, row.room_id)
        duplicate = seen.get(key)
        if duplicate is not None:
            issues.append(
                {
                    "code": "possible_duplicate",
                    "severity": "warning",
                    "message": f"{row.title} appears more than once at the same time",
                    "session_ids": [str(duplicate.id), str(row.id)],
                }
            )
        seen[key] = row
    by_room: dict[int, list[ScheduleSession]] = {}
    for row in sessions:
        if row.room_id is not None:
            by_room.setdefault(row.room_id, []).append(row)
    for room_sessions in by_room.values():
        room_sessions.sort(key=lambda item: item.start)
        for index, left in enumerate(room_sessions):
            for right in room_sessions[index + 1 :]:
                if right.start >= left.end:
                    break
                issues.append(
                    {
                        "code": "room_overlap",
                        "severity": "warning",
                        "message": f"{left.title} overlaps {right.title} in the same room",
                        "session_ids": [str(left.id), str(right.id)],
                    }
                )
    return issues


def _issue(code: str, severity: str, message: str, session_id) -> dict:
    return {
        "code": code,
        "severity": severity,
        "message": message,
        "session_ids": [str(session_id)],
    }


def compute_diff(draft: dict, published: dict | None) -> dict:
    if published is None:
        return {
            "added_session_ids": [row["id"] for row in draft["sessions"]],
            "removed_session_ids": [],
            "changed_sessions": {},
            "configuration_changed": bool(
                draft["venues"]
                or draft["rooms"]
                or draft["levels"]
                or draft["activity_types"]
            ),
        }
    draft_sessions = {row["id"]: row for row in draft["sessions"]}
    published_sessions = {row["id"]: row for row in published.get("sessions", [])}
    shared_ids = draft_sessions.keys() & published_sessions.keys()
    changed = {
        session_id: [
            key
            for key in draft_sessions[session_id]
            if draft_sessions[session_id].get(key)
            != published_sessions[session_id].get(key)
        ]
        for session_id in shared_ids
    }
    changed = {key: fields for key, fields in changed.items() if fields}
    config_keys = (
        "timezone",
        "day_start_hour",
        "days",
        "venues",
        "rooms",
        "levels",
        "activity_types",
    )
    return {
        "added_session_ids": sorted(draft_sessions.keys() - published_sessions.keys()),
        "removed_session_ids": sorted(
            published_sessions.keys() - draft_sessions.keys()
        ),
        "changed_sessions": changed,
        "configuration_changed": any(
            draft.get(key) != published.get(key) for key in config_keys
        ),
    }
