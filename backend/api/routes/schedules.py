from datetime import datetime, timezone
import re
import logging
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from slowapi import Limiter
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from backend.api.rate_limit import client_ip
from backend.services import job_queue
from backend.api.deps import (
    get_current_user_optional,
    is_admin_user,
    require_admin,
    require_flag,
    require_user,
)
from backend.api.schemas import (
    AdminEventScheduleResponse,
    EventScheduleCreateRequest,
    EventScheduleEditorAccessResponse,
    EventScheduleEditorCreateRequest,
    EventScheduleEditorResponse,
    EventScheduleResponse,
    EventScheduleUpdateRequest,
    MyPlanCountBatchRequest,
    MyPlanCountResponse,
    MyPlanEntryResponse,
    MyPlanResponse,
    MyPlanShareResponse,
    OverviewItemAttendanceSummaryResponse,
    UpdateMyPlanAudienceRequest,
    ProgramExportResponse,
    ScheduleActivityTypeRequest,
    ScheduleActivityTypeResponse,
    ScheduleContributorRequest,
    ScheduleContributorResponse,
    ScheduleChangeRef,
    ScheduleImportDocument,
    ScheduleImportPreviewResponse,
    ScheduleImportRequest,
    ScheduleProgramCandidate,
    ScheduleProgramNotifyRequest,
    ScheduleProgramNotifyResponse,
    ScheduleProgramNotifyResult,
    SchedulePlannerResponse,
    SchedulePublishPreviewResponse,
    SchedulePublishRequest,
    SchedulePublishResponse,
    ScheduleLevelRequest,
    ScheduleLevelResponse,
    ScheduleOverviewItemRequest,
    ScheduleOverviewItemResponse,
    ScheduleRoomRequest,
    ScheduleRoomResponse,
    ScheduleSessionCreateRequest,
    ScheduleSessionResponse,
    ScheduleSessionUpdateRequest,
    SessionAttendanceSummaryBatchResponse,
    SessionAttendanceSummaryResponse,
    SessionPlanAttendeeResponse,
    ScheduleVenueRequest,
    ScheduleVenueResponse,
)
from backend.db.database import get_session
from backend.db.models import (
    CachedEvent,
    EventSchedule,
    EventScheduleEditor,
    MyPlanShareToken,
    Notification,
    PushSubscription,
    ScheduleActivityType,
    ScheduleContributor,
    ScheduleLevel,
    ScheduleOverviewItem,
    ScheduleOverviewItemRoom,
    SchedulePublication,
    ScheduleRoom,
    ScheduleSession,
    ScheduleSessionContributor,
    ScheduleSessionRoom,
    ScheduleVenue,
    User,
    UserEventAttendance,
    UserPlanAudience,
    UserPlanSession,
)
from backend.services.schedules import (
    build_snapshot,
    compute_change_details,
    compute_diff,
    compute_issues,
    default_schedule_days,
    delete_overview_item,
    latest_publication,
    normalize_snapshot,
    ordered_room_ids,
    overview_item_snapshot,
    overview_room_ids_by_item,
    plan_counts,
    plan_entries,
    plan_target_id,
    replace_overview_item_rooms,
    replace_session_rooms,
    seed_default_activity_types,
    seed_default_dance_levels,
    session_attendance_projection,
    session_room_ids_by_session,
    session_snapshot,
    to_utc,
    validate_timezone,
)
from backend.services.schedule_import import (
    apply_import_document,
    build_schedule_import_example,
    export_schedule_document,
)
from backend.services.notifications import (
    notify_planned_session_changes,
    planned_change_description,
    planned_session_changes,
    reconcile_plan_activity_notifications,
)
from backend.services.program_exports import (
    build_program_projection,
    render_program_csv,
    render_program_ics,
)


logger = logging.getLogger(__name__)
limiter = Limiter(key_func=client_ip)

PUBLICATION_DELIVERY_JOB = "schedule_publication"
_PUBLICATION_KINDS = (
    "planned_session_changed",
    "schedule_program_available",
    "schedule_program_updated",
)
_NOTIFY_REASON_TITLES = {
    "available": "Program now available",
    "updated": "Program updated",
    "under_work": "Program under work",
    "back": "Program is back",
    "custom": "Program update",
}
_NOTIFY_REASON_MESSAGES = {
    "available": "The program is live. Browse sessions and build your plan.",
    "updated": "The event program has changed. Review the latest schedule.",
    "under_work": "The program is being updated. We'll let you know when it's back.",
    "back": "The program is available again. Check what's new.",
    "custom": "There is news about the program.",
}


def _organizer_id(session: Session, event_id: str) -> UUID | None:
    return session.exec(
        select(CachedEvent.organizer_user_id).where(
            CachedEvent.event_id == event_id, CachedEvent.deleted_at.is_(None)
        )
    ).first()


def _can_edit_schedule(session: Session, event_id: str, user: User | None) -> bool:
    if user is None:
        return False
    if is_admin_user(user):
        return True
    if _organizer_id(session, event_id) == user.id:
        return True
    schedule_id = session.exec(
        select(EventSchedule.id).where(EventSchedule.event_id == event_id)
    ).first()
    if schedule_id is None:
        return False
    return (
        session.exec(
            select(EventScheduleEditor.id).where(
                EventScheduleEditor.schedule_id == schedule_id,
                EventScheduleEditor.user_id == user.id,
            )
        ).first()
        is not None
    )


def require_schedule_editor(
    event_id: str,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
) -> User:
    if not _can_edit_schedule(session, event_id, user):
        raise HTTPException(
            status_code=403, detail="Event schedule editor access required"
        )
    return user


def require_live_program(
    event_id: str,
    request: Request,
    session: Session = Depends(get_session),
) -> None:
    """Public program routes 404 while the program is unpublished."""
    # Editors must still reach the editor while the program is offline.
    if request.url.path.endswith("/schedule/editor-access"):
        return
    unpublished_at = session.exec(
        select(EventSchedule.unpublished_at).where(EventSchedule.event_id == event_id)
    ).first()
    if unpublished_at is not None:
        raise HTTPException(status_code=404, detail="Published schedule not found")


public_router = APIRouter(
    prefix="/api/events/{event_id}",
    tags=["event-schedules"],
    dependencies=[
        Depends(require_flag("event_schedule_enabled")),
        Depends(require_live_program),
    ],
)
my_plan_router = APIRouter(
    prefix="/api/my-plan",
    tags=["event-schedules"],
    dependencies=[Depends(require_flag("event_schedule_enabled"))],
)
admin_router = APIRouter(
    prefix="/api/admin/events/{event_id}/schedule",
    tags=["admin-event-schedules"],
    dependencies=[Depends(require_schedule_editor)],
)


def _schedule_for_event(session: Session, event_id: str) -> EventSchedule:
    schedule = session.exec(
        select(EventSchedule).where(EventSchedule.event_id == event_id)
    ).first()
    if schedule is None:
        raise HTTPException(status_code=404, detail="Schedule not found")
    return schedule


