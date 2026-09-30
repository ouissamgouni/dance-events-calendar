from datetime import date, datetime, timedelta, timezone
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlmodel import Session, col, select

from backend.db.models import (
    CachedEvent,
    EventSchedule,
    ScheduleActivityType,
    ScheduleContributor,
    ScheduleLevel,
    SchedulePublication,
    ScheduleRoom,
    ScheduleSession,
    ScheduleSessionContributor,
    ScheduleVenue,
    User,
    UserFollow,
    UserPlanAudience,
    UserPlanSession,
)
from backend.services.user_avatars import resolve_user_avatar


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

DEFAULT_DANCE_LEVELS = (
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


def to_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


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


def seed_default_dance_levels(session: Session, schedule_id: int) -> None:
    for sort_order, (external_id, label, notation) in enumerate(DEFAULT_DANCE_LEVELS):
        session.add(
            ScheduleLevel(
                schedule_id=schedule_id,
                external_id=external_id,
                label=label,
                notation=notation,
                sort_order=sort_order,
            )
        )


def latest_publication(
    session: Session, schedule_id: int
) -> SchedulePublication | None:
    return session.exec(
        select(SchedulePublication)
        .where(SchedulePublication.schedule_id == schedule_id)
        .order_by(SchedulePublication.version.desc())
    ).first()


def plan_entries(
    session: Session,
    user_id,
    event_id: str,
    publication: SchedulePublication | None,
) -> list[dict]:
    current = {
        row["id"]: row
        for row in (publication.snapshot.get("sessions", []) if publication else [])
    }
    rows = session.exec(
        select(UserPlanSession)
        .where(
            UserPlanSession.user_id == user_id,
            UserPlanSession.event_id == event_id,
        )
        .order_by(UserPlanSession.added_at)
    ).all()
    entries = []
    for row in rows:
        item = current.get(str(row.session_id))
        item_status = "removed"
        if item is not None:
            item_status = "cancelled" if item.get("is_cancelled") else "active"
        entries.append(
            {
                "session_id": row.session_id,
                "status": item_status,
                "session": item or row.last_known_session,
            }
        )
    return entries


def plan_counts(
    session: Session,
    user_id,
    event_ids: list[str],
) -> dict[str, int]:
    unique_event_ids = list(dict.fromkeys(event_ids))
    counts = {event_id: 0 for event_id in unique_event_ids}
    if not unique_event_ids:
        return counts

    schedules = session.exec(
        select(EventSchedule).where(EventSchedule.event_id.in_(unique_event_ids))
    ).all()
    if not schedules:
        return counts

    schedule_ids = [schedule.id for schedule in schedules if schedule.id is not None]
    publications = session.exec(
        select(SchedulePublication)
        .where(SchedulePublication.schedule_id.in_(schedule_ids))
        .order_by(
            SchedulePublication.schedule_id,
            SchedulePublication.version.desc(),
        )
    ).all()
    latest_by_schedule: dict[int, SchedulePublication] = {}
    for publication in publications:
        latest_by_schedule.setdefault(publication.schedule_id, publication)

    current_session_ids_by_event: dict[str, set[str]] = {}
    for schedule in schedules:
        if schedule.id is None:
            continue
        publication = latest_by_schedule.get(schedule.id)
        if publication is None:
            continue
        current_session_ids_by_event[schedule.event_id] = {
            str(item["id"]) for item in publication.snapshot.get("sessions", [])
        }

    rows = session.exec(
        select(UserPlanSession).where(
            UserPlanSession.user_id == user_id,
            UserPlanSession.event_id.in_(unique_event_ids),
        )
    ).all()
    for row in rows:
        if str(row.session_id) in current_session_ids_by_event.get(row.event_id, set()):
            counts[row.event_id] += 1
    return counts


def session_attendance_projection(
    session: Session,
    viewer: User,
    event_id: str,
    publication: SchedulePublication,
) -> dict[str, list[dict]]:
    current_session_ids = {
        UUID(row["id"])
        for row in publication.snapshot.get("sessions", [])
        if not row.get("is_cancelled", False)
    }
    if not current_session_ids:
        return {}

    plan_rows = session.exec(
        select(UserPlanSession)
        .where(
            UserPlanSession.event_id == event_id,
            col(UserPlanSession.session_id).in_(current_session_ids),
        )
        .order_by(UserPlanSession.added_at)
    ).all()
    owner_ids = {row.user_id for row in plan_rows}
    if not owner_ids:
        return {}

    users = session.exec(
        select(User).where(
            col(User.id).in_(owner_ids),
            User.deleted_at.is_(None),  # type: ignore[union-attr]
        )
    ).all()
    users_by_id = {user.id: user for user in users}
    audiences = dict(
        session.exec(
            select(UserPlanAudience.user_id, UserPlanAudience.audience).where(
                UserPlanAudience.event_id == event_id,
                col(UserPlanAudience.user_id).in_(owner_ids),
            )
        ).all()
    )
    outbound_ids = set(
        session.exec(
            select(UserFollow.followee_id).where(
                UserFollow.follower_id == viewer.id,
                UserFollow.status == "approved",
                col(UserFollow.followee_id).in_(owner_ids),
            )
        ).all()
    )
    inbound_ids = set(
        session.exec(
            select(UserFollow.follower_id).where(
                UserFollow.followee_id == viewer.id,
                UserFollow.status == "approved",
                col(UserFollow.follower_id).in_(owner_ids),
            )
        ).all()
    )

    projected: dict[str, list[tuple[int, datetime, dict]]] = {}
    for row in plan_rows:
        owner = users_by_id.get(row.user_id)
        if owner is None:
            continue
        is_self = owner.id == viewer.id
        is_follower = owner.id in outbound_ids
        is_friend = is_follower and owner.id in inbound_ids
        account_passes = owner.account_visibility == "public" or is_friend
        audience = audiences.get(owner.id, "private")
        audience_passes = (
            is_self
            or (audience == "followers" and is_follower)
            or (audience == "friends" and is_friend)
        )
        if not is_self and (not account_passes or not audience_passes):
            continue
        attendee = {
            "user_id": owner.id,
            "display_name": owner.display_name,
            "avatar_url": resolve_user_avatar(owner),
            "handle": owner.handle,
        }
        rank = 0 if is_self else 1 if is_friend else 2
        projected.setdefault(str(row.session_id), []).append(
            (rank, row.added_at, attendee)
        )

    return {
        session_id: [
            item[2]
            for item in sorted(
                items, key=lambda item: (item[0], item[1], str(item[2]["user_id"]))
            )
        ]
        for session_id, items in projected.items()
    }


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


def session_snapshot(
    row: ScheduleSession, contributors: list[ScheduleSessionContributor] | None = None
) -> dict:
    return {
        "id": str(row.id),
        "external_id": row.external_id,
        "title": row.title,
        "instructors": row.instructors,
        "contributors": [
            {
                "contributor_id": assignment.contributor_id,
                "role": assignment.role,
                "position": assignment.position,
            }
            for assignment in (contributors or [])
        ],
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
    contributors = session.exec(
        select(ScheduleContributor)
        .where(ScheduleContributor.schedule_id == schedule_id)
        .order_by(ScheduleContributor.sort_order, ScheduleContributor.id)
    ).all()
    sessions = session.exec(
        select(ScheduleSession)
        .where(
            ScheduleSession.schedule_id == schedule_id,
            ScheduleSession.deleted_at.is_(None),
        )
        .order_by(ScheduleSession.start, ScheduleSession.title)
    ).all()
    assignments = session.exec(
        select(ScheduleSessionContributor)
        .join(
            ScheduleSession,
            ScheduleSession.id == ScheduleSessionContributor.session_id,
        )
        .where(
            ScheduleSession.schedule_id == schedule_id,
            ScheduleSession.deleted_at.is_(None),
        )
        .order_by(
            ScheduleSessionContributor.session_id,
            ScheduleSessionContributor.position,
        )
    ).all()
    assignments_by_session: dict[UUID, list[ScheduleSessionContributor]] = {}
    for assignment in assignments:
        assignments_by_session.setdefault(assignment.session_id, []).append(assignment)
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
        "contributors": [
            {
                "id": row.id,
                "external_id": row.external_id,
                "display_name": row.display_name,
                "sort_order": row.sort_order,
            }
            for row in contributors
        ],
        "sessions": [
            session_snapshot(row, assignments_by_session.get(row.id, []))
            for row in sessions
        ],
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
                or draft["contributors"]
            ),
            "changes": compute_change_details(draft, None),
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
        "contributors",
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
        "changes": compute_change_details(draft, published),
    }


