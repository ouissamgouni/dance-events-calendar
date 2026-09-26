from datetime import datetime
import re
import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from slowapi import Limiter
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from backend.api.rate_limit import client_ip
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
    MyPlanEntryResponse,
    MyPlanResponse,
    ProgramExportResponse,
    ScheduleActivityTypeRequest,
    ScheduleActivityTypeResponse,
    ScheduleImportDocument,
    ScheduleImportPreviewResponse,
    ScheduleImportRequest,
    ScheduleProgramCandidate,
    ScheduleProgramNotifyRequest,
    ScheduleProgramNotifyResponse,
    ScheduleProgramNotifyResult,
    SchedulePlannerResponse,
    SchedulePublishRequest,
    SchedulePublishResponse,
    ScheduleLevelRequest,
    ScheduleLevelResponse,
    ScheduleRoomRequest,
    ScheduleRoomResponse,
    ScheduleSessionCreateRequest,
    ScheduleSessionResponse,
    ScheduleSessionUpdateRequest,
    ScheduleVenueRequest,
    ScheduleVenueResponse,
)
from backend.db.database import get_session
from backend.db.models import (
    CachedEvent,
    EventSchedule,
    EventScheduleEditor,
    Notification,
    PushSubscription,
    ScheduleActivityType,
    ScheduleLevel,
    SchedulePublication,
    ScheduleRoom,
    ScheduleSession,
    ScheduleVenue,
    User,
    UserEventAttendance,
    UserPlanSession,
)
from backend.services.schedules import (
    build_snapshot,
    compute_diff,
    compute_issues,
    default_schedule_days,
    latest_publication,
    seed_default_activity_types,
    seed_default_dance_levels,
    session_snapshot,
    to_utc_naive,
    validate_timezone,
)
from backend.services.schedule_import import (
    apply_import_document,
    build_schedule_import_example,
    export_schedule_document,
)
from backend.services.notifications import notify_planned_session_changes
from backend.services.program_exports import (
    build_program_projection,
    render_program_csv,
    render_program_ics,
)


logger = logging.getLogger(__name__)
limiter = Limiter(key_func=client_ip)


def _can_edit_schedule(session: Session, event_id: str, user: User | None) -> bool:
    if user is None:
        return False
    if is_admin_user(user):
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


public_router = APIRouter(
    prefix="/api/events/{event_id}",
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
    draft["published_at"] = publication.published_at if publication else None
    draft["issues"] = compute_issues(session, schedule)
    draft["diff"] = compute_diff(draft, publication.snapshot if publication else None)
    return draft


def _import_result(
    session: Session, schedule: EventSchedule, request: ScheduleImportRequest
) -> dict:
    try:
        result = apply_import_document(
            session, schedule, request.document, request.mode
        )
    except ValueError as exc:
        session.rollback()
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    publication = latest_publication(session, schedule.id)
    return {
        "document": export_schedule_document(session, schedule),
        "operations": {
            key: result[key] for key in ("created", "updated", "removed", "unchanged")
        },
        "issues": compute_issues(session, schedule),
        "diff": compute_diff(
            result["snapshot"], publication.snapshot if publication else None
        ),
    }


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
    "/schedule/editor-access", response_model=EventScheduleEditorAccessResponse
)
def get_schedule_editor_access(
    event_id: str,
    user: User | None = Depends(get_current_user_optional),
    session: Session = Depends(get_session),
):
    return {"can_edit": _can_edit_schedule(session, event_id, user)}