def _published_projection(
    session: Session,
    event_id: str,
    *,
    days: list[str] | None = None,
    include_cancelled: bool = True,
    instructor: str | None = None,
    contributor_ids: list[int] | None = None,
    level_ids: list[int] | None = None,
    activity_type_ids: list[int] | None = None,
    selected_sessions: list[tuple[dict, str]] | None = None,
) -> dict:
    schedule = _schedule_for_event(session, event_id)
    publication = latest_publication(session, schedule.id)
    if publication is None:
        raise HTTPException(status_code=404, detail="Published schedule not found")
    event = session.get(CachedEvent, event_id)
    if event is None or event.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Event not found")
    try:
        return build_program_projection(
            event,
            publication,
            days=days,
            include_cancelled=include_cancelled,
            instructor=instructor,
            contributor_ids=contributor_ids,
            level_ids=level_ids,
            activity_type_ids=activity_type_ids,
            selected_sessions=selected_sessions,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def _export_filename(title: str, event_id: str, suffix: str) -> str:
    stem = re.sub(r"[^a-z0-9]+", "-", title.casefold()).strip("-") or event_id
    return f"{stem}-{suffix}"


def _row_for_schedule(session: Session, model, row_id: int, schedule_id: int):
    row = session.get(model, row_id)
    if row is None or row.schedule_id != schedule_id:
        raise HTTPException(status_code=404, detail="Schedule item not found")
    return row


def _validated_reference(session: Session, model, row_id: int | None, schedule_id: int):
    if row_id is None:
        return None
    return _row_for_schedule(session, model, row_id, schedule_id)


def _admin_payload(session: Session, schedule: EventSchedule) -> dict:
    draft = build_snapshot(session, schedule)
    publication = latest_publication(session, schedule.id)
    draft["version"] = publication.version if publication else None
    draft["unpublished_at"] = schedule.unpublished_at
    draft["published_at"] = publication.published_at if publication else None
    draft["issues"] = compute_issues(session, schedule)
    draft["diff"] = compute_diff(draft, publication.snapshot if publication else None)
    return draft


def _import_result(
    session: Session, schedule: EventSchedule, request: ScheduleImportRequest
) -> dict:
    previous_snapshot = build_snapshot(session, schedule)
    try:
        result = apply_import_document(
            session, schedule, request.document, request.mode
        )
    except ValueError as exc:
        session.rollback()
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except IntegrityError as exc:
        session.rollback()
        logger.warning("Schedule import conflict for %s: %s", schedule.event_id, exc)
        raise HTTPException(
            status_code=409,
            detail="The JSON conflicts with existing program items (duplicate names or external IDs).",
        ) from exc
    snapshot = result["snapshot"]
    operations = {
        key: result[key] for key in ("created", "updated", "removed", "unchanged")
    }
    if request.exclude:
        for ref in sorted(request.exclude, key=_revert_order):
            entity_id = ref.entity_id
            if ref.operation == "create":
                entity_id = _created_entity_id(snapshot, ref)
            _revert_entity(
                session,
                schedule,
                previous_snapshot,
                ref.entity_type,
                entity_id,
                ref.operation,
            )
            operations[f"{ref.operation}d"] -= 1
            operations["unchanged"] += 1
        session.flush()
        snapshot = build_snapshot(session, schedule)
    publication = latest_publication(session, schedule.id)
    return {
        "document": export_schedule_document(session, schedule),
        "operations": {key: max(0, value) for key, value in operations.items()},
        "changes": compute_change_details(snapshot, previous_snapshot),
        "issues": compute_issues(session, schedule),
        "diff": compute_diff(snapshot, publication.snapshot if publication else None),
    }


_CONFIG_MODELS = {
    "venue": ScheduleVenue,
    "room": ScheduleRoom,
    "level": ScheduleLevel,
    "activity_type": ScheduleActivityType,
    "contributor": ScheduleContributor,
}
_SNAPSHOT_KEYS = {
    "venue": "venues",
    "room": "rooms",
    "level": "levels",
    "activity_type": "activity_types",
    "contributor": "contributors",
    "session": "sessions",
    "overview_item": "overview_items",
}
_ENTITY_ORDER = (
    "venue",
    "room",
    "level",
    "activity_type",
    "contributor",
    "overview_item",
    "session",
)
_STALE_CHANGE = (
    "This change was edited since you opened the review. Refresh and try again."
)


def _revert_order(ref) -> tuple[int, int]:
    position = (
        _ENTITY_ORDER.index(ref.entity_type) if ref.entity_type in _ENTITY_ORDER else -1
    )
    # Recreate referenced config before sessions; drop sessions before the config they use.
    if ref.operation == "remove":
        return (0, position)
    if ref.operation == "update":
        return (1, position)
    return (2, -position)


def _created_entity_id(snapshot: dict, ref) -> str:
    rows = snapshot.get(_SNAPSHOT_KEYS.get(ref.entity_type, ""), [])
    match = next(
        (
            row
            for row in rows
            if ref.external_id and row.get("external_id") == ref.external_id
        ),
        None,
    )
    if match is None:
        raise HTTPException(status_code=409, detail=_STALE_CHANGE)
    return str(match["id"])


def _parse_snapshot_time(value: str) -> datetime:
    return to_utc(datetime.fromisoformat(value.replace("Z", "+00:00")))


def _revert_entity(
    session: Session,
    schedule: EventSchedule,
    baseline: dict,
    entity_type: str,
    entity_id: str,
    operation: str,
) -> None:
    """Make one entity match `baseline` again. Flushes, never commits."""
    baseline = normalize_snapshot(baseline)
    if entity_type == "schedule":
        for field in ("timezone", "day_start_hour", "session_color_mode", "days"):
            setattr(schedule, field, baseline.get(field))
        schedule.updated_at = datetime.now(timezone.utc)
        session.add(schedule)
        session.flush()
        return
    key = _SNAPSHOT_KEYS[entity_type]
    original = next(
        (row for row in baseline.get(key, []) if str(row["id"]) == entity_id), None
    )
    if operation == "create":
        _drop_entity(session, schedule, entity_type, entity_id)
    elif original is None:
        raise HTTPException(status_code=409, detail=_STALE_CHANGE)
    elif entity_type == "session":
        _restore_session(session, schedule, original)
    elif entity_type == "overview_item":
        _restore_overview_item(session, schedule, original)
    else:
        model = _CONFIG_MODELS[entity_type]
        row = session.get(model, int(entity_id))
        if row is not None and row.schedule_id != schedule.id:
            raise HTTPException(status_code=404, detail="Item not found")
        if row is None:
            row = model(id=int(entity_id), schedule_id=schedule.id)
        _apply(
            row, {field: value for field, value in original.items() if field != "id"}
        )
        session.add(row)
    try:
        session.flush()
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(
            status_code=409,
            detail="Could not undo this change: a conflicting item exists",
        ) from exc


def _drop_entity(
    session: Session, schedule: EventSchedule, entity_type: str, entity_id: str
) -> None:
    if entity_type == "session":
        row = session.get(ScheduleSession, UUID(entity_id))
        if row is None or row.schedule_id != schedule.id:
            raise HTTPException(status_code=409, detail=_STALE_CHANGE)
        row.deleted_at = row.updated_at = datetime.now(timezone.utc)
        session.add(row)
        return
    if entity_type == "overview_item":
        delete_overview_item(
            session, _overview_item_for_schedule(session, schedule, UUID(entity_id))
        )
        return
    row = session.get(_CONFIG_MODELS[entity_type], int(entity_id))
    if row is None or row.schedule_id != schedule.id:
        raise HTTPException(status_code=409, detail=_STALE_CHANGE)
    session.flush()
    if _config_in_use(build_snapshot(session, schedule), entity_type, row.id):
        label = (
            getattr(row, "name", None)
            or getattr(row, "label", None)
            or getattr(row, "display_name", None)
        )
        raise HTTPException(
            status_code=409,
            detail=f"{label or 'This item'} is still used in the draft. Undo the changes that use it first.",
        )
    session.delete(row)
    try:
        session.flush()
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(
            status_code=409,
            detail="This item is still used in the draft. Undo the changes that use it first.",
        ) from exc


def _config_in_use(snapshot: dict, entity_type: str, row_id: int) -> bool:
    sessions = snapshot.get("sessions", [])
    items = snapshot.get("overview_items", [])
    if entity_type == "venue":
        return any(
            row.get("venue_id") == row_id
            for row in [*snapshot.get("rooms", []), *sessions, *items]
        )
    if entity_type == "room":
        return any(row_id in (row.get("room_ids") or []) for row in [*sessions, *items])
    if entity_type == "level":
        return any(row.get("level_id") == row_id for row in sessions)
    if entity_type == "activity_type":
        return any(row.get("activity_type_id") == row_id for row in [*sessions, *items])
    return any(
        item.get("contributor_id") == row_id
        for row in sessions
        for item in row.get("contributors") or []
    )


def _restore_session(session: Session, schedule: EventSchedule, original: dict) -> None:
    row = session.get(ScheduleSession, UUID(original["id"]))
    if row is None:
        row = ScheduleSession(
            id=UUID(original["id"]), schedule_id=schedule.id, title=""
        )
    elif row.schedule_id != schedule.id:
        raise HTTPException(status_code=404, detail="Session not found")
    data = {
        field: original.get(field)
        for field in (
            "external_id",
            "title",
            "description",
            "room_id",
            "venue_id",
            "level_id",
            "activity_type_id",
            "attendee_note",
            "allow_plan",
            "is_cancelled",
        )
    }
    data["start"] = _parse_snapshot_time(original["start"])
    data["end"] = _parse_snapshot_time(original["end"])
    _apply(row, _validated_session_data(session, schedule, data))
    row.deleted_at = None
    row.updated_at = datetime.now(timezone.utc)
    session.add(row)
    session.flush()
    replace_session_rooms(
        session,
        row,
        _validated_room_ids(session, schedule, original.get("room_ids") or []),
    )
    _replace_session_contributors(
        session,
        schedule,
        row,
        [
            {"contributor_id": item["contributor_id"], "role": item["role"]}
            for item in original.get("contributors") or []
        ],
    )
    row.instructors = original.get("instructors")


def _restore_overview_item(
    session: Session, schedule: EventSchedule, original: dict
) -> None:
    row = session.get(ScheduleOverviewItem, UUID(original["id"]))
    if row is None:
        row = ScheduleOverviewItem(id=UUID(original["id"]), schedule_id=schedule.id)
    elif row.schedule_id != schedule.id:
        raise HTTPException(status_code=404, detail="Overview item not found")
    data = {
        field: original.get(field)
        for field in (
            "external_id",
            "title",
            "subtitle",
            "description",
            "url",
            "url_label",
            "activity_type_id",
            "venue_id",
            "opens_detail",
            "allow_plan",
            "is_cancelled",
            "sort_order",
        )
    }
    data["parent_id"] = (
        UUID(original["parent_id"]) if original.get("parent_id") else None
    )
    data["start"] = _parse_snapshot_time(original["start"])
    data["end"] = _parse_snapshot_time(original["end"])
    _apply(row, data)
    session.add(row)
    session.flush()
    replace_overview_item_rooms(session, row, original.get("room_ids") or [])


@public_router.get("/schedule", response_model=EventScheduleResponse)
def get_published_schedule(
    event_id: str,
    session: Session = Depends(get_session),
):
    schedule = _schedule_for_event(session, event_id)
    publication = latest_publication(session, schedule.id)
    if publication is None:
        raise HTTPException(status_code=404, detail="Published schedule not found")
    return publication.snapshot


@public_router.get(
    "/schedule/attendance-summary",
    response_model=SessionAttendanceSummaryBatchResponse,
)
def get_session_attendance_summary(
    event_id: str,
    response: Response,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
):
    schedule = _schedule_for_event(session, event_id)
    publication = latest_publication(session, schedule.id)
    if publication is None:
        raise HTTPException(status_code=404, detail="Published schedule not found")
    projected = session_attendance_projection(session, user, event_id, publication)
    response.headers["Cache-Control"] = "private, no-store"
    return {
        "sessions": [
            {
                "session_id": row["id"],
                "visible_count": len(projected.get(row["id"], [])),
                "preview_attendees": projected.get(row["id"], [])[:3],
            }
            for row in publication.snapshot.get("sessions", [])
            if not row.get("is_cancelled", False)
        ],
        "overview_items": [
            {
                "overview_item_id": row["id"],
                "visible_count": len(projected.get(row["id"], [])),
                "preview_attendees": projected.get(row["id"], [])[:3],
            }
            for row in publication.snapshot.get("overview_items", [])
            if row.get("allow_plan") and not row.get("is_cancelled", False)
        ],
    }


def _plannable_overview_item(publication: SchedulePublication, item_id: UUID) -> dict:
    item = next(
        (
            row
            for row in publication.snapshot.get("overview_items", [])
            if row["id"] == str(item_id)
        ),
        None,
    )
    if item is None:
        raise HTTPException(status_code=404, detail="Overview item not found")
    return item


@public_router.get(
    "/schedule/overview-items/{item_id}/attendees",
    response_model=list[SessionPlanAttendeeResponse],
)
def get_overview_item_attendees(
    event_id: str,
    item_id: UUID,
    response: Response,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
):
    schedule = _schedule_for_event(session, event_id)
    publication = latest_publication(session, schedule.id)
    if publication is None:
        raise HTTPException(status_code=404, detail="Published schedule not found")
    _plannable_overview_item(publication, item_id)
    response.headers["Cache-Control"] = "private, no-store"
    return session_attendance_projection(session, user, event_id, publication).get(
        str(item_id), []
    )


@public_router.get(
    "/schedule/overview-items/{item_id}/attendance-summary",
    response_model=OverviewItemAttendanceSummaryResponse,
)
def get_overview_item_attendance_summary(
    event_id: str,
    item_id: UUID,
    response: Response,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
):
    schedule = _schedule_for_event(session, event_id)
    publication = latest_publication(session, schedule.id)
    if publication is None:
        raise HTTPException(status_code=404, detail="Published schedule not found")
    _plannable_overview_item(publication, item_id)
    attendees = session_attendance_projection(session, user, event_id, publication).get(
        str(item_id), []
    )
    response.headers["Cache-Control"] = "private, no-store"
    return {
        "overview_item_id": item_id,
        "visible_count": len(attendees),
        "preview_attendees": attendees[:5],
    }


@public_router.get(
    "/schedule/sessions/{session_id}/attendees",
    response_model=list[SessionPlanAttendeeResponse],
)
def get_session_attendees(
    event_id: str,
    session_id: UUID,
    response: Response,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
):
    schedule = _schedule_for_event(session, event_id)
    publication = latest_publication(session, schedule.id)
    if publication is None:
        raise HTTPException(status_code=404, detail="Published schedule not found")
    item = next(
        (
            row
            for row in publication.snapshot.get("sessions", [])
            if row["id"] == str(session_id) and not row.get("is_cancelled", False)
        ),
        None,
    )
    if item is None:
        raise HTTPException(status_code=404, detail="Session not found")
    response.headers["Cache-Control"] = "private, no-store"
    return session_attendance_projection(session, user, event_id, publication).get(
        str(session_id), []
    )


@public_router.get(
    "/schedule/sessions/{session_id}/attendance-summary",
    response_model=SessionAttendanceSummaryResponse,
)
def get_single_session_attendance_summary(
    event_id: str,
    session_id: UUID,
    response: Response,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
):
    schedule = _schedule_for_event(session, event_id)
    publication = latest_publication(session, schedule.id)
    if publication is None:
        raise HTTPException(status_code=404, detail="Published schedule not found")
    item = next(
        (
            row
            for row in publication.snapshot.get("sessions", [])
            if row["id"] == str(session_id) and not row.get("is_cancelled", False)
        ),
        None,
    )
    if item is None:
        raise HTTPException(status_code=404, detail="Session not found")
    attendees = session_attendance_projection(session, user, event_id, publication).get(
        str(session_id), []
    )
    response.headers["Cache-Control"] = "private, no-store"
    return {
        "session_id": session_id,
        "visible_count": len(attendees),
        "preview_attendees": attendees[:5],
    }


@public_router.get(
    "/schedule/editor-access", response_model=EventScheduleEditorAccessResponse
)
def get_schedule_editor_access(
    event_id: str,
    user: User | None = Depends(get_current_user_optional),
    session: Session = Depends(get_session),
):
    return {"can_edit": _can_edit_schedule(session, event_id, user)}


@my_plan_router.post("/counts", response_model=list[MyPlanCountResponse])
def get_my_plan_counts(
    payload: MyPlanCountBatchRequest,
    response: Response,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
):
    event_ids = list(dict.fromkeys(payload.event_ids))
    counts = plan_counts(session, user.id, event_ids)
    response.headers["Cache-Control"] = "private, no-store"
    return [
        {"event_id": event_id, "plan_count": counts[event_id]} for event_id in event_ids
    ]


@public_router.get("/my-plan", response_model=MyPlanResponse)
def get_my_plan(
    event_id: str,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
):
    schedule = _schedule_for_event(session, event_id)
    publication = latest_publication(session, schedule.id)
    audience = session.exec(
        select(UserPlanAudience).where(
            UserPlanAudience.user_id == user.id,
            UserPlanAudience.event_id == event_id,
        )
    ).first()
    return {
        "entries": plan_entries(session, user.id, event_id, publication),
        "audience": audience.audience if audience else None,
    }


@public_router.put("/my-plan/audience", response_model=MyPlanResponse)
def update_my_plan_audience(
    event_id: str,
    payload: UpdateMyPlanAudienceRequest,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
):
    schedule = _schedule_for_event(session, event_id)
    publication = latest_publication(session, schedule.id)
    if publication is None:
        raise HTTPException(status_code=404, detail="Published schedule not found")
    entries = plan_entries(session, user.id, event_id, publication)
    if payload.audience != "private" and not entries:
        raise HTTPException(status_code=409, detail="My Plan is empty")
    row = session.exec(
        select(UserPlanAudience).where(
            UserPlanAudience.user_id == user.id,
            UserPlanAudience.event_id == event_id,
        )
    ).first()
    if row is None:
        row = UserPlanAudience(
            user_id=user.id,
            event_id=event_id,
            audience=payload.audience,
        )
    else:
        row.audience = payload.audience
        row.updated_at = datetime.now(timezone.utc)
    session.add(row)
    session.flush()
    reconcile_plan_activity_notifications(
        session,
        user,
        event_id,
        alert=False,
    )
    session.commit()
    return {"entries": entries, "audience": row.audience}


@public_router.get("/my-plan/share", response_model=MyPlanShareResponse | None)
def get_my_plan_share(
    event_id: str,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
):
    return session.exec(
        select(MyPlanShareToken).where(
            MyPlanShareToken.user_id == user.id,
            MyPlanShareToken.event_id == event_id,
        )
    ).first()


@public_router.post(
    "/my-plan/share", response_model=MyPlanShareResponse, status_code=201
)
def create_my_plan_share(
    event_id: str,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
):
    schedule = _schedule_for_event(session, event_id)
    publication = latest_publication(session, schedule.id)
    if publication is None:
        raise HTTPException(status_code=404, detail="Published schedule not found")
    if not plan_entries(session, user.id, event_id, publication):
        raise HTTPException(status_code=409, detail="My Plan is empty")
    existing = session.exec(
        select(MyPlanShareToken).where(
            MyPlanShareToken.user_id == user.id,
            MyPlanShareToken.event_id == event_id,
        )
    ).first()
    if existing is not None:
        return existing
    share = MyPlanShareToken(token=str(uuid4()), user_id=user.id, event_id=event_id)
    session.add(share)
    session.commit()
    session.refresh(share)
    return share


@public_router.delete("/my-plan/share", status_code=status.HTTP_204_NO_CONTENT)
def revoke_my_plan_share(
    event_id: str,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
):
    existing = session.exec(
        select(MyPlanShareToken).where(
            MyPlanShareToken.user_id == user.id,
            MyPlanShareToken.event_id == event_id,
        )
    ).first()
    if existing is not None:
        session.delete(existing)
        session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@public_router.get("/my-plan/ics")
@limiter.limit("10/minute")
def export_my_plan_ics(
    event_id: str,
    request: Request,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
):
    schedule = _schedule_for_event(session, event_id)
    publication = latest_publication(session, schedule.id)
    if publication is None:
        raise HTTPException(status_code=404, detail="Published schedule not found")
    selected_sessions = [
        (entry.get("session") or entry["overview_item"], entry["status"])
        for entry in plan_entries(session, user.id, event_id, publication)
    ]
    projection = _published_projection(
        session,
        event_id,
        selected_sessions=selected_sessions,
    )
    filename = _export_filename(projection["event_title"], event_id, "my-plan.ics")
    return Response(
        render_program_ics(projection, my_plan=True).encode("utf-8"),
        media_type="text/calendar; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "private, no-store",
        },
    )


