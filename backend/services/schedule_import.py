from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from sqlmodel import Session, select

from backend.api.schemas import ScheduleImportDocument
from backend.db.models import (
    EventSchedule,
    ScheduleActivityType,
    ScheduleLevel,
    ScheduleRoom,
    ScheduleSession,
    ScheduleVenue,
)
from backend.services.schedules import build_snapshot, utc_isoformat, validate_timezone


def _external_id(row, prefix: str) -> str:
    return row.external_id or f"{prefix}-{row.id}"


def build_schedule_import_example(schedule: EventSchedule) -> dict:
    day = schedule.days[0]
    return {
        "schema_version": 1,
        "event_id": schedule.event_id,
        "timezone": schedule.timezone,
        "day_start_hour": schedule.day_start_hour,
        "days": [day],
        "venues": [
            {
                "external_id": "sample-main-venue",
                "name": "Sample Main Venue",
                "address": "123 Dance Street",
                "sort_order": 0,
            }
        ],
        "rooms": [
            {
                "external_id": "sample-grand-room",
                "name": "Sample Grand Room",
                "venue_external_id": "sample-main-venue",
                "color": "blue",
                "sort_order": 0,
            }
        ],
        "levels": [
            {
                "external_id": "sample-open-level",
                "label": "Open Level",
                "notation": "*",
                "sort_order": 0,
            }
        ],
        "activity_types": [
            {
                "external_id": "sample-workshop",
                "name": "Sample Workshop",
                "color": "violet",
                "sort_order": 0,
            }
        ],
        "sessions": [
            {
                "external_id": "sample-welcome-class",
                "title": "Sample Welcome Class",
                "instructors": "Alex & Sam",
                "start": f"{day}T10:00:00",
                "end": f"{day}T11:00:00",
                "room_external_id": "sample-grand-room",
                "venue_external_id": "sample-main-venue",
                "level_external_id": "sample-open-level",
                "activity_type_external_id": "sample-workshop",
                "attendee_note": "Arrive 10 minutes early.",
                "allow_plan": True,
                "is_cancelled": False,
            }
        ],
    }


def export_schedule_document(session: Session, schedule: EventSchedule) -> dict:
    venues = session.exec(
        select(ScheduleVenue)
        .where(ScheduleVenue.schedule_id == schedule.id)
        .order_by(ScheduleVenue.sort_order, ScheduleVenue.id)
    ).all()
    rooms = session.exec(
        select(ScheduleRoom)
        .where(ScheduleRoom.schedule_id == schedule.id)
        .order_by(ScheduleRoom.sort_order, ScheduleRoom.id)
    ).all()
    levels = session.exec(
        select(ScheduleLevel)
        .where(ScheduleLevel.schedule_id == schedule.id)
        .order_by(ScheduleLevel.sort_order, ScheduleLevel.id)
    ).all()
    activity_types = session.exec(
        select(ScheduleActivityType)
        .where(ScheduleActivityType.schedule_id == schedule.id)
        .order_by(ScheduleActivityType.sort_order, ScheduleActivityType.id)
    ).all()
    sessions = session.exec(
        select(ScheduleSession)
        .where(
            ScheduleSession.schedule_id == schedule.id,
            ScheduleSession.deleted_at.is_(None),
        )
        .order_by(ScheduleSession.start, ScheduleSession.title)
    ).all()
    venue_refs = {row.id: _external_id(row, "venue") for row in venues}
    room_refs = {row.id: _external_id(row, "room") for row in rooms}
    level_refs = {row.id: _external_id(row, "level") for row in levels}
    type_refs = {row.id: _external_id(row, "activity") for row in activity_types}
    zone = ZoneInfo(schedule.timezone)

    def local_iso(value: datetime) -> str:
        aware = value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value
        return aware.astimezone(zone).replace(tzinfo=None).isoformat(timespec="minutes")

    return {
        "schema_version": 1,
        "event_id": schedule.event_id,
        "timezone": schedule.timezone,
        "day_start_hour": schedule.day_start_hour,
        "days": schedule.days,
        "venues": [
            {
                "external_id": venue_refs[row.id],
                "name": row.name,
                "address": row.address,
                "sort_order": row.sort_order,
            }
            for row in venues
        ],
        "rooms": [
            {
                "external_id": room_refs[row.id],
                "name": row.name,
                "venue_external_id": venue_refs.get(row.venue_id),
                "color": row.color,
                "sort_order": row.sort_order,
            }
            for row in rooms
        ],
        "levels": [
            {
                "external_id": level_refs[row.id],
                "label": row.label,
                "notation": row.notation,
                "sort_order": row.sort_order,
            }
            for row in levels
        ],
        "activity_types": [
            {
                "external_id": type_refs[row.id],
                "name": row.name,
                "color": row.color,
                "sort_order": row.sort_order,
            }
            for row in activity_types
        ],
        "sessions": [
            {
                "external_id": _external_id(row, "session"),
                "title": row.title,
                "instructors": row.instructors,
                "start": local_iso(row.start),
                "end": local_iso(row.end),
                "room_external_id": room_refs.get(row.room_id),
                "venue_external_id": venue_refs.get(row.venue_id),
                "level_external_id": level_refs.get(row.level_id),
                "activity_type_external_id": type_refs.get(row.activity_type_id),
                "attendee_note": row.attendee_note,
                "allow_plan": row.allow_plan,
                "is_cancelled": row.is_cancelled,
            }
            for row in sessions
        ],
    }


