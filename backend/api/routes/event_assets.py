"""Private per-user event tickets and memory photos."""

from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from slowapi import Limiter
from sqlmodel import Session, col, select

from backend.api.deps import require_user
from backend.api.rate_limit import client_ip
from backend.api.schemas import (
    EventAssetLinkRequest,
    EventAssetsResponse,
    EventAssetSummary,
    EventAssetSummaryRequest,
    EventAssetThumb,
    EventAssetUpdateRequest,
    EventUserAssetResponse,
)
from backend.db.database import get_session
from backend.db.models import CachedEvent, EventUserAsset, User, UserEventAttendance
from backend.services import event_assets, object_storage
from backend.services.event_visibility import event_is_user_facing
from backend.services.image_processing import ImageValidationError
from backend.services.user_avatars import resolve_user_avatar


def _require_any_feature(session: Session = Depends(get_session)) -> None:
    if not (
        event_assets.tickets_enabled(session) or event_assets.memories_enabled(session)
    ):
        raise HTTPException(status_code=404, detail="Not found")


router = APIRouter(tags=["event-assets"], dependencies=[Depends(_require_any_feature)])
limiter = Limiter(key_func=client_ip)

_READ_CHUNK = 256 * 1024


def _require_kind(session: Session, kind: str) -> None:
    if not event_assets.kind_enabled(session, kind):
        raise HTTPException(status_code=404, detail="Not found")


def _get_event(session: Session, event_id: str) -> CachedEvent:
    event = session.get(CachedEvent, event_id)
    if (
        event is None
        or event.deleted_at is not None
        or not event_is_user_facing(session, event)
    ):
        raise HTTPException(status_code=404, detail="Event not found")
    return event


def _get_own_asset(session: Session, asset_id: UUID, user: User) -> EventUserAsset:
    asset = session.get(EventUserAsset, asset_id)
    if asset is None or asset.user_id != user.id:
        raise HTTPException(status_code=404, detail="Not found")
    return asset


def _serialize(
    asset: EventUserAsset,
    viewer_id: UUID,
    owners: dict[UUID, User],
    client,
) -> EventUserAssetResponse:
    owner = owners.get(asset.user_id)
    return EventUserAssetResponse(
        id=asset.id,
        event_id=asset.event_id,
        kind=asset.kind,
        content_type=asset.content_type,
        url=asset.url,
        width=asset.width,
        height=asset.height,
        visibility=asset.visibility,
        caption=asset.caption,
        created_at=asset.created_at,
        is_owner=asset.user_id == viewer_id,
        owner_display_name=owner.display_name if owner else None,
        owner_avatar_url=resolve_user_avatar(owner) if owner else None,
        **event_assets.asset_urls(asset, client=client),
    )


def _build_response(
    session: Session, event: CachedEvent, user: User
) -> EventAssetsResponse:
    attendance = _own_attendance(session, user, event.event_id)
    is_going = attendance is not None
    tickets_on = event_assets.tickets_enabled(session)
    memories_on = event_assets.memories_enabled(session)
    assets = [
        a
        for a in event_assets.event_assets_for_viewer(session, user.id, event.event_id)
        if (memories_on if a.kind == event_assets.KIND_MEMORY else tickets_on)
    ]
    owner_ids = {a.user_id for a in assets}
    owners = (
        {
            u.id: u
            for u in session.exec(select(User).where(col(User.id).in_(owner_ids))).all()
        }
        if owner_ids
        else {}
    )
    client = object_storage.get_client() if any(a.object_key for a in assets) else None
    own = [a for a in assets if a.user_id == user.id]
    tickets = sum(1 for a in own if a.kind in event_assets.TICKET_KINDS)
    memories = sum(1 for a in own if a.kind == event_assets.KIND_MEMORY)
    max_tickets = event_assets.int_setting(session, "event_assets_max_tickets")
    max_memories = event_assets.int_setting(session, "event_assets_max_memories")
    opens, closes = event_assets.memory_window(session, event)
    return EventAssetsResponse(
        event_id=event.event_id,
        is_going=is_going,
        assets=[_serialize(a, user.id, owners, client) for a in assets],
        ticket_count=tickets,
        memory_count=memories,
        max_tickets=max_tickets,
        max_memories=max_memories,
        max_ticket_mb=event_assets.int_setting(session, "event_assets_max_ticket_mb"),
        max_memory_mb=event_assets.int_setting(session, "event_assets_max_memory_mb"),
        can_add_ticket=tickets_on and is_going and tickets < max_tickets,
        can_add_memory=memories_on
        and is_going
        and memories < max_memories
        and event_assets.can_add_memory_now(session, event),
        memory_window_opens_at=opens,
        memory_window_closes_at=closes,
        ticket_expires_at=event_assets.ticket_expires_at(session, event),
        ticket_likely=event_assets.ticket_likely(
            event, event_assets.ticket_min_hours(session)
        )[0],
        ticket_not_needed=bool(attendance and attendance.ticket_not_needed_at),
    )