def compute_change_details(current: dict, previous: dict | None) -> list[dict]:
    previous = previous or {
        "timezone": None,
        "day_start_hour": None,
        "days": [],
        "venues": [],
        "rooms": [],
        "levels": [],
        "activity_types": [],
        "contributors": [],
        "sessions": [],
    }
    changes: list[dict] = []
    current_contributors = {
        row["id"]: row["display_name"] for row in current.get("contributors", [])
    }
    previous_contributors = {
        row["id"]: row["display_name"] for row in previous.get("contributors", [])
    }

    def display_value(field: str, value, contributor_names: dict) -> object:
        if field != "contributors" or not isinstance(value, list):
            return value
        return ", ".join(
            f"{contributor_names.get(row.get('contributor_id'), 'Unknown contributor')} ({row.get('role', 'other')})"
            for row in value
        )

    setting_fields = ("timezone", "day_start_hour", "days")
    changed_settings = [
        {
            "field": field,
            "before": previous.get(field),
            "after": current.get(field),
        }
        for field in setting_fields
        if previous.get(field) != current.get(field)
    ]
    if changed_settings:
        changes.append(
            {
                "entity_type": "schedule",
                "operation": "update",
                "entity_id": "schedule",
                "label": "Schedule settings",
                "fields": changed_settings,
            }
        )

    collections = (
        ("venues", "venue", "name"),
        ("rooms", "room", "name"),
        ("levels", "level", "label"),
        ("activity_types", "activity_type", "name"),
        ("contributors", "contributor", "display_name"),
        ("sessions", "session", "title"),
    )
    for key, entity_type, label_field in collections:
        current_rows = {str(row["id"]): row for row in current.get(key, [])}
        previous_rows = {str(row["id"]): row for row in previous.get(key, [])}
        for entity_id in sorted(current_rows.keys() - previous_rows.keys()):
            row = current_rows[entity_id]
            changes.append(
                {
                    "entity_type": entity_type,
                    "operation": "create",
                    "entity_id": entity_id,
                    "label": row[label_field],
                    "fields": [],
                }
            )
        for entity_id in sorted(previous_rows.keys() - current_rows.keys()):
            row = previous_rows[entity_id]
            changes.append(
                {
                    "entity_type": entity_type,
                    "operation": "remove",
                    "entity_id": entity_id,
                    "label": row[label_field],
                    "fields": [],
                }
            )
        for entity_id in sorted(current_rows.keys() & previous_rows.keys()):
            current_row = current_rows[entity_id]
            previous_row = previous_rows[entity_id]
            fields = [
                {
                    "field": field,
                    "before": display_value(
                        field, previous_row.get(field), previous_contributors
                    ),
                    "after": display_value(
                        field, current_row.get(field), current_contributors
                    ),
                }
                for field in current_row
                if field != "id"
                and not (field == "external_id" and previous_row.get(field) is None)
                and previous_row.get(field) != current_row.get(field)
            ]
            if fields:
                changes.append(
                    {
                        "entity_type": entity_type,
                        "operation": "update",
                        "entity_id": entity_id,
                        "label": current_row[label_field],
                        "fields": fields,
                    }
                )
    return changes