def _utc_naive(value: datetime, zone: ZoneInfo) -> datetime:
    aware = value.replace(tzinfo=zone) if value.tzinfo is None else value
    return aware.astimezone(timezone.utc).replace(tzinfo=None)


def _upsert_named(session, model, schedule_id: int, rows, values):
    existing_rows = session.exec(
        select(model).where(model.schedule_id == schedule_id)
    ).all()
    existing = {row.external_id: row for row in existing_rows if row.external_id}
    identity_field = "label" if model is ScheduleLevel else "name"
    existing_by_identity = {
        getattr(row, identity_field).casefold(): row for row in existing_rows
    }
    result = {}
    created = updated = unchanged = 0
    for item in rows:
        row = existing.get(item.external_id)
        data = values(item)
        if row is None:
            row = existing_by_identity.get(data[identity_field].casefold())
        if row is None:
            row = model(schedule_id=schedule_id, external_id=item.external_id, **data)
            session.add(row)
            created += 1
        else:
            row.external_id = item.external_id
            changed = any(getattr(row, key) != value for key, value in data.items())
            for key, value in data.items():
                setattr(row, key, value)
            session.add(row)
            updated += int(changed)
            unchanged += int(not changed)
        session.flush()
        result[item.external_id] = row
    return result, created, updated, unchanged