def _own_attendance(
    session: Session, user: User, event_id: str
) -> UserEventAttendance | None:
    return session.exec(
        select(UserEventAttendance)
        .where(UserEventAttendance.user_id == user.id)
        .where(UserEventAttendance.event_id == event_id)
    ).first()


def _check_rules(session: Session, user: User, event: CachedEvent, kind: str) -> None:
    try:
        event_assets.check_can_add(session, user.id, event, kind)
    except event_assets.AssetRuleError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


def _read_capped(file: UploadFile, limit: int) -> bytes:
    buffer = bytearray()
    while chunk := file.file.read(_READ_CHUNK):
        buffer.extend(chunk)
        if len(buffer) > limit:
            raise HTTPException(
                status_code=413,
                detail=f"File is larger than {limit // (1024 * 1024)}MB",
            )
    return bytes(buffer)


@router.get("/api/events/{event_id}/assets", response_model=EventAssetsResponse)
def list_event_assets(
    event_id: str,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
):
    return _build_response(session, _get_event(session, event_id), user)


@router.post("/api/events/{event_id}/assets", response_model=EventAssetsResponse)
@limiter.limit("20/hour")
def upload_event_asset(
    request: Request,
    event_id: str,
    kind: str = Form(..., pattern="^(ticket|memory)$"),
    visibility: str = Form("private", pattern="^(private|friends|attendees)$"),
    caption: str | None = Form(None, max_length=200),
    file: UploadFile = File(...),
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
):
    event = _get_event(session, event_id)
    _require_kind(session, kind)
    _check_rules(session, user, event, kind)
    limit = event_assets.max_bytes(session, kind)
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > limit + 64 * 1024:
        raise HTTPException(
            status_code=413, detail=f"File is larger than {limit // (1024 * 1024)}MB"
        )
    data = _read_capped(file, limit)
    try:
        processed = event_assets.process_file(data, kind, limit)
    except ImageValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    event_assets.store_file_asset(
        session,
        user_id=user.id,
        event_id=event.event_id,
        kind=kind,
        processed=processed,
        visibility=visibility,
        caption=caption,
    )
    session.commit()
    return _build_response(session, event, user)


@router.post("/api/events/{event_id}/assets/link", response_model=EventAssetsResponse)
@limiter.limit("20/hour")
def add_ticket_link(
    request: Request,
    event_id: str,
    body: EventAssetLinkRequest,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
):
    if body.url.scheme != "https":
        raise HTTPException(status_code=400, detail="Ticket link must use https")
    event = _get_event(session, event_id)
    _require_kind(session, event_assets.KIND_TICKET_LINK)
    _check_rules(session, user, event, event_assets.KIND_TICKET_LINK)
    session.add(
        EventUserAsset(
            user_id=user.id,
            event_id=event.event_id,
            kind=event_assets.KIND_TICKET_LINK,
            url=str(body.url),
        )
    )
    session.commit()
    return _build_response(session, event, user)