@public_router.get("/my-plan", response_model=MyPlanResponse)
def get_my_plan(
    event_id: str,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
):
    schedule = _schedule_for_event(session, event_id)
    publication = latest_publication(session, schedule.id)
    current = {
        row["id"]: row
        for row in (publication.snapshot.get("sessions", []) if publication else [])
    }
    rows = session.exec(
        select(UserPlanSession)
        .where(
            UserPlanSession.user_id == user.id,
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
    return {"entries": entries}


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
    current = {
        row["id"]: row for row in publication.snapshot.get("sessions", [])
    }
    plan_rows = session.exec(
        select(UserPlanSession)
        .where(
            UserPlanSession.user_id == user.id,
            UserPlanSession.event_id == event_id,
        )
        .order_by(UserPlanSession.added_at)
    ).all()
    selected_sessions = []
    for row in plan_rows:
        item = current.get(str(row.session_id))
        item_status = "removed"
        if item is not None:
            item_status = "cancelled" if item.get("is_cancelled") else "active"
        selected_sessions.append((item or row.last_known_session, item_status))
    projection = _published_projection(
        session,
        event_id,
        selected_sessions=selected_sessions,
    )
    filename = _export_filename(
        projection["event_title"], event_id, "my-plan.ics"
    )
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
    return [_editor_response(grant, user) for grant, user in rows]


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
    ):
        raise HTTPException(
            status_code=409, detail="Venue is used by rooms or sessions"
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
    _delete_if_unused(session, row, ScheduleSession.activity_type_id == row_id)


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
    data = _validated_session_data(session, schedule, body.model_dump())
    row = ScheduleSession(schedule_id=schedule.id, **data)
    session.add(row)
    session.commit()
    session.refresh(row)
    return session_snapshot(row)


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
    if data.get("title") is None and "title" in data:
        raise HTTPException(status_code=422, detail="Title is required")
    merged = {
        "title": row.title,
        "instructors": row.instructors,
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
    session.commit()
    session.refresh(row)
    return session_snapshot(row)


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
    data = session_snapshot(source)
    data.pop("id")
    data["title"] = f"{source.title} (copy)"
    data["start"] = source.start
    data["end"] = source.end
    row = ScheduleSession(schedule_id=schedule.id, **data)
    session.add(row)
    session.commit()
    session.refresh(row)
    return session_snapshot(row)


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
        for row in (publication.snapshot.get("sessions", []) if publication else [])
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
                        "title": current_sessions.get(
                            str(plan.session_id), plan.last_known_session
                        ).get("title", "Session"),
                        "start": current_sessions.get(
                            str(plan.session_id), plan.last_known_session
                        )["start"],
                        "end": current_sessions.get(
                            str(plan.session_id), plan.last_known_session
                        )["end"],
                        "status": (
                            "removed"
                            if str(plan.session_id) not in current_sessions
                            else "cancelled"
                            if current_sessions[str(plan.session_id)].get(
                                "is_cancelled"
                            )
                            else "active"
                        ),
                    }
                    for plan in sorted(
                        plans_by_user[user.id],
                        key=lambda row: current_sessions.get(
                            str(row.session_id), row.last_known_session
                        )["start"],
                    )
                ],
            )
            for user in users
        ],
        key=lambda planner: planner.email.casefold(),
    )


@admin_router.get(
    "/notify-program-candidates", response_model=list[ScheduleProgramCandidate]
)
def get_program_notification_candidates(
    event_id: str, session: Session = Depends(get_session)
):
    _schedule_for_event(session, event_id)
    attendee_ids = set(
        session.exec(
            select(UserEventAttendance.user_id).where(
                UserEventAttendance.event_id == event_id,
                UserEventAttendance.user_id.is_not(None),
            )
        ).all()
    )
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
    event = session.get(CachedEvent, event_id)
    if event is None or event.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Event not found")

    users = {
        user.id: user
        for user in session.exec(select(User).where(User.id.in_(body.user_ids))).all()
    }
    attendee_ids = set(
        session.exec(
            select(UserEventAttendance.user_id).where(
                UserEventAttendance.event_id == event_id,
                UserEventAttendance.user_id.in_(body.user_ids),
            )
        ).all()
    )
    push_ids = set(
        session.exec(
            select(PushSubscription.user_id).where(
                PushSubscription.user_id.in_(body.user_ids)
            )
        ).all()
    )
    existing = {
        row.recipient_user_id: row
        for row in session.exec(
            select(Notification).where(
                Notification.kind == "schedule_program_available",
                Notification.event_id == event_id,
                Notification.recipient_user_id.in_(body.user_ids),
            )
        ).all()
    }
    session_count = len(publication.snapshot.get("sessions", []))
    stamp_now = datetime.now(timezone.utc)
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
        if user_id not in attendee_ids:
            results.append(
                ScheduleProgramNotifyResult(
                    user_id=user_id,
                    email=user.email,
                    status="skipped_not_attending",
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
                kind="schedule_program_available",
                event_id=event_id,
                context=str(session_count),
                description="The program is live. Browse sessions and build your plan.",
            )
            session.add(notification)
            session.flush()
            record_delivery(session, notification.id, "app", stamp_now)
            in_app_created += 1

        did_send = False
        if not user.email_schedule_updates_enabled:
            email_status = "disabled"
        elif notification.emailed_at is not None and not body.resend:
            email_status = "already_sent"
        elif send_schedule_program_available_email(user, event, session_count):
            notification.emailed_at = stamp_now
            record_delivery(session, notification.id, "email", stamp_now)
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
                title="Program now available",
                body=f"The program for {event.title} is live. Build your plan.",
                url=f"/event/{event_id}/program",
                tag=f"schedule-program:{event_id}",
            )
            if delivered:
                notification.pushed_at = stamp_now
                record_delivery(session, notification.id, "push", stamp_now)
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
    session: Session = Depends(get_session),
):
    return _published_projection(
        session,
        event_id,
        days=days,
        include_cancelled=include_cancelled,
    )