@public_router.put(
    "/my-plan/{session_id}",
    response_model=MyPlanEntryResponse,
    status_code=status.HTTP_201_CREATED,
)
def add_to_my_plan(
    event_id: str,
    session_id: UUID,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
):
    schedule = _schedule_for_event(session, event_id)
    publication = latest_publication(session, schedule.id)
    if publication is None:
        raise HTTPException(status_code=404, detail="Published schedule not found")
    item = next(
        (
            row
            for row in publication.snapshot.get("sessions", [])
            if row["id"] == str(session_id)
        ),
        None,
    )
    if item is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if not item.get("allow_plan", True) or item.get("is_cancelled", False):
        raise HTTPException(
            status_code=409, detail="This session cannot be added to My Plan"
        )
    existing = session.exec(
        select(UserPlanSession).where(
            UserPlanSession.user_id == user.id,
            UserPlanSession.session_id == session_id,
        )
    ).first()
    if existing is None:
        session.add(
            UserPlanSession(
                user_id=user.id,
                session_id=session_id,
                event_id=event_id,
                last_known_session=item,
            )
        )
        session.flush()
        reconcile_plan_activity_notifications(session, user, event_id, alert=True)
        session.commit()
    return {"session_id": session_id, "status": "active", "session": item}


@public_router.delete("/my-plan/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_from_my_plan(
    event_id: str,
    session_id: UUID,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
):
    row = session.exec(
        select(UserPlanSession).where(
            UserPlanSession.user_id == user.id,
            UserPlanSession.session_id == session_id,
            UserPlanSession.event_id == event_id,
        )
    ).first()
    if row is not None:
        session.delete(row)
        session.flush()
        reconcile_plan_activity_notifications(session, user, event_id, alert=False)
        session.commit()


@public_router.put(
    "/my-plan/overview-items/{item_id}",
    response_model=MyPlanEntryResponse,
    status_code=status.HTTP_201_CREATED,
)
def add_overview_item_to_my_plan(
    event_id: str,
    item_id: UUID,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
):
    schedule = _schedule_for_event(session, event_id)
    publication = latest_publication(session, schedule.id)
    if publication is None:
        raise HTTPException(status_code=404, detail="Published schedule not found")
    item = _plannable_overview_item(publication, item_id)
    if (
        not item.get("allow_plan", False)
        or item.get("parent_id")
        or item.get("is_cancelled", False)
    ):
        raise HTTPException(
            status_code=409, detail="This item cannot be added to My Plan"
        )
    existing = session.exec(
        select(UserPlanSession).where(
            UserPlanSession.user_id == user.id,
            UserPlanSession.overview_item_id == item_id,
        )
    ).first()
    if existing is None:
        session.add(
            UserPlanSession(
                user_id=user.id,
                overview_item_id=item_id,
                event_id=event_id,
                last_known_session=item,
            )
        )
        session.flush()
        reconcile_plan_activity_notifications(session, user, event_id, alert=True)
        session.commit()
    return {
        "kind": "overview_item",
        "overview_item_id": item_id,
        "status": "active",
        "overview_item": item,
    }


@public_router.delete(
    "/my-plan/overview-items/{item_id}", status_code=status.HTTP_204_NO_CONTENT
)
def remove_overview_item_from_my_plan(
    event_id: str,
    item_id: UUID,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
):
    row = session.exec(
        select(UserPlanSession).where(
            UserPlanSession.user_id == user.id,
            UserPlanSession.overview_item_id == item_id,
            UserPlanSession.event_id == event_id,
        )
    ).first()
    if row is not None:
        session.delete(row)
        session.flush()
        reconcile_plan_activity_notifications(session, user, event_id, alert=False)
        session.commit()


@admin_router.get("", response_model=AdminEventScheduleResponse)
def get_admin_schedule(event_id: str, session: Session = Depends(get_session)):
    return _admin_payload(session, _schedule_for_event(session, event_id))


def _editor_response(grant: EventScheduleEditor, user: User) -> dict:
    return {
        "user_id": user.id,
        "email": user.email,
        "name": user.display_name,
        "handle": user.handle,
        "granted_at": grant.granted_at,
    }