@router.patch("/api/event-assets/{asset_id}", response_model=EventAssetsResponse)
def update_event_asset(
    asset_id: UUID,
    body: EventAssetUpdateRequest,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
):
    asset = _get_own_asset(session, asset_id, user)
    _require_kind(session, asset.kind)
    if body.visibility is not None:
        if asset.kind != event_assets.KIND_MEMORY:
            raise HTTPException(status_code=400, detail="Only memories can be shared")
        asset.visibility = body.visibility
    if body.caption is not None:
        asset.caption = body.caption.strip() or None
    session.add(asset)
    session.commit()
    return _build_response(session, _get_event(session, asset.event_id), user)


@router.delete("/api/event-assets/{asset_id}", response_model=EventAssetsResponse)
def delete_event_asset(
    asset_id: UUID,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
):
    asset = _get_own_asset(session, asset_id, user)
    _require_kind(session, asset.kind)
    event_id = asset.event_id
    event_assets.delete_asset(session, asset)
    session.commit()
    return _build_response(session, _get_event(session, event_id), user)


@router.post(
    "/api/me/event-assets/summary", response_model=dict[str, EventAssetSummary]
)
def event_assets_summary(
    body: EventAssetSummaryRequest,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
):
    event_ids = list(dict.fromkeys(body.event_ids))
    grouped = event_assets.user_assets_by_event(session, user.id, event_ids)
    events = {
        e.event_id: e
        for e in session.exec(
            select(CachedEvent).where(col(CachedEvent.event_id).in_(event_ids))
        ).all()
    }
    attendances = {
        a.event_id: a
        for a in session.exec(
            select(UserEventAttendance)
            .where(UserEventAttendance.user_id == user.id)
            .where(col(UserEventAttendance.event_id).in_(list(events)))
        ).all()
    }
    client = object_storage.get_client() if grouped else None
    tickets_on = event_assets.tickets_enabled(session)
    memories_on = event_assets.memories_enabled(session)
    max_memories = event_assets.int_setting(session, "event_assets_max_memories")
    ticket_hours = event_assets.ticket_min_hours(session)
    now = datetime.now(timezone.utc)
    result: dict[str, EventAssetSummary] = {}
    for event_id, attendance in attendances.items():
        event = events[event_id]
        rows = grouped.get(event_id, [])
        memories = (
            [a for a in rows if a.kind == event_assets.KIND_MEMORY]
            if memories_on
            else []
        )
        _, closes = event_assets.memory_window(session, event)
        result[event_id] = EventAssetSummary(
            ticket_count=sum(1 for a in rows if a.kind in event_assets.TICKET_KINDS)
            if tickets_on
            else 0,
            memory_count=len(memories),
            memory_thumbs=[
                EventAssetThumb(
                    id=a.id,
                    thumb_url=event_assets.asset_urls(a, client=client)["thumb_url"],
                    visibility=a.visibility,
                )
                for a in memories[: event_assets.SUMMARY_THUMBS]
            ],
            can_add_memory=memories_on
            and len(memories) < max_memories
            and event_assets.can_add_memory_now(session, event, now),
            memory_window_closes_at=closes,
            ticket_likely=tickets_on
            and event_assets.ticket_likely(event, ticket_hours)[0],
            ticket_not_needed=attendance.ticket_not_needed_at is not None,
        )
    return result


def _set_ticket_not_needed(
    session: Session, user: User, event_id: str, value: bool
) -> EventAssetsResponse:
    event = _get_event(session, event_id)
    _require_kind(session, event_assets.KIND_TICKET)
    attendance = _own_attendance(session, user, event.event_id)
    if attendance is None:
        raise HTTPException(status_code=403, detail="Mark yourself as going first")
    attendance.ticket_not_needed_at = datetime.now(timezone.utc) if value else None
    session.add(attendance)
    session.commit()
    return _build_response(session, event, user)


@router.put(
    "/api/events/{event_id}/ticket-not-needed", response_model=EventAssetsResponse
)
def mark_ticket_not_needed(
    event_id: str,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
):
    return _set_ticket_not_needed(session, user, event_id, True)


@router.delete(
    "/api/events/{event_id}/ticket-not-needed", response_model=EventAssetsResponse
)
def unmark_ticket_not_needed(
    event_id: str,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
):
    return _set_ticket_not_needed(session, user, event_id, False)
