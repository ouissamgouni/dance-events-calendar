"""Admin event-series grouping & fuzzy-detection review.

Manual actions ("Scan now", "Group as series", "Approve", "Not a series",
"Split off") are always available. Automatic detection on sync/edit is
gated by the ``series_auto_detect_enabled`` site setting, enforced inside
``backend.services.series_detection.maybe_detect_series_for_event`` (not
by this router).

Unlike duplicate resolution, grouping events into a series never hides or
blocks any member — every occurrence stays independently visible.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func
from sqlmodel import Session, select

from backend.api.deps import require_admin
from backend.api.schemas import (
    ManualSeriesGroupRequest,
    SeriesAddMembersRequest,
    SeriesApproveRequest,
    SeriesEventSummary,
    SeriesGroupListResponse,
    SeriesGroupResponse,
    SeriesRenameRequest,
    SeriesScanLogEntry,
    SeriesScanLogListResponse,
    SeriesSplitRequest,
    SeriesSplitResponse,
)
from backend.db.database import get_session
from backend.db.models import (
    CachedEvent,
    EventSeries,
    EventSeriesMember,
    EventSeriesScanLog,
)
from backend.services.series_detection import (
    SeriesMembershipConflict,
    add_events_to_series,
    approve_series,
    create_manual_series,
    dismiss_series,
    get_series_for_event,
    rename_series,
    run_full_scan,
    split_member,
)

router = APIRouter(prefix="/api/admin", tags=["admin-series"])


def _event_summary(session: Session, event_id: str) -> Optional[SeriesEventSummary]:
    event = session.get(CachedEvent, event_id)
    if event is None:
        return None
    return SeriesEventSummary(
        event_id=event.event_id,
        title=event.title,
        start=event.start,
        end=event.end,
        calendar_id=event.calendar_id,
        location=event.location,
    )


def _series_to_response(session: Session, series: EventSeries) -> SeriesGroupResponse:
    members = session.exec(
        select(EventSeriesMember).where(EventSeriesMember.series_id == series.id)
    ).all()
    events = [
        summary
        for summary in (_event_summary(session, member.event_id) for member in members)
        if summary is not None
    ]
    events.sort(key=lambda e: e.start)
    return SeriesGroupResponse(
        id=series.id,
        status=series.status,
        source=series.source,
        canonical_title=series.canonical_title,
        created_at=series.created_at,
        resolved_at=series.resolved_at,
        events=events,
    )


def _conflict_detail(session: Session, exc: SeriesMembershipConflict) -> dict:
    conflicts = []
    for event_id, series_id in exc.conflicts.items():
        series = session.get(EventSeries, series_id)
        conflicts.append(
            {
                "event_id": event_id,
                "series_id": series_id,
                "series_title": series.canonical_title if series else "",
            }
        )
    return {
        "message": "One or more events already belong to a series.",
        "conflicts": conflicts,
    }


@router.get("/series", response_model=SeriesGroupListResponse)
def list_series_groups(
    status: str = Query("pending"),
    q: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    conditions = []
    if status != "all":
        conditions.append(EventSeries.status == status)
    if q:
        conditions.append(EventSeries.canonical_title.ilike(f"%{q.strip()}%"))

    count_stmt = select(func.count()).select_from(EventSeries)
    stmt = select(EventSeries).order_by(EventSeries.created_at.desc())
    for cond in conditions:
        count_stmt = count_stmt.where(cond)
        stmt = stmt.where(cond)
    total = session.exec(count_stmt).one()
    groups = session.exec(stmt.offset(offset).limit(limit)).all()
    items = [_series_to_response(session, group) for group in groups]
    return SeriesGroupListResponse(items=items, total=total)


@router.get("/series/history", response_model=SeriesScanLogListResponse)
def list_series_scan_history(
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    rows = session.exec(
        select(EventSeriesScanLog)
        .order_by(EventSeriesScanLog.started_at.desc())
        .limit(50)
    ).all()
    items = [
        SeriesScanLogEntry(
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
    return SeriesScanLogListResponse(items=items, total=len(items))


@router.post("/series/scan", response_model=SeriesScanLogEntry)
def trigger_series_scan(
    session: Session = Depends(get_session),
    admin: dict = Depends(require_admin),
):
    log = run_full_scan(session, triggered_by_admin=admin.get("email"))
    return SeriesScanLogEntry(
        id=log.id,
        scan_type=log.scan_type,
        triggered_by_event_id=log.triggered_by_event_id,
        started_at=log.started_at,
        finished_at=log.finished_at,
        candidates_found=log.candidates_found,
        groups_created=log.groups_created,
        status=log.status,
    )


@router.post("/series/manual", response_model=SeriesGroupResponse)
def group_events_as_series(
    body: ManualSeriesGroupRequest,
    session: Session = Depends(get_session),
    admin: dict = Depends(require_admin),
):
    for event_id in body.event_ids:
        if session.get(CachedEvent, event_id) is None:
            raise HTTPException(status_code=404, detail=f"Event {event_id} not found")
    try:
        series = create_manual_series(
            session,
            body.event_ids,
            canonical_title=body.canonical_title,
            triggered_by_admin=admin.get("email"),
        )
    except SeriesMembershipConflict as exc:
        raise HTTPException(
            status_code=409, detail=_conflict_detail(session, exc)
        ) from exc
    return _series_to_response(session, series)


@router.post("/series/{series_id}/add", response_model=SeriesGroupResponse)
def add_series_members(
    series_id: int,
    body: SeriesAddMembersRequest,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    for event_id in body.event_ids:
        if session.get(CachedEvent, event_id) is None:
            raise HTTPException(status_code=404, detail=f"Event {event_id} not found")
    try:
        series = add_events_to_series(session, series_id, body.event_ids)
    except SeriesMembershipConflict as exc:
        raise HTTPException(
            status_code=409, detail=_conflict_detail(session, exc)
        ) from exc
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return _series_to_response(session, series)


@router.patch("/series/{series_id}", response_model=SeriesGroupResponse)
def rename_series_group(
    series_id: int,
    body: SeriesRenameRequest,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    try:
        series = rename_series(session, series_id, body.canonical_title)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return _series_to_response(session, series)


@router.post("/series/{series_id}/approve", response_model=SeriesGroupResponse)
def approve_series_group(
    series_id: int,
    body: SeriesApproveRequest,
    session: Session = Depends(get_session),
    admin: dict = Depends(require_admin),
):
    try:
        series = approve_series(
            session,
            series_id,
            canonical_title=body.canonical_title,
            admin_email=admin.get("email"),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _series_to_response(session, series)


@router.post("/series/{series_id}/dismiss", response_model=SeriesGroupResponse)
def dismiss_series_group(
    series_id: int,
    session: Session = Depends(get_session),
    admin: dict = Depends(require_admin),
):
    try:
        series = dismiss_series(session, series_id, admin_email=admin.get("email"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _series_to_response(session, series)


@router.post("/series/{series_id}/split", response_model=SeriesSplitResponse)
def split_series_member(
    series_id: int,
    body: SeriesSplitRequest,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    try:
        series = split_member(session, series_id, body.event_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if series is None:
        return SeriesSplitResponse(dissolved=True, series=None)
    return SeriesSplitResponse(
        dissolved=False, series=_series_to_response(session, series)
    )


@router.get("/events/{event_id}/series", response_model=SeriesGroupListResponse)
def list_event_series_candidates(
    event_id: str,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    groups = get_series_for_event(session, event_id, statuses=("pending", "resolved"))
    items = [_series_to_response(session, group) for group in groups]
    return SeriesGroupListResponse(items=items, total=len(items))