@admin_router.get("/editors", response_model=list[EventScheduleEditorResponse])
def list_schedule_editors(
    event_id: str,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    schedule = _schedule_for_event(session, event_id)
    rows = session.exec(
        select(EventScheduleEditor, User)
        .join(User, User.id == EventScheduleEditor.user_id)
        .where(
            EventScheduleEditor.schedule_id == schedule.id,
            User.deleted_at.is_(None),
        )
        .order_by(User.email)
    ).all()
    editors = [_editor_response(grant, user) for grant, user in rows]
    organizer_id = _organizer_id(session, event_id)
    organizer = session.get(User, organizer_id) if organizer_id else None
    if organizer is not None and organizer.deleted_at is None:
        editors = [row for row in editors if row["user_id"] != organizer.id]
        editors.insert(
            0,
            {
                "user_id": organizer.id,
                "email": organizer.email,
                "name": organizer.display_name,
                "handle": organizer.handle,
                "granted_at": None,
                "is_organizer": True,
            },
        )
    return editors


@admin_router.post(
    "/editors",
    response_model=EventScheduleEditorResponse,
    status_code=status.HTTP_201_CREATED,
)
def add_schedule_editor(
    event_id: str,
    body: EventScheduleEditorCreateRequest,
    admin: User = Depends(require_user),
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    schedule = _schedule_for_event(session, event_id)
    user = session.get(User, body.user_id)
    if user is None or user.deleted_at is not None:
        raise HTTPException(status_code=404, detail="User not found")
    grant = EventScheduleEditor(
        schedule_id=schedule.id,
        user_id=user.id,
        granted_by_user_id=admin.id,
    )
    session.add(grant)
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(
            status_code=409, detail="User is already an editor"
        ) from exc
    session.refresh(grant)
    return _editor_response(grant, user)


@admin_router.delete("/editors/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_schedule_editor(
    event_id: str,
    user_id: UUID,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    schedule = _schedule_for_event(session, event_id)
    grant = session.exec(
        select(EventScheduleEditor).where(
            EventScheduleEditor.schedule_id == schedule.id,
            EventScheduleEditor.user_id == user_id,
        )
    ).first()
    if grant is not None:
        session.delete(grant)
        session.commit()


@admin_router.post(
    "", response_model=AdminEventScheduleResponse, status_code=status.HTTP_201_CREATED
)
def create_admin_schedule(
    event_id: str,
    body: EventScheduleCreateRequest,
    session: Session = Depends(get_session),
):
    event = session.get(CachedEvent, event_id)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not found")
    if session.exec(
        select(EventSchedule).where(EventSchedule.event_id == event_id)
    ).first():
        raise HTTPException(status_code=409, detail="Schedule already exists")
    try:
        timezone_name = validate_timezone(body.timezone)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    days = (
        [value.isoformat() for value in body.days]
        if body.days
        else default_schedule_days(event, timezone_name)
    )
    schedule = EventSchedule(
        event_id=event_id,
        timezone=timezone_name,
        day_start_hour=body.day_start_hour,
        days=days,
    )
    session.add(schedule)
    session.flush()
    seed_default_activity_types(session, schedule.id)
    seed_default_dance_levels(session, schedule.id)
    session.commit()
    session.refresh(schedule)
    return _admin_payload(session, schedule)


@admin_router.delete("", status_code=status.HTTP_204_NO_CONTENT)
def delete_admin_schedule(
    event_id: str,
    confirm_title: str = Query(..., max_length=300),
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """Delete the program, its publications and attendee plans. The event itself stays."""
    schedule = _schedule_for_event(session, event_id)
    event = session.get(CachedEvent, event_id)
    if (
        event is None
        or confirm_title.strip().casefold() != (event.title or "").strip().casefold()
    ):
        raise HTTPException(status_code=422, detail="Type the event title to confirm")
    session_ids = list(
        session.exec(
            select(ScheduleSession.id).where(ScheduleSession.schedule_id == schedule.id)
        ).all()
    )
    items = session.exec(
        select(ScheduleOverviewItem).where(
            ScheduleOverviewItem.schedule_id == schedule.id
        )
    ).all()
    dependents = [
        *session.exec(
            select(UserPlanSession).where(UserPlanSession.event_id == event_id)
        ).all(),
        *session.exec(
            select(MyPlanShareToken).where(MyPlanShareToken.event_id == event_id)
        ).all(),
    ]
    if session_ids:
        dependents += [
            *session.exec(
                select(ScheduleSessionContributor).where(
                    ScheduleSessionContributor.session_id.in_(session_ids)
                )
            ).all(),
            *session.exec(
                select(ScheduleSessionRoom).where(
                    ScheduleSessionRoom.session_id.in_(session_ids)
                )
            ).all(),
        ]
    if items:
        dependents += session.exec(
            select(ScheduleOverviewItemRoom).where(
                ScheduleOverviewItemRoom.item_id.in_([row.id for row in items])
            )
        ).all()
    for row in dependents:
        session.delete(row)
    session.flush()
    for row in sorted(items, key=lambda row: row.parent_id is None):
        session.delete(row)
        session.flush()
    for model in (
        ScheduleSession,
        ScheduleRoom,
        ScheduleVenue,
        ScheduleLevel,
        ScheduleActivityType,
        ScheduleContributor,
        SchedulePublication,
        EventScheduleEditor,
    ):
        for row in session.exec(
            select(model).where(model.schedule_id == schedule.id)
        ).all():
            session.delete(row)
        session.flush()
    session.delete(schedule)
    session.commit()


@admin_router.patch("", response_model=AdminEventScheduleResponse)
def update_admin_schedule(
    event_id: str,
    body: EventScheduleUpdateRequest,
    session: Session = Depends(get_session),
):
    schedule = _schedule_for_event(session, event_id)
    data = body.model_dump(exclude_unset=True)
    if "timezone" in data:
        if data["timezone"] is None:
            raise HTTPException(status_code=422, detail="Timezone is required")
        try:
            schedule.timezone = validate_timezone(data["timezone"])
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
    if "days" in data:
        if not data["days"]:
            raise HTTPException(
                status_code=422, detail="At least one schedule day is required"
            )
        schedule.days = [value.isoformat() for value in data["days"]]
    if data.get("day_start_hour") is not None:
        schedule.day_start_hour = data["day_start_hour"]
    if data.get("session_color_mode") is not None:
        schedule.session_color_mode = data["session_color_mode"]
    schedule.updated_at = datetime.now(timezone.utc)
    session.add(schedule)
    session.commit()
    session.refresh(schedule)
    return _admin_payload(session, schedule)


@admin_router.post(
    "/venues", response_model=ScheduleVenueResponse, status_code=status.HTTP_201_CREATED
)
def create_venue(
    event_id: str, body: ScheduleVenueRequest, session: Session = Depends(get_session)
):
    schedule = _schedule_for_event(session, event_id)
    row = ScheduleVenue(schedule_id=schedule.id, **body.model_dump())
    return _save_config_row(session, row)


@admin_router.put("/venues/{row_id}", response_model=ScheduleVenueResponse)
def update_venue(
    event_id: str,
    row_id: int,
    body: ScheduleVenueRequest,
    session: Session = Depends(get_session),
):
    schedule = _schedule_for_event(session, event_id)
    row = _row_for_schedule(session, ScheduleVenue, row_id, schedule.id)
    _apply(row, body.model_dump())
    return _save_config_row(session, row)


@admin_router.delete("/venues/{row_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_venue(event_id: str, row_id: int, session: Session = Depends(get_session)):
    schedule = _schedule_for_event(session, event_id)
    row = _row_for_schedule(session, ScheduleVenue, row_id, schedule.id)
    if (
        session.exec(
            select(ScheduleRoom).where(ScheduleRoom.venue_id == row_id)
        ).first()
        or session.exec(
            select(ScheduleSession).where(
                ScheduleSession.venue_id == row_id, ScheduleSession.deleted_at.is_(None)
            )
        ).first()
        or session.exec(
            select(ScheduleOverviewItem.id).where(
                ScheduleOverviewItem.venue_id == row_id
            )
        ).first()
    ):
        raise HTTPException(
            status_code=409, detail="Venue is used by rooms, sessions or overview items"
        )
    _delete_config_row(session, row)


@admin_router.post(
    "/rooms", response_model=ScheduleRoomResponse, status_code=status.HTTP_201_CREATED
)
def create_room(
    event_id: str, body: ScheduleRoomRequest, session: Session = Depends(get_session)
):
    schedule = _schedule_for_event(session, event_id)
    _validated_reference(session, ScheduleVenue, body.venue_id, schedule.id)
    return _save_config_row(
        session, ScheduleRoom(schedule_id=schedule.id, **body.model_dump())
    )


@admin_router.put("/rooms/{row_id}", response_model=ScheduleRoomResponse)
def update_room(
    event_id: str,
    row_id: int,
    body: ScheduleRoomRequest,
    session: Session = Depends(get_session),
):
    schedule = _schedule_for_event(session, event_id)
    _validated_reference(session, ScheduleVenue, body.venue_id, schedule.id)
    row = _row_for_schedule(session, ScheduleRoom, row_id, schedule.id)
    _apply(row, body.model_dump())
    return _save_config_row(session, row)


@admin_router.delete("/rooms/{row_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_room(event_id: str, row_id: int, session: Session = Depends(get_session)):
    schedule = _schedule_for_event(session, event_id)
    row = _row_for_schedule(session, ScheduleRoom, row_id, schedule.id)
    secondary_use = session.exec(
        select(ScheduleSessionRoom)
        .join(ScheduleSession, ScheduleSession.id == ScheduleSessionRoom.session_id)
        .where(
            ScheduleSessionRoom.room_id == row_id,
            ScheduleSession.deleted_at.is_(None),
        )
    ).first()
    if secondary_use:
        raise HTTPException(
            status_code=409, detail="Item is used by one or more sessions"
        )
    if session.exec(
        select(ScheduleOverviewItemRoom.id).where(
            ScheduleOverviewItemRoom.room_id == row_id
        )
    ).first():
        raise HTTPException(
            status_code=409, detail="Item is used by one or more overview items"
        )
    for link in session.exec(
        select(ScheduleSessionRoom).where(ScheduleSessionRoom.room_id == row_id)
    ).all():
        session.delete(link)
    _delete_if_unused(session, row, ScheduleSession.room_id == row_id)


@admin_router.post(
    "/levels", response_model=ScheduleLevelResponse, status_code=status.HTTP_201_CREATED
)
def create_level(
    event_id: str, body: ScheduleLevelRequest, session: Session = Depends(get_session)
):
    schedule = _schedule_for_event(session, event_id)
    return _save_config_row(
        session, ScheduleLevel(schedule_id=schedule.id, **body.model_dump())
    )


@admin_router.put("/levels/{row_id}", response_model=ScheduleLevelResponse)
def update_level(
    event_id: str,
    row_id: int,
    body: ScheduleLevelRequest,
    session: Session = Depends(get_session),
):
    schedule = _schedule_for_event(session, event_id)
    row = _row_for_schedule(session, ScheduleLevel, row_id, schedule.id)
    _apply(row, body.model_dump())
    return _save_config_row(session, row)


@admin_router.delete("/levels/{row_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_level(event_id: str, row_id: int, session: Session = Depends(get_session)):
    schedule = _schedule_for_event(session, event_id)
    row = _row_for_schedule(session, ScheduleLevel, row_id, schedule.id)
    _delete_if_unused(session, row, ScheduleSession.level_id == row_id)


@admin_router.post(
    "/activity-types",
    response_model=ScheduleActivityTypeResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_activity_type(
    event_id: str,
    body: ScheduleActivityTypeRequest,
    session: Session = Depends(get_session),
):
    schedule = _schedule_for_event(session, event_id)
    return _save_config_row(
        session, ScheduleActivityType(schedule_id=schedule.id, **body.model_dump())
    )


@admin_router.put(
    "/activity-types/{row_id}", response_model=ScheduleActivityTypeResponse
)
def update_activity_type(
    event_id: str,
    row_id: int,
    body: ScheduleActivityTypeRequest,
    session: Session = Depends(get_session),
):
    schedule = _schedule_for_event(session, event_id)
    row = _row_for_schedule(session, ScheduleActivityType, row_id, schedule.id)
    _apply(row, body.model_dump())
    return _save_config_row(session, row)


@admin_router.delete("/activity-types/{row_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_activity_type(
    event_id: str, row_id: int, session: Session = Depends(get_session)
):
    schedule = _schedule_for_event(session, event_id)
    row = _row_for_schedule(session, ScheduleActivityType, row_id, schedule.id)
    if session.exec(
        select(ScheduleOverviewItem.id).where(
            ScheduleOverviewItem.activity_type_id == row_id
        )
    ).first():
        raise HTTPException(
            status_code=409, detail="Item is used by one or more overview items"
        )
    _delete_if_unused(session, row, ScheduleSession.activity_type_id == row_id)


@admin_router.post(
    "/contributors",
    response_model=ScheduleContributorResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_contributor(
    event_id: str,
    body: ScheduleContributorRequest,
    session: Session = Depends(get_session),
):
    schedule = _schedule_for_event(session, event_id)
    row = ScheduleContributor(
        schedule_id=schedule.id,
        external_id=f"contributor-{uuid4()}",
        **body.model_dump(),
    )
    return _save_config_row(session, row)


@admin_router.put("/contributors/{row_id}", response_model=ScheduleContributorResponse)
def update_contributor(
    event_id: str,
    row_id: int,
    body: ScheduleContributorRequest,
    session: Session = Depends(get_session),
):
    schedule = _schedule_for_event(session, event_id)
    row = _row_for_schedule(session, ScheduleContributor, row_id, schedule.id)
    _apply(row, body.model_dump())
    return _save_config_row(session, row)


@admin_router.delete("/contributors/{row_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_contributor(
    event_id: str, row_id: int, session: Session = Depends(get_session)
):
    schedule = _schedule_for_event(session, event_id)
    row = _row_for_schedule(session, ScheduleContributor, row_id, schedule.id)
    if session.exec(
        select(ScheduleSessionContributor).where(
            ScheduleSessionContributor.contributor_id == row_id
        )
    ).first():
        raise HTTPException(
            status_code=409, detail="Contributor is used by one or more sessions"
        )
    _delete_config_row(session, row)


@admin_router.post(
    "/sessions",
    response_model=ScheduleSessionResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_session(
    event_id: str,
    body: ScheduleSessionCreateRequest,
    session: Session = Depends(get_session),
):
    schedule = _schedule_for_event(session, event_id)
    data = body.model_dump()
    assignments = data.pop("contributors")
    room_ids = data.pop("room_ids")
    if room_ids is None:
        room_ids = [data["room_id"]] if data["room_id"] is not None else []
    room_ids = _validated_room_ids(session, schedule, room_ids)
    data["room_id"] = room_ids[0] if room_ids else None
    data = _validated_session_data(session, schedule, data)
    row = ScheduleSession(schedule_id=schedule.id, **data)
    session.add(row)
    session.flush()
    replace_session_rooms(session, row, room_ids)
    if assignments is not None:
        _replace_session_contributors(session, schedule, row, assignments)
    session.commit()
    session.refresh(row)
    return _session_response(session, row)


@admin_router.patch("/sessions/{session_id}", response_model=ScheduleSessionResponse)
def update_session(
    event_id: str,
    session_id: UUID,
    body: ScheduleSessionUpdateRequest,
    session: Session = Depends(get_session),
):
    schedule = _schedule_for_event(session, event_id)
    row = session.get(ScheduleSession, session_id)
    if row is None or row.schedule_id != schedule.id or row.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Session not found")
    data = body.model_dump(exclude_unset=True)
    assignments = data.pop("contributors", None)
    room_ids = data.pop("room_ids", None)
    if room_ids is None and "room_id" in data:
        room_ids = [data["room_id"]] if data["room_id"] is not None else []
    if room_ids is not None:
        room_ids = _validated_room_ids(session, schedule, room_ids)
        data["room_id"] = room_ids[0] if room_ids else None
    if data.get("title") is None and "title" in data:
        raise HTTPException(status_code=422, detail="Title is required")
    merged = {
        "title": row.title,
        "instructors": row.instructors,
        "description": row.description,
        "start": row.start,
        "end": row.end,
        "room_id": row.room_id,
        "venue_id": row.venue_id,
        "level_id": row.level_id,
        "activity_type_id": row.activity_type_id,
        "attendee_note": row.attendee_note,
        "allow_plan": row.allow_plan,
        "is_cancelled": row.is_cancelled,
        **data,
    }
    merged = _validated_session_data(session, schedule, merged)
    _apply(row, merged)
    row.updated_at = datetime.now(timezone.utc)
    session.add(row)
    if room_ids is not None:
        replace_session_rooms(session, row, room_ids)
    if assignments is not None:
        _replace_session_contributors(session, schedule, row, assignments)
    session.commit()
    session.refresh(row)
    return _session_response(session, row)


@admin_router.delete("/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_session(
    event_id: str, session_id: UUID, session: Session = Depends(get_session)
):
    schedule = _schedule_for_event(session, event_id)
    row = session.get(ScheduleSession, session_id)
    if row is None or row.schedule_id != schedule.id or row.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Session not found")
    row.deleted_at = datetime.now(timezone.utc)
    row.updated_at = datetime.now(timezone.utc)
    session.add(row)
    session.commit()


@admin_router.post(
    "/sessions/{session_id}/duplicate",
    response_model=ScheduleSessionResponse,
    status_code=status.HTTP_201_CREATED,
)
def duplicate_session(
    event_id: str, session_id: UUID, session: Session = Depends(get_session)
):
    schedule = _schedule_for_event(session, event_id)
    source = session.get(ScheduleSession, session_id)
    if (
        source is None
        or source.schedule_id != schedule.id
        or source.deleted_at is not None
    ):
        raise HTTPException(status_code=404, detail="Session not found")
    source_assignments = _session_contributors(session, source.id)
    data = _session_response(session, source)
    data.pop("id")
    data.pop("external_id")
    data.pop("contributors")
    room_ids = data.pop("room_ids")
    data["title"] = f"{source.title} (copy)"
    data["start"] = source.start
    data["end"] = source.end
    row = ScheduleSession(schedule_id=schedule.id, **data)
    session.add(row)
    session.flush()
    replace_session_rooms(session, row, room_ids)
    _replace_session_contributors(
        session,
        schedule,
        row,
        [
            {"contributor_id": item.contributor_id, "role": item.role}
            for item in source_assignments
        ],
    )
    session.commit()
    session.refresh(row)
    return _session_response(session, row)


def _overview_item_for_schedule(
    session: Session, schedule: EventSchedule, item_id: UUID
) -> ScheduleOverviewItem:
    row = session.get(ScheduleOverviewItem, item_id)
    if row is None or row.schedule_id != schedule.id:
        raise HTTPException(status_code=404, detail="Overview item not found")
    return row


def _validated_overview_data(
    session: Session,
    schedule: EventSchedule,
    data: dict,
    item_id: UUID | None = None,
) -> dict:
    data["start"] = to_utc(data["start"])
    data["end"] = to_utc(data["end"])
    if data["end"] <= data["start"]:
        raise HTTPException(status_code=422, detail="End time must be after start time")
    _validated_reference(session, ScheduleVenue, data.get("venue_id"), schedule.id)
    _validated_reference(
        session, ScheduleActivityType, data.get("activity_type_id"), schedule.id
    )
    parent_id = data.get("parent_id")
    if parent_id is not None:
        parent = _overview_item_for_schedule(session, schedule, parent_id)
        if parent.parent_id is not None or parent.id == item_id:
            raise HTTPException(
                status_code=422, detail="Moments can only be nested one level deep"
            )
        if (
            item_id is not None
            and session.exec(
                select(ScheduleOverviewItem.id).where(
                    ScheduleOverviewItem.parent_id == item_id
                )
            ).first()
        ):
            raise HTTPException(
                status_code=422, detail="An item with moments cannot become a moment"
            )
    return data


def _overview_item_response(session: Session, row: ScheduleOverviewItem) -> dict:
    return overview_item_snapshot(
        row, overview_room_ids_by_item(session, [row.id]).get(row.id)
    )


@admin_router.post(
    "/overview-items",
    response_model=ScheduleOverviewItemResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_overview_item(
    event_id: str,
    body: ScheduleOverviewItemRequest,
    session: Session = Depends(get_session),
):
    schedule = _schedule_for_event(session, event_id)
    data = body.model_dump()
    room_ids = _validated_room_ids(session, schedule, data.pop("room_ids"))
    data = _validated_overview_data(session, schedule, data)
    row = ScheduleOverviewItem(schedule_id=schedule.id, **data)
    session.add(row)
    session.flush()
    replace_overview_item_rooms(session, row, room_ids)
    session.commit()
    session.refresh(row)
    return _overview_item_response(session, row)


@admin_router.put(
    "/overview-items/{item_id}", response_model=ScheduleOverviewItemResponse
)
def update_overview_item(
    event_id: str,
    item_id: UUID,
    body: ScheduleOverviewItemRequest,
    session: Session = Depends(get_session),
):
    schedule = _schedule_for_event(session, event_id)
    row = _overview_item_for_schedule(session, schedule, item_id)
    data = body.model_dump()
    room_ids = _validated_room_ids(session, schedule, data.pop("room_ids"))
    data = _validated_overview_data(session, schedule, data, item_id=row.id)
    _apply(row, data)
    row.updated_at = datetime.now(timezone.utc)
    session.add(row)
    replace_overview_item_rooms(session, row, room_ids)
    session.commit()
    session.refresh(row)
    return _overview_item_response(session, row)


@admin_router.delete(
    "/overview-items/{item_id}", status_code=status.HTTP_204_NO_CONTENT
)
def remove_overview_item(
    event_id: str, item_id: UUID, session: Session = Depends(get_session)
):
    schedule = _schedule_for_event(session, event_id)
    row = _overview_item_for_schedule(session, schedule, item_id)
    delete_overview_item(session, row)
    session.commit()


@admin_router.get("/issues")
def get_schedule_issues(event_id: str, session: Session = Depends(get_session)):
    schedule = _schedule_for_event(session, event_id)
    return {"issues": compute_issues(session, schedule)}


@admin_router.get("/diff")
def get_schedule_diff(event_id: str, session: Session = Depends(get_session)):
    schedule = _schedule_for_event(session, event_id)
    publication = latest_publication(session, schedule.id)
    return compute_diff(
        build_snapshot(session, schedule), publication.snapshot if publication else None
    )


@admin_router.post("/revert-change", response_model=AdminEventScheduleResponse)
def revert_schedule_change(
    event_id: str, body: ScheduleChangeRef, session: Session = Depends(get_session)
):
    schedule = _schedule_for_event(session, event_id)
    publication = latest_publication(session, schedule.id)
    if publication is None:
        raise HTTPException(status_code=409, detail="Nothing published to revert to")
    current = next(
        (
            change
            for change in compute_diff(
                build_snapshot(session, schedule), publication.snapshot
            )["changes"]
            if change["entity_type"] == body.entity_type
            and change["entity_id"] == body.entity_id
            and change["operation"] == body.operation
        ),
        None,
    )
    if current is None or current["fields"] != [
        field.model_dump() for field in body.fields
    ]:
        raise HTTPException(status_code=409, detail=_STALE_CHANGE)
    _revert_entity(
        session,
        schedule,
        publication.snapshot,
        body.entity_type,
        body.entity_id,
        body.operation,
    )
    session.commit()
    return _admin_payload(session, schedule)


@admin_router.get("/import-schema")
def get_schedule_import_schema(event_id: str, session: Session = Depends(get_session)):
    schedule = _schedule_for_event(session, event_id)
    return {
        "schema": ScheduleImportDocument.model_json_schema(),
        "example": build_schedule_import_example(schedule),
    }


@admin_router.get("/planners", response_model=list[SchedulePlannerResponse])
def get_schedule_planners(event_id: str, session: Session = Depends(get_session)):
    schedule = _schedule_for_event(session, event_id)
    publication = latest_publication(session, schedule.id)
    current_sessions = {
        row["id"]: row
        for key in ("sessions", "overview_items")
        for row in (publication.snapshot.get(key, []) if publication else [])
    }
    plans = session.exec(
        select(UserPlanSession).where(UserPlanSession.event_id == event_id)
    ).all()
    if not plans:
        return []
    user_ids = {plan.user_id for plan in plans}
    users = session.exec(
        select(User).where(User.id.in_(user_ids), User.deleted_at.is_(None))
    ).all()
    going_ids = set(
        session.exec(
            select(UserEventAttendance.user_id).where(
                UserEventAttendance.event_id == event_id,
                UserEventAttendance.user_id.in_(user_ids),
            )
        ).all()
    )
    plans_by_user: dict[UUID, list[UserPlanSession]] = {}
    for plan in plans:
        plans_by_user.setdefault(plan.user_id, []).append(plan)
    return sorted(
        [
            SchedulePlannerResponse(
                user_id=user.id,
                email=user.email,
                name=user.display_name,
                handle=user.handle,
                going=user.id in going_ids,
                planned_session_count=len(plans_by_user[user.id]),
                sessions=[
                    {
                        "session_id": plan.session_id,
                        "overview_item_id": plan.overview_item_id,
                        "title": current_sessions.get(
                            plan_target_id(plan), plan.last_known_session
                        ).get("title", "Session"),
                        "start": current_sessions.get(
                            plan_target_id(plan), plan.last_known_session
                        )["start"],
                        "end": current_sessions.get(
                            plan_target_id(plan), plan.last_known_session
                        )["end"],
                        "status": (
                            "removed"
                            if plan_target_id(plan) not in current_sessions
                            else "cancelled"
                            if current_sessions[plan_target_id(plan)].get(
                                "is_cancelled"
                            )
                            else "active"
                        ),
                    }
                    for plan in sorted(
                        plans_by_user[user.id],
                        key=lambda row: current_sessions.get(
                            plan_target_id(row), row.last_known_session
                        )["start"],
                    )
                ],
            )
            for user in users
        ],
        key=lambda planner: planner.email.casefold(),
    )


def _going_user_ids(session: Session, event_id: str, user_ids=None) -> set:
    statement = select(UserEventAttendance.user_id).where(
        UserEventAttendance.event_id == event_id,
        UserEventAttendance.user_id.is_not(None),
    )
    if user_ids is not None:
        statement = statement.where(UserEventAttendance.user_id.in_(user_ids))
    return set(session.exec(statement).all())


def _plan_user_ids(session: Session, event_id: str, user_ids=None) -> set:
    statement = select(UserPlanSession.user_id).where(
        UserPlanSession.event_id == event_id
    )
    if user_ids is not None:
        statement = statement.where(UserPlanSession.user_id.in_(user_ids))
    return set(session.exec(statement).all())


@admin_router.get(
    "/notify-program-candidates", response_model=list[ScheduleProgramCandidate]
)
def get_program_notification_candidates(
    event_id: str, session: Session = Depends(get_session)
):
    _schedule_for_event(session, event_id)
    going_ids = _going_user_ids(session, event_id)
    plan_ids = _plan_user_ids(session, event_id)
    attendee_ids = going_ids | plan_ids
    if not attendee_ids:
        return []
    users = session.exec(
        select(User).where(User.id.in_(attendee_ids), User.deleted_at.is_(None))
    ).all()
    push_ids = set(
        session.exec(
            select(PushSubscription.user_id).where(
                PushSubscription.user_id.in_(attendee_ids)
            )
        ).all()
    )
    notified_ids = set(
        session.exec(
            select(Notification.recipient_user_id).where(
                Notification.kind == "schedule_program_available",
                Notification.event_id == event_id,
                Notification.recipient_user_id.in_(attendee_ids),
            )
        ).all()
    )
    return sorted(
        [
            ScheduleProgramCandidate(
                user_id=user.id,
                email=user.email,
                name=user.display_name,
                handle=user.handle,
                email_enabled=user.email_schedule_updates_enabled,
                push_enabled=user.push_schedule_updates_enabled,
                has_push_subscription=user.id in push_ids,
                already_notified=user.id in notified_ids,
                is_going=user.id in going_ids,
                has_plan=user.id in plan_ids,
            )
            for user in users
        ],
        key=lambda candidate: candidate.email.casefold(),
    )


@admin_router.post("/notify-program", response_model=ScheduleProgramNotifyResponse)
def notify_program_available(
    event_id: str,
    body: ScheduleProgramNotifyRequest,
    session: Session = Depends(get_session),
):
    from backend.services.email import send_schedule_program_available_email
    from backend.services.notification_delivery import record_delivery
    from backend.services.push_service import send_push

    schedule = _schedule_for_event(session, event_id)
    publication = latest_publication(session, schedule.id)
    if publication is None:
        raise HTTPException(
            status_code=409, detail="Publish the program before notifying attendees"
        )
    if schedule.unpublished_at is not None and body.reason != "under_work":
        raise HTTPException(
            status_code=409, detail="Republish the program before notifying attendees"
        )
    if schedule.unpublished_at is None and body.reason == "under_work":
        raise HTTPException(
            status_code=409,
            detail="Unpublish the program before sending an under-work notice",
        )
    event = session.get(CachedEvent, event_id)
    if event is None or event.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Event not found")

    users = {
        user.id: user
        for user in session.exec(select(User).where(User.id.in_(body.user_ids))).all()
    }
    attendee_ids = _going_user_ids(session, event_id, body.user_ids) | _plan_user_ids(
        session, event_id, body.user_ids
    )
    push_ids = set(
        session.exec(
            select(PushSubscription.user_id).where(
                PushSubscription.user_id.in_(body.user_ids)
            )
        ).all()
    )
    reason = body.reason
    kind = (
        "schedule_program_updated"
        if reason and reason != "available"
        else "schedule_program_available"
    )
    existing = (
        {}
        if reason
        else {
            row.recipient_user_id: row
            for row in session.exec(
                select(Notification).where(
                    Notification.kind == "schedule_program_available",
                    Notification.event_id == event_id,
                    Notification.recipient_user_id.in_(body.user_ids),
                )
            ).all()
        }
    )
    # Planners whose sessions changed in this publication already got "Your plan changed".
    impacted_ids = (
        set(
            session.exec(
                select(Notification.recipient_user_id).where(
                    Notification.kind == "planned_session_changed",
                    Notification.event_id == event_id,
                    Notification.subject_key == f"publication:{publication.version}",
                    Notification.recipient_user_id.in_(body.user_ids),
                )
            ).all()
        )
        if reason in ("available", "updated")
        else set()
    )
    session_count = len(publication.snapshot.get("sessions", []))
    headline = (body.title or "").strip() or None
    note = (body.message or "").strip() or None
    if reason:
        headline = headline or _NOTIFY_REASON_TITLES[reason]
    description = note or _NOTIFY_REASON_MESSAGES.get(
        reason or "available", _NOTIFY_REASON_MESSAGES["available"]
    )
    stamp_now = datetime.now(timezone.utc)
    subject_key = f"notify:{reason}:{stamp_now:%Y%m%dT%H%M%S%f}" if reason else None
    program_live = reason != "under_work"
    emailed = pushed = in_app_created = 0
    results: list[ScheduleProgramNotifyResult] = []

    for user_id in body.user_ids:
        user = users.get(user_id)
        if user is None or user.deleted_at is not None:
            results.append(
                ScheduleProgramNotifyResult(
                    user_id=user_id,
                    email="",
                    status="skipped_not_found",
                    email_status="not_attempted",
                    push_status="not_attempted",
                )
            )
            continue
        if user_id not in attendee_ids or user_id in impacted_ids:
            results.append(
                ScheduleProgramNotifyResult(
                    user_id=user_id,
                    email=user.email,
                    status=(
                        "skipped_plan_changed"
                        if user_id in impacted_ids
                        else "skipped_not_in_audience"
                    ),
                    email_status="not_attempted",
                    push_status="not_attempted",
                )
            )
            continue

        notification = existing.get(user_id)
        created = notification is None
        if notification is None:
            notification = Notification(
                recipient_user_id=user_id,
                actor_user_id=user_id,
                kind=kind,
                event_id=event_id,
                subject_key=subject_key,
                context=headline if reason else str(session_count),
                description=description,
            )
            session.add(notification)
            session.flush()
            record_delivery(session, notification.id, "app", stamp_now)
            in_app_created += 1

        did_send = False
        notification.description = description
        if not user.email_schedule_updates_enabled:
            email_status = "disabled"
        elif notification.emailed_at is not None and not body.resend:
            email_status = "already_sent"
        elif (
            send_schedule_program_available_email(
                user,
                event,
                session_count,
                headline=headline,
                note=description,
                program_live=program_live,
            )
            if reason
            else send_schedule_program_available_email(
                user, event, session_count, headline=headline, note=note
            )
        ):
            notification.emailed_at = stamp_now
            record_delivery(
                session,
                notification.id,
                "email",
                stamp_now,
                mode="instant",
                source="admin",
            )
            emailed += 1
            did_send = True
            email_status = "sent"
        else:
            email_status = "failed"

        if not user.push_schedule_updates_enabled:
            push_status = "disabled"
        elif user_id not in push_ids:
            push_status = "unavailable"
        elif notification.pushed_at is not None and not body.resend:
            push_status = "already_sent"
        else:
            delivered = send_push(
                user_id,
                title=f"{headline or 'Program now available'} · {event.title}",
                body=(description if reason else note)
                or "The program is live. Build your plan.",
                url=(
                    f"/event/{event_id}/program"
                    if program_live
                    else f"/event/{event_id}"
                ),
                tag=f"schedule-program:{event_id}",
            )
            if delivered:
                notification.pushed_at = stamp_now
                record_delivery(
                    session, notification.id, "push", stamp_now, source="admin"
                )
                pushed += delivered
                did_send = True
                push_status = "sent"
            else:
                push_status = "unavailable"
        session.add(notification)
        results.append(
            ScheduleProgramNotifyResult(
                user_id=user_id,
                email=user.email,
                status="sent" if created or did_send else "already_sent",
                email_status=email_status,
                push_status=push_status,
            )
        )
    session.commit()
    return ScheduleProgramNotifyResponse(
        emailed=emailed,
        pushed=pushed,
        in_app_created=in_app_created,
        results=results,
    )


@admin_router.get("/export", response_model=ScheduleImportDocument)
def export_schedule(event_id: str, session: Session = Depends(get_session)):
    return export_schedule_document(session, _schedule_for_event(session, event_id))


@admin_router.get("/published-export", response_model=ProgramExportResponse)
@limiter.limit("10/minute")
def get_published_export(
    event_id: str,
    request: Request,
    days: list[str] | None = Query(default=None),
    include_cancelled: bool = True,
    instructor: str | None = None,
    contributor_ids: list[int] | None = Query(default=None),
    level_ids: list[int] | None = Query(default=None),
    activity_type_ids: list[int] | None = Query(default=None),
    session: Session = Depends(get_session),
):
    return _published_projection(
        session,
        event_id,
        days=days,
        include_cancelled=include_cancelled,
        instructor=instructor,
        contributor_ids=contributor_ids,
        level_ids=level_ids,
        activity_type_ids=activity_type_ids,
    )


@admin_router.get("/published-export/ics")
@limiter.limit("10/minute")
def export_published_schedule_ics(
    event_id: str,
    request: Request,
    days: list[str] | None = Query(default=None),
    include_cancelled: bool = True,
    instructor: str | None = None,
    contributor_ids: list[int] | None = Query(default=None),
    level_ids: list[int] | None = Query(default=None),
    activity_type_ids: list[int] | None = Query(default=None),
    session: Session = Depends(get_session),
):
    projection = _published_projection(
        session,
        event_id,
        days=days,
        include_cancelled=include_cancelled,
        instructor=instructor,
        contributor_ids=contributor_ids,
        level_ids=level_ids,
        activity_type_ids=activity_type_ids,
    )
    filename = _export_filename(projection["event_title"], event_id, "program.ics")
    return Response(
        render_program_ics(projection).encode("utf-8"),
        media_type="text/calendar; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@admin_router.get("/published-export/csv")
@limiter.limit("10/minute")
def export_published_schedule_csv(
    event_id: str,
    request: Request,
    days: list[str] | None = Query(default=None),
    include_cancelled: bool = True,
    instructor: str | None = None,
    contributor_ids: list[int] | None = Query(default=None),
    level_ids: list[int] | None = Query(default=None),
    activity_type_ids: list[int] | None = Query(default=None),
    session: Session = Depends(get_session),
):
    projection = _published_projection(
        session,
        event_id,
        days=days,
        include_cancelled=include_cancelled,
        instructor=instructor,
        contributor_ids=contributor_ids,
        level_ids=level_ids,
        activity_type_ids=activity_type_ids,
    )
    filename = _export_filename(projection["event_title"], event_id, "program.csv")
    return Response(
        render_program_csv(projection),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@admin_router.post("/import-preview", response_model=ScheduleImportPreviewResponse)
def preview_schedule_import(
    event_id: str,
    request: ScheduleImportRequest,
    session: Session = Depends(get_session),
):
    result = _import_result(session, _schedule_for_event(session, event_id), request)
    session.rollback()
    return result


@admin_router.post("/import", response_model=ScheduleImportPreviewResponse)
def import_schedule(
    event_id: str,
    request: ScheduleImportRequest,
    session: Session = Depends(get_session),
):
    result = _import_result(session, _schedule_for_event(session, event_id), request)
    session.commit()
    return result


@admin_router.get("/publish-preview", response_model=SchedulePublishPreviewResponse)
def preview_publish(event_id: str, session: Session = Depends(get_session)):
    schedule = _schedule_for_event(session, event_id)
    latest = latest_publication(session, schedule.id)
    if latest is None:
        return SchedulePublishPreviewResponse(impacted_user_ids=[])
    changes = planned_session_changes(
        session, event_id, latest.snapshot, build_snapshot(session, schedule)
    )
    sample = next(iter(changes.values()), None)
    return SchedulePublishPreviewResponse(
        impacted_user_ids=list(changes),
        sample_message=planned_change_description(sample) if sample else None,
    )


@admin_router.post("/publish", response_model=SchedulePublishResponse)
def publish_schedule(
    event_id: str,
    body: SchedulePublishRequest = SchedulePublishRequest(),
    editor: User = Depends(require_schedule_editor),
    session: Session = Depends(get_session),
):
    schedule = _schedule_for_event(session, event_id)
    latest = latest_publication(session, schedule.id)
    version = 1 if latest is None else latest.version + 1
    published_at = datetime.now(timezone.utc)
    snapshot = build_snapshot(session, schedule)
    snapshot["version"] = version
    snapshot["published_at"] = published_at.isoformat()
    publication = SchedulePublication(
        schedule_id=schedule.id,
        version=version,
        snapshot=snapshot,
        published_at=published_at,
        published_by_user_id=editor.id,
    )
    session.add(publication)
    # Publishing a new version always makes the program live again.
    schedule.unpublished_at = None
    session.add(schedule)
    impacted_notifications = []
    if latest is not None:
        impacted_notifications = notify_planned_session_changes(
            session,
            editor,
            event_id,
            version,
            latest.snapshot,
            snapshot,
            notify=body.notify_impacted_planners,
        )
    session.commit()

    going_ids = set(
        session.exec(
            select(UserEventAttendance.user_id).where(
                UserEventAttendance.event_id == event_id,
                UserEventAttendance.user_id.is_not(None),
            )
        ).all()
    )
    broad_result = ScheduleProgramNotifyResponse(
        emailed=0, pushed=0, in_app_created=0, results=[]
    )
    if body.auto_announce and (version == 1 or body.notify_all_going):
        broad_result = _notify_publication_going_attendees(
            event_id, version, session, deliver=False
        )
    if impacted_notifications or broad_result.results:
        job_queue.enqueue(PUBLICATION_DELIVERY_JOB, f"{event_id}:{version}")
    snapshot["notification_summary"] = {
        "impacted_planners": len(
            {notification.recipient_user_id for notification in impacted_notifications}
        ),
        "going_attendees_notified": len(broad_result.results),
        "in_app_created": len(impacted_notifications) + broad_result.in_app_created,
        "going_attendees": len(going_ids),
    }
    return snapshot


@admin_router.post("/unpublish")
def unpublish_schedule(
    event_id: str,
    session: Session = Depends(get_session),
):
    """Hide the public program. Publications are kept; republish restores them."""
    schedule = _schedule_for_event(session, event_id)
    if latest_publication(session, schedule.id) is None:
        raise HTTPException(status_code=409, detail="Nothing published to unpublish")
    if schedule.unpublished_at is None:
        now = datetime.now(timezone.utc)
        schedule.unpublished_at = now
        schedule.updated_at = now
        session.add(schedule)
        session.commit()
    return {"unpublished_at": schedule.unpublished_at}


@admin_router.post("/republish")
def republish_schedule(
    event_id: str,
    session: Session = Depends(get_session),
):
    """Make the latest publication public again without creating a new version."""
    schedule = _schedule_for_event(session, event_id)
    if latest_publication(session, schedule.id) is None:
        raise HTTPException(
            status_code=409, detail="Publish the program before republishing"
        )
    if schedule.unpublished_at is not None:
        schedule.unpublished_at = None
        schedule.updated_at = datetime.now(timezone.utc)
        session.add(schedule)
        session.commit()
    return {"unpublished_at": None}


def _deliver_publication(key: str) -> None:
    """Job: email/push one publication's not-yet-delivered rows (My Plan
    changes and Going announcements). Channels already stamped are skipped."""
    from backend.db.database import get_engine
    from backend.services.email import (
        send_schedule_plan_changed_email,
        send_schedule_program_available_email,
        send_schedule_program_updated_email,
    )
    from backend.services.notification_delivery import record_delivery
    from backend.services.push_service import send_push

    event_id, _, version = key.rpartition(":")
    with Session(get_engine()) as session:
        event = session.get(CachedEvent, event_id)
        if event is None or event.deleted_at is not None:
            return
        rows = session.exec(
            select(Notification)
            .where(
                Notification.event_id == event_id,
                Notification.subject_key == f"publication:{version}",
                Notification.kind.in_(_PUBLICATION_KINDS),
                Notification.emailed_at.is_(None) | Notification.pushed_at.is_(None),
            )
            .with_for_update(skip_locked=True, of=Notification)
        ).all()
        if not rows:
            return
        users = {
            user.id: user
            for user in session.exec(
                select(User).where(
                    User.id.in_({row.recipient_user_id for row in rows}),
                    User.deleted_at.is_(None),
                )
            ).all()
        }
        for notification in rows:
            user = users.get(notification.recipient_user_id)
            if user is None:
                continue
            kind = notification.kind
            if notification.emailed_at is None and user.email_schedule_updates_enabled:
                try:
                    if kind == "planned_session_changed":
                        sent = send_schedule_plan_changed_email(
                            user,
                            event,
                            notification.description or "The program changed.",
                        )
                    elif kind == "schedule_program_available":
                        sent = send_schedule_program_available_email(
                            user, event, int(notification.context or 0)
                        )
                    else:
                        sent = send_schedule_program_updated_email(user, event)
                except Exception:
                    logger.exception(
                        "Could not email publication %s to user %s", version, user.id
                    )
                    sent = False
                if sent:
                    now = datetime.now(timezone.utc)
                    notification.emailed_at = now
                    record_delivery(
                        session,
                        notification.id,
                        "email",
                        now,
                        mode="instant",
                        source="job",
                    )
            if notification.pushed_at is None and user.push_schedule_updates_enabled:
                if kind == "planned_session_changed":
                    title = f"Your plan changed · {event.title}"
                    body = notification.description or "Review My Plan."
                    url = f"/event/{event_id}/program/plan"
                    tag = f"schedule-plan:{event_id}:{version}"
                elif kind == "schedule_program_available":
                    title = f"Program now available · {event.title}"
                    body = "The program is live. Build your plan."
                    url = f"/event/{event_id}/program"
                    tag = f"schedule-program:{event_id}:{version}"
                else:
                    title = f"Program updated · {event.title}"
                    body = "The program changed. Review the latest schedule."
                    url = f"/event/{event_id}/program"
                    tag = f"schedule-program:{event_id}:{version}"
                try:
                    delivered = send_push(
                        user.id, title=title, body=body, url=url, tag=tag
                    )
                except Exception:
                    logger.exception(
                        "Could not push publication %s to user %s", version, user.id
                    )
                    delivered = 0
                if delivered:
                    now = datetime.now(timezone.utc)
                    notification.pushed_at = now
                    record_delivery(session, notification.id, "push", now, source="job")
            session.add(notification)
        session.commit()


job_queue.register(PUBLICATION_DELIVERY_JOB, _deliver_publication)


def _notify_publication_going_attendees(
    event_id: str,
    version: int,
    session: Session,
    deliver: bool = True,
):
    from backend.services.email import (
        send_schedule_program_available_email,
        send_schedule_program_updated_email,
    )
    from backend.services.notification_delivery import record_delivery
    from backend.services.push_service import send_push

    schedule = _schedule_for_event(session, event_id)
    publication = session.exec(
        select(SchedulePublication).where(
            SchedulePublication.schedule_id == schedule.id,
            SchedulePublication.version == version,
        )
    ).first()
    if publication is None:
        raise HTTPException(status_code=404, detail="Publication not found")
    event = session.get(CachedEvent, event_id)
    if event is None or event.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Event not found")

    going_ids = set(
        session.exec(
            select(UserEventAttendance.user_id).where(
                UserEventAttendance.event_id == event_id,
                UserEventAttendance.user_id.is_not(None),
            )
        ).all()
    )
    impacted_ids = set(
        session.exec(
            select(Notification.recipient_user_id).where(
                Notification.kind == "planned_session_changed",
                Notification.event_id == event_id,
                Notification.subject_key == f"publication:{version}",
            )
        ).all()
    )
    recipient_ids = going_ids - impacted_ids
    users = (
        {
            user.id: user
            for user in session.exec(
                select(User).where(
                    User.id.in_(recipient_ids), User.deleted_at.is_(None)
                )
            ).all()
        }
        if recipient_ids
        else {}
    )
    kind = "schedule_program_available" if version == 1 else "schedule_program_updated"
    existing = (
        {
            row.recipient_user_id: row
            for row in session.exec(
                select(Notification).where(
                    Notification.kind == kind,
                    Notification.event_id == event_id,
                    Notification.subject_key == f"publication:{version}",
                    Notification.recipient_user_id.in_(recipient_ids),
                )
            ).all()
        }
        if recipient_ids
        else {}
    )
    delivered_at = datetime.now(timezone.utc)
    emailed = pushed = in_app_created = 0
    results: list[ScheduleProgramNotifyResult] = []
    session_count = len(publication.snapshot.get("sessions", []))

    for user_id in sorted(recipient_ids, key=str):
        user = users.get(user_id)
        if user is None:
            continue
        notification = existing.get(user_id)
        created = notification is None
        if notification is None:
            notification = Notification(
                recipient_user_id=user.id,
                actor_user_id=user.id,
                kind=kind,
                event_id=event_id,
                subject_key=f"publication:{version}",
                context=str(session_count),
                description=(
                    "The program is live. Browse sessions and build your plan."
                    if version == 1
                    else "The event program has changed. Review the latest schedule."
                ),
            )
            session.add(notification)
            session.flush()
            record_delivery(session, notification.id, "app", delivered_at)
            in_app_created += 1

        if not deliver:
            email_status = "queued"
        elif not user.email_schedule_updates_enabled:
            email_status = "disabled"
        elif notification.emailed_at is not None:
            email_status = "already_sent"
        else:
            try:
                sent = (
                    send_schedule_program_available_email(user, event, session_count)
                    if version == 1
                    else send_schedule_program_updated_email(user, event)
                )
            except Exception:
                logger.exception(
                    "Could not email publication %s to user %s", version, user.id
                )
                sent = False
            if sent:
                notification.emailed_at = delivered_at
                record_delivery(
                    session,
                    notification.id,
                    "email",
                    delivered_at,
                    mode="instant",
                    source="admin",
                )
                emailed += 1
                email_status = "sent"
            else:
                email_status = "failed"

        if not deliver:
            push_status = "queued"
        elif not user.push_schedule_updates_enabled:
            push_status = "disabled"
        elif notification.pushed_at is not None:
            push_status = "already_sent"
        else:
            try:
                delivered = send_push(
                    user.id,
                    title=(
                        "Program now available" if version == 1 else "Program updated"
                    )
                    + f" · {event.title}",
                    body=(
                        "The program is live. Build your plan."
                        if version == 1
                        else "The program changed. Review the latest schedule."
                    ),
                    url=f"/event/{event_id}/program",
                    tag=f"schedule-program:{event_id}:{version}",
                )
            except Exception:
                logger.exception(
                    "Could not push publication %s to user %s", version, user.id
                )
                delivered = 0
            if delivered:
                notification.pushed_at = delivered_at
                record_delivery(
                    session, notification.id, "push", delivered_at, source="admin"
                )
                pushed += delivered
                push_status = "sent"
            else:
                push_status = "unavailable"
        session.add(notification)
        results.append(
            ScheduleProgramNotifyResult(
                user_id=user.id,
                email=user.email,
                status="sent"
                if created or email_status == "sent" or push_status == "sent"
                else "already_sent",
                email_status=email_status,
                push_status=push_status,
            )
        )
    session.commit()
    return ScheduleProgramNotifyResponse(
        emailed=emailed,
        pushed=pushed,
        in_app_created=in_app_created,
        results=results,
    )


@admin_router.post(
    "/publications/{version}/notify-going",
    response_model=ScheduleProgramNotifyResponse,
)
def notify_publication_going_attendees(
    event_id: str,
    version: int,
    session: Session = Depends(get_session),
):
    return _notify_publication_going_attendees(event_id, version, session)


def _save_config_row(session: Session, row):
    session.add(row)
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(
            status_code=409, detail="An item with this name already exists"
        ) from exc
    session.refresh(row)
    return row


def _delete_config_row(session: Session, row) -> None:
    session.delete(row)
    session.commit()


def _delete_if_unused(session: Session, row, reference) -> None:
    if session.exec(
        select(ScheduleSession).where(reference, ScheduleSession.deleted_at.is_(None))
    ).first():
        raise HTTPException(
            status_code=409, detail="Item is used by one or more sessions"
        )
    _delete_config_row(session, row)


def _apply(row, data: dict) -> None:
    for key, value in data.items():
        setattr(row, key, value)


def _validated_session_data(
    session: Session, schedule: EventSchedule, data: dict
) -> dict:
    data["start"] = to_utc(data["start"])
    data["end"] = to_utc(data["end"])
    if data["end"] <= data["start"]:
        raise HTTPException(status_code=422, detail="End time must be after start time")
    for key, model in (
        ("room_id", ScheduleRoom),
        ("venue_id", ScheduleVenue),
        ("level_id", ScheduleLevel),
        ("activity_type_id", ScheduleActivityType),
    ):
        _validated_reference(session, model, data.get(key), schedule.id)
    return data


def _session_contributors(
    session: Session, session_id: UUID
) -> list[ScheduleSessionContributor]:
    return list(
        session.exec(
            select(ScheduleSessionContributor)
            .where(ScheduleSessionContributor.session_id == session_id)
            .order_by(ScheduleSessionContributor.position)
        ).all()
    )


def _session_response(session: Session, row: ScheduleSession) -> dict:
    return session_snapshot(
        row,
        _session_contributors(session, row.id),
        session_room_ids_by_session(session, [row.id]).get(row.id),
    )


def _validated_room_ids(
    session: Session, schedule: EventSchedule, room_ids: list[int]
) -> list[int]:
    ordered = ordered_room_ids(session, schedule.id, room_ids)
    if ordered is None:
        raise HTTPException(status_code=422, detail="Unknown room")
    return ordered


def _replace_session_contributors(
    session: Session,
    schedule: EventSchedule,
    row: ScheduleSession,
    assignments: list[dict],
) -> None:
    keys = [(item["contributor_id"], item["role"]) for item in assignments]
    if len(keys) != len(set(keys)):
        raise HTTPException(status_code=422, detail="Duplicate session contributor")
    contributors = {}
    if keys:
        contributors = {
            contributor.id: contributor
            for contributor in session.exec(
                select(ScheduleContributor).where(
                    ScheduleContributor.id.in_([key[0] for key in keys]),
                    ScheduleContributor.schedule_id == schedule.id,
                )
            ).all()
        }
    if len(contributors) != len({key[0] for key in keys}):
        raise HTTPException(status_code=422, detail="Unknown contributor")
    for existing in _session_contributors(session, row.id):
        session.delete(existing)
    session.flush()
    for position, item in enumerate(assignments):
        session.add(
            ScheduleSessionContributor(
                session_id=row.id,
                contributor_id=item["contributor_id"],
                role=item["role"],
                position=position,
            )
        )
    instructor_names = [
        contributors[item["contributor_id"]].display_name
        for item in assignments
        if item["role"] == "instructor"
    ]
    row.instructors = " & ".join(instructor_names) or None