@admin_router.get("/published-export/ics")
@limiter.limit("10/minute")
def export_published_schedule_ics(
    event_id: str,
    request: Request,
    days: list[str] | None = Query(default=None),
    include_cancelled: bool = True,
    session: Session = Depends(get_session),
):
    projection = _published_projection(
        session,
        event_id,
        days=days,
        include_cancelled=include_cancelled,
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
    session: Session = Depends(get_session),
):
    projection = _published_projection(
        session,
        event_id,
        days=days,
        include_cancelled=include_cancelled,
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
    impacted_notifications = []
    if latest is not None:
        impacted_notifications = notify_planned_session_changes(
            session,
            editor,
            event_id,
            version,
            latest.snapshot,
            snapshot,
        )
    session.commit()

    event = session.get(CachedEvent, event_id)
    impacted_user_ids = {
        notification.recipient_user_id for notification in impacted_notifications
    }
    users = (
        {
            user.id: user
            for user in session.exec(
                select(User).where(User.id.in_(impacted_user_ids))
            ).all()
        }
        if impacted_user_ids
        else {}
    )
    from backend.services.email import send_schedule_plan_changed_email
    from backend.services.push_service import send_push
    from backend.services.notification_delivery import record_delivery

    emailed = pushed = 0
    delivered_at = datetime.now(timezone.utc)
    if event is not None:
        for notification in impacted_notifications:
            user = users.get(notification.recipient_user_id)
            if user is None or user.deleted_at is not None:
                continue
            if user.email_schedule_updates_enabled:
                try:
                    if send_schedule_plan_changed_email(
                        user, event, notification.description or "The program changed."
                    ):
                        notification.emailed_at = delivered_at
                        record_delivery(session, notification.id, "email", delivered_at)
                        emailed += 1
                except Exception:
                    logger.exception(
                        "Could not email schedule update to user %s", user.id
                    )
            if user.push_schedule_updates_enabled:
                try:
                    delivered = send_push(
                        user.id,
                        title="Your plan changed",
                        body=f"The program for {event.title} changed. Review My Plan.",
                        url=f"/event/{event_id}/program/plan",
                        tag=f"schedule-plan:{event_id}:{version}",
                    )
                    if delivered:
                        notification.pushed_at = delivered_at
                        record_delivery(session, notification.id, "push", delivered_at)
                        pushed += delivered
                except Exception:
                    logger.exception(
                        "Could not push schedule update to user %s", user.id
                    )
            session.add(notification)
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
    if version == 1 or body.notify_all_going:
        broad_result = _notify_publication_going_attendees(event_id, version, session)
    snapshot["notification_summary"] = {
        "impacted_planners": len(impacted_user_ids),
        "going_attendees_notified": len(broad_result.results),
        "in_app_created": len(impacted_notifications) + broad_result.in_app_created,
        "emailed": emailed + broad_result.emailed,
        "pushed": pushed + broad_result.pushed,
        "going_attendees": len(going_ids),
    }
    return snapshot


def _notify_publication_going_attendees(
    event_id: str,
    version: int,
    session: Session,
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

        if not user.email_schedule_updates_enabled:
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
                record_delivery(session, notification.id, "email", delivered_at)
                emailed += 1
                email_status = "sent"
            else:
                email_status = "failed"

        if not user.push_schedule_updates_enabled:
            push_status = "disabled"
        elif notification.pushed_at is not None:
            push_status = "already_sent"
        else:
            try:
                delivered = send_push(
                    user.id,
                    title="Program now available"
                    if version == 1
                    else "Program updated",
                    body=(
                        f"The program for {event.title} is live. Build your plan."
                        if version == 1
                        else f"The program for {event.title} changed. Review the latest schedule."
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
                record_delivery(session, notification.id, "push", delivered_at)
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
    data["start"] = to_utc_naive(data["start"])
    data["end"] = to_utc_naive(data["end"])
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
