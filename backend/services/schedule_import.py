from datetime import datetime, timezone
from hashlib import sha1
from types import SimpleNamespace
from zoneinfo import ZoneInfo

from sqlmodel import Session, select

from backend.api.schemas import ScheduleImportDocument
from backend.db.models import (
    EventSchedule,
    ScheduleActivityType,
    ScheduleContributor,
    ScheduleLevel,
    ScheduleRoom,
    ScheduleSession,
    ScheduleSessionContributor,
    ScheduleVenue,
)
from backend.services.schedules import build_snapshot, utc_isoformat, validate_timezone


def _external_id(row, prefix: str) -> str:
    return row.external_id or f"{prefix}-{row.id}"


def build_schedule_import_example(schedule: EventSchedule) -> dict:
    day = schedule.days[0]
    return {
        "schema_version": 2,
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
        "contributors": [
            {
                "external_id": "sample-alex",
                "display_name": "Alex",
                "sort_order": 0,
            },
            {
                "external_id": "sample-sam",
                "display_name": "Sam",
                "sort_order": 1,
            },
        ],
        "sessions": [
            {
                "external_id": "sample-welcome-class",
                "title": "Sample Welcome Class",
                "contributors": [
                    {
                        "contributor_external_id": "sample-alex",
                        "role": "instructor",
                    },
                    {
                        "contributor_external_id": "sample-sam",
                        "role": "instructor",
                    },
                ],
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
    contributors = session.exec(
        select(ScheduleContributor)
        .where(ScheduleContributor.schedule_id == schedule.id)
        .order_by(ScheduleContributor.sort_order, ScheduleContributor.id)
    ).all()
    sessions = session.exec(
        select(ScheduleSession)
        .where(
            ScheduleSession.schedule_id == schedule.id,
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
            ScheduleSession.schedule_id == schedule.id,
            ScheduleSession.deleted_at.is_(None),
        )
        .order_by(
            ScheduleSessionContributor.session_id,
            ScheduleSessionContributor.position,
        )
    ).all()
    venue_refs = {row.id: _external_id(row, "venue") for row in venues}
    room_refs = {row.id: _external_id(row, "room") for row in rooms}
    level_refs = {row.id: _external_id(row, "level") for row in levels}
    type_refs = {row.id: _external_id(row, "activity") for row in activity_types}
    contributor_refs = {
        row.id: _external_id(row, "contributor") for row in contributors
    }
    assignments_by_session: dict = {}
    for assignment in assignments:
        assignments_by_session.setdefault(assignment.session_id, []).append(assignment)
    zone = ZoneInfo(schedule.timezone)

    def local_iso(value: datetime) -> str:
        aware = value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value
        return aware.astimezone(zone).replace(tzinfo=None).isoformat(timespec="minutes")

    return {
        "schema_version": 2,
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
        "contributors": [
            {
                "external_id": contributor_refs[row.id],
                "display_name": row.display_name,
                "sort_order": row.sort_order,
            }
            for row in contributors
        ],
        "sessions": [
            {
                "external_id": _external_id(row, "session"),
                "title": row.title,
                "instructors": row.instructors,
                "contributors": [
                    {
                        "contributor_external_id": contributor_refs[
                            assignment.contributor_id
                        ],
                        "role": assignment.role,
                    }
                    for assignment in assignments_by_session.get(row.id, [])
                ],
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


def _to_utc(value: datetime, zone: ZoneInfo) -> datetime:
    aware = value.replace(tzinfo=zone) if value.tzinfo is None else value
    return aware.astimezone(timezone.utc)


def _upsert_named(
    session, model, schedule_id: int, rows, values, identity_field: str | None = None
):
    existing_rows = session.exec(
        select(model).where(model.schedule_id == schedule_id)
    ).all()
    existing = {row.external_id: row for row in existing_rows if row.external_id}
    identity_field = identity_field or ("label" if model is ScheduleLevel else "name")
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
    schedule.updated_at = datetime.now(timezone.utc)
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
    contributor_items = list(document.contributors)
    legacy_contributor_refs: dict[str, str] = {}
    if document.schema_version == 1:
        for display_name in sorted(
            {
                row.instructors.strip()
                for row in document.sessions
                if row.instructors and row.instructors.strip()
            },
            key=str.casefold,
        ):
            external_id = f"legacy-{sha1(f'{schedule.id}:{display_name}'.encode()).hexdigest()[:20]}"
            legacy_contributor_refs[display_name] = external_id
            contributor_items.append(
                SimpleNamespace(
                    external_id=external_id,
                    display_name=display_name,
                    sort_order=len(contributor_items),
                )
            )
    contributors, cc, cu, cn = _upsert_named(
        session,
        ScheduleContributor,
        schedule.id,
        contributor_items,
        lambda row: {
            "display_name": row.display_name,
            "sort_order": row.sort_order,
        },
        identity_field="display_name",
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
    existing_assignments = session.exec(
        select(ScheduleSessionContributor)
        .join(
            ScheduleSession,
            ScheduleSession.id == ScheduleSessionContributor.session_id,
        )
        .where(ScheduleSession.schedule_id == schedule.id)
        .order_by(
            ScheduleSessionContributor.session_id,
            ScheduleSessionContributor.position,
        )
    ).all()
    assignments_by_session: dict = {}
    for assignment in existing_assignments:
        assignments_by_session.setdefault(assignment.session_id, []).append(assignment)
    created = vc + rc + lc + ac + cc
    updated = vu + ru + lu + au + cu
    unchanged = vn + rn + ln + an + cn
    imported_ids = set()
    for item in document.sessions:
        imported_ids.add(item.external_id)
        start = _to_utc(item.start, zone)
        end = _to_utc(item.end, zone)
        if end <= start:
            raise ValueError(f"{item.title}: end must be after start")
        imported_assignments = (
            [
                (
                    contributors[assignment.contributor_external_id].id,
                    assignment.role,
                )
                for assignment in (item.contributors or [])
            ]
            if document.schema_version == 2
            else (
                [
                    (
                        contributors[
                            legacy_contributor_refs[item.instructors.strip()]
                        ].id,
                        "instructor",
                    )
                ]
                if item.instructors and item.instructors.strip()
                else []
            )
        )
        values = {
            "title": item.title,
            "instructors": (
                " & ".join(
                    contributors[assignment.contributor_external_id].display_name
                    for assignment in (item.contributors or [])
                    if assignment.role == "instructor"
                )
                or None
                if document.schema_version == 2
                else item.instructors
            ),
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
            row = ScheduleSession(
                schedule_id=schedule.id,
                external_id=item.external_id,
                **values,
            )
            session.add(row)
            session.flush()
            created += 1
        else:
            current_assignments = [
                (assignment.contributor_id, assignment.role)
                for assignment in assignments_by_session.get(row.id, [])
            ]
            changed = (
                row.external_id != item.external_id
                or any(getattr(row, key) != value for key, value in values.items())
                or (
                    imported_assignments is not None
                    and current_assignments != imported_assignments
                )
            )
            row.external_id = item.external_id
            for key, value in values.items():
                setattr(row, key, value)
            row.updated_at = datetime.now(timezone.utc)
            session.add(row)
            updated += int(changed)
            unchanged += int(not changed)
        if imported_assignments is not None:
            for assignment in assignments_by_session.get(row.id, []):
                session.delete(assignment)
            session.flush()
            for position, (contributor_id, role) in enumerate(imported_assignments):
                session.add(
                    ScheduleSessionContributor(
                        session_id=row.id,
                        contributor_id=contributor_id,
                        role=role,
                        position=position,
                    )
                )

    removed = 0
    if mode == "replace":
        for external_id, row in existing_sessions.items():
            if external_id not in imported_ids and row.deleted_at is None:
                row.deleted_at = datetime.now(timezone.utc)
                session.add(row)
                removed += 1
    session.flush()
    if mode == "replace" and document.schema_version == 2:
        imported_contributor_ids = {row.external_id for row in document.contributors}
        referenced_contributor_ids = set(
            session.exec(select(ScheduleSessionContributor.contributor_id)).all()
        )
        for external_id, contributor in {
            row.external_id: row
            for row in session.exec(
                select(ScheduleContributor).where(
                    ScheduleContributor.schedule_id == schedule.id
                )
            ).all()
        }.items():
            if (
                external_id not in imported_contributor_ids
                and contributor.id not in referenced_contributor_ids
            ):
                session.delete(contributor)
                removed += 1
        session.flush()
    return {
        "created": created,
        "updated": updated,
        "removed": removed,
        "unchanged": unchanged,
        "snapshot": build_snapshot(session, schedule),
    }
