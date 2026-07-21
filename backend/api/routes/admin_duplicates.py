"""Admin near-duplicate event detection & review.

Manual actions ("Scan now", "Flag as duplicates", "Keep", "Not a
duplicate") are always available. Automatic detection on sync/edit is
gated by the ``duplicate_auto_detect_enabled`` site setting, enforced
inside ``backend.services.duplicate_detection.maybe_detect_duplicates_for_event``
(not by this router).
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlmodel import Session, select

from backend.api.deps import require_admin
from backend.api.routes.admin import _is_event_blocked
from backend.api.schemas import (
    DuplicateEventSummary,
    DuplicateGroupListResponse,
    DuplicateGroupResponse,
    DuplicateKeepRequest,
    DuplicateScanLogEntry,
    DuplicateScanLogListResponse,
    ManualDuplicateGroupRequest,
)
from backend.db.database import get_session
from backend.db.models import (
    CachedEvent,
    EventDuplicateGroup,
    EventDuplicateMember,
    EventDuplicateScanLog,
)
from backend.services.duplicate_detection import (
    create_manual_group,
    dismiss_group,
    get_groups_for_event,
    keep_event,
    run_full_scan,
)

router = APIRouter(prefix="/api/admin", tags=["admin-duplicates"])


def _event_summary(session: Session, event_id: str) -> Optional[DuplicateEventSummary]:
    event = session.get(CachedEvent, event_id)
    if event is None:
        return None
    return DuplicateEventSummary(
        event_id=event.event_id,
        title=event.title,
        start=event.start,
        end=event.end,
        calendar_id=event.calendar_id,
        is_hidden=event.is_hidden,
        is_blocked=_is_event_blocked(session, event.event_id),
        rejected_duplicate_reason=event.rejected_duplicate_reason,
    )


def _group_to_response(
    session: Session, group: EventDuplicateGroup
) -> DuplicateGroupResponse:
    members = session.exec(
        select(EventDuplicateMember).where(EventDuplicateMember.group_id == group.id)
    ).all()
    events = [
        summary
        for summary in (_event_summary(session, member.event_id) for member in members)
        if summary is not None
    ]
    return DuplicateGroupResponse(
        id=group.id,
        status=group.status,
        source=group.source,
        kept_event_id=group.kept_event_id,
        created_at=group.created_at,
        resolved_at=group.resolved_at,
        events=events,
    )


@router.get("/duplicates", response_model=DuplicateGroupListResponse)
def list_duplicate_groups(
    status: str = Query("pending"),
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    stmt = select(EventDuplicateGroup).order_by(EventDuplicateGroup.created_at.desc())
    if status != "all":
        stmt = stmt.where(EventDuplicateGroup.status == status)
    groups = session.exec(stmt).all()
    items = [_group_to_response(session, group) for group in groups]
    return DuplicateGroupListResponse(items=items, total=len(items))


@router.get("/duplicates/history", response_model=DuplicateScanLogListResponse)
def list_duplicate_scan_history(
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    rows = session.exec(
        select(EventDuplicateScanLog)
        .order_by(EventDuplicateScanLog.started_at.desc())
        .limit(50)
    ).all()
    items = [
        DuplicateScanLogEntry(
            id=row.id,
            scan_type=row.scan_type,
            triggered_by_event_id=row.triggered_by_event_id,
            started_at=row.started_at,
            finished_at=row.finished_at,
            candidates_found=row.candidates_found,
            groups_created=row.groups_created,
            status=row.status,
        )
        for row in rows
    ]
    return DuplicateScanLogListResponse(items=items, total=len(items))


@router.post("/duplicates/scan", response_model=DuplicateScanLogEntry)
def trigger_duplicate_scan(
    session: Session = Depends(get_session),
    admin: dict = Depends(require_admin),
):
    log = run_full_scan(session, triggered_by_admin=admin.get("email"))
    return DuplicateScanLogEntry(
        id=log.id,
        scan_type=log.scan_type,
        triggered_by_event_id=log.triggered_by_event_id,
        started_at=log.started_at,
        finished_at=log.finished_at,
        candidates_found=log.candidates_found,
        groups_created=log.groups_created,
        status=log.status,
    )


@router.post("/duplicates/manual", response_model=DuplicateGroupResponse)
def flag_events_as_duplicates(
    body: ManualDuplicateGroupRequest,
    session: Session = Depends(get_session),
    admin: dict = Depends(require_admin),
):
    for event_id in body.event_ids:
        if session.get(CachedEvent, event_id) is None:
            raise HTTPException(status_code=404, detail=f"Event {event_id} not found")
    group = create_manual_group(
        session, body.event_ids, triggered_by_admin=admin.get("email")
    )
    return _group_to_response(session, group)


@router.post("/duplicates/{group_id}/keep", response_model=DuplicateGroupResponse)
def keep_duplicate_event(
    group_id: int,
    body: DuplicateKeepRequest,
    session: Session = Depends(get_session),
    admin: dict = Depends(require_admin),
):
    try:
        group = keep_event(
            session, group_id, body.keep_event_id, admin_email=admin.get("email")
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _group_to_response(session, group)


@router.post("/duplicates/{group_id}/dismiss", response_model=DuplicateGroupResponse)
def dismiss_duplicate_group(
    group_id: int,
    session: Session = Depends(get_session),
    admin: dict = Depends(require_admin),
):
    try:
        group = dismiss_group(session, group_id, admin_email=admin.get("email"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _group_to_response(session, group)


@router.get("/events/{event_id}/duplicates", response_model=DuplicateGroupListResponse)
def list_event_duplicate_candidates(
    event_id: str,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    groups = get_groups_for_event(session, event_id)
    items = [_group_to_response(session, group) for group in groups]
    return DuplicateGroupListResponse(items=items, total=len(items))