def apply_import_document(
    session: Session,
    schedule: EventSchedule,
    document: ScheduleImportDocument,
    mode: str,
) -> dict:
    if document.event_id and document.event_id != schedule.event_id:
        raise ValueError("Document event_id does not match this event")
    validate_timezone(document.timezone)
    schedule.timezone = document.timezone
    schedule.day_start_hour = document.day_start_hour
    schedule.days = [day.isoformat() for day in document.days]
    schedule.updated_at = datetime.utcnow()
    session.add(schedule)

    venues, vc, vu, vn = _upsert_named(
        session,
        ScheduleVenue,
        schedule.id,
        document.venues,
        lambda row: {
            "name": row.name,
            "address": row.address,
            "sort_order": row.sort_order,
        },
    )
    missing_venues = {
        row.venue_external_id
        for row in document.rooms
        if row.venue_external_id and row.venue_external_id not in venues
    }
    if missing_venues:
        raise ValueError(f"Unknown venue external_id: {sorted(missing_venues)[0]}")
    rooms, rc, ru, rn = _upsert_named(
        session,
        ScheduleRoom,
        schedule.id,
        document.rooms,
        lambda row: {
            "name": row.name,
            "venue_id": venues[row.venue_external_id].id
            if row.venue_external_id
            else None,
            "color": row.color,
            "sort_order": row.sort_order,
        },
    )
    levels, lc, lu, ln = _upsert_named(
        session,
        ScheduleLevel,
        schedule.id,
        document.levels,
        lambda row: {
            "label": row.label,
            "notation": row.notation,
            "sort_order": row.sort_order,
        },
    )
    activity_types, ac, au, an = _upsert_named(
        session,
        ScheduleActivityType,
        schedule.id,
        document.activity_types,
        lambda row: {
            "name": row.name,
            "color": row.color,
            "sort_order": row.sort_order,
        },
    )
    reference_sets = (
        (
            "room",
            {row.room_external_id for row in document.sessions if row.room_external_id},
            rooms,
        ),
        (
            "venue",
            {
                row.venue_external_id
                for row in document.sessions
                if row.venue_external_id
            },
            venues,
        ),
        (
            "level",
            {
                row.level_external_id
                for row in document.sessions
                if row.level_external_id
            },
            levels,
        ),
        (
            "activity type",
            {
                row.activity_type_external_id
                for row in document.sessions
                if row.activity_type_external_id
            },
            activity_types,
        ),
    )
    for label, refs, values in reference_sets:
        missing = refs - values.keys()
        if missing:
            raise ValueError(f"Unknown {label} external_id: {sorted(missing)[0]}")

    existing_session_rows = session.exec(
        select(ScheduleSession).where(ScheduleSession.schedule_id == schedule.id)
    ).all()
    existing_sessions = {
        row.external_id or f"session-{row.id}": row for row in existing_session_rows
    }
    zone = ZoneInfo(document.timezone)
    created = vc + rc + lc + ac
    updated = vu + ru + lu + au
    unchanged = vn + rn + ln + an
    imported_ids = set()
    for item in document.sessions:
        imported_ids.add(item.external_id)
        start = _utc_naive(item.start, zone)
        end = _utc_naive(item.end, zone)
        if end <= start:
            raise ValueError(f"{item.title}: end must be after start")
        values = {
            "title": item.title,
            "instructors": item.instructors,
            "start": start,
            "end": end,
            "room_id": rooms[item.room_external_id].id
            if item.room_external_id
            else None,
            "venue_id": venues[item.venue_external_id].id
            if item.venue_external_id
            else None,
            "level_id": levels[item.level_external_id].id
            if item.level_external_id
            else None,
            "activity_type_id": activity_types[item.activity_type_external_id].id
            if item.activity_type_external_id
            else None,
            "attendee_note": item.attendee_note,
            "allow_plan": item.allow_plan,
            "is_cancelled": item.is_cancelled,
            "deleted_at": None,
        }
        row = existing_sessions.get(item.external_id)
        if row is None:
            session.add(
                ScheduleSession(
                    schedule_id=schedule.id,
                    external_id=item.external_id,
                    **values,
                )
            )
            created += 1
        else:
            changed = row.external_id != item.external_id or any(
                getattr(row, key) != value for key, value in values.items()
            )
            row.external_id = item.external_id
            for key, value in values.items():
                setattr(row, key, value)
            row.updated_at = datetime.utcnow()
            session.add(row)
            updated += int(changed)
            unchanged += int(not changed)

    removed = 0
    if mode == "replace":
        for external_id, row in existing_sessions.items():
            if external_id not in imported_ids and row.deleted_at is None:
                row.deleted_at = datetime.utcnow()
                session.add(row)
                removed += 1
    session.flush()
    return {
        "created": created,
        "updated": updated,
        "removed": removed,
        "unchanged": unchanged,
        "snapshot": build_snapshot(session, schedule),
    }
