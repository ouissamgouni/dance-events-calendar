"""Private per-user event tickets and memory photos.

Files are validated and re-encoded here (images lose EXIF/GPS; PDFs are only
magic-byte checked, never parsed), stored in the PRIVATE bucket, and handed to
the browser as short-lived signed URLs so ``<img>`` works without cookies.
"""

from __future__ import annotations

import io
import logging
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Optional
from uuid import UUID

from sqlmodel import Session, col, select

from backend.db.models import (
    CachedEvent,
    EventUserAsset,
    SiteSetting,
    UserEventAttendance,
)
from backend.services import object_storage
from backend.services.image_processing import (
    ImageValidationError,
    cover_crop,
    flatten_image,
    load_image,
)

logger = logging.getLogger(__name__)

KIND_TICKET = "ticket"
KIND_TICKET_LINK = "ticket_link"
KIND_MEMORY = "memory"
TICKET_KINDS = (KIND_TICKET, KIND_TICKET_LINK)
FILE_KINDS = (KIND_TICKET, KIND_MEMORY)
VISIBILITIES = ("private", "friends", "attendees")

KEY_PREFIX = "event-assets/"
PDF_CONTENT_TYPE = "application/pdf"
WEBP_CONTENT_TYPE = "image/webp"
TICKET_MAX_EDGE = 2400
MEMORY_MAX_EDGE = 2048
THUMB_SIZE = 320
URL_TTL_SECONDS = 600
SUMMARY_THUMBS = 3

# Pillow decoding is memory-heavy; cap concurrent work per process.
_PROCESSING = threading.BoundedSemaphore(2)

# key -> (default, min, max)
INT_SETTINGS: dict[str, tuple[int, int, int]] = {
    "event_assets_max_tickets": (2, 1, 10),
    "event_assets_max_memories": (5, 1, 20),
    "event_assets_ticket_retention_days": (30, 1, 365),
    "event_assets_memory_window_days": (30, 1, 365),
    "event_assets_max_ticket_mb": (5, 1, 20),
    "event_assets_max_memory_mb": (10, 1, 25),
    "ticket_likely_min_hours": (20, 1, 168),
    "ticket_prompt_delay_hours": (24, 1, 168),
    "ticket_prompt_min_lead_hours": (48, 0, 168),
    "memories_prompt_local_hour": (11, 0, 23),
}

# key -> default
BOOL_SETTINGS: dict[str, bool] = {
    "ticket_prompt_enabled": True,
    "memories_prompt_enabled": True,
}


class AssetRuleError(ValueError):
    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


@dataclass
class ProcessedFile:
    content_type: str
    size_bytes: int
    width: Optional[int] = None
    height: Optional[int] = None
    # suffix -> (bytes, content_type)
    objects: dict[str, tuple[bytes, str]] = field(default_factory=dict)


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


TICKETS_FLAG = "event_tickets_enabled"
MEMORIES_FLAG = "event_memories_enabled"


def _flag(session: Session, key: str) -> bool:
    row = session.get(SiteSetting, key)
    return bool(row and str(row.value).lower() == "true")


def tickets_enabled(session: Session) -> bool:
    return _flag(session, TICKETS_FLAG)


def memories_enabled(session: Session) -> bool:
    return _flag(session, MEMORIES_FLAG)


def kind_enabled(session: Session, kind: str) -> bool:
    return (
        memories_enabled(session) if kind == KIND_MEMORY else tickets_enabled(session)
    )


def clamp_int_setting(key: str, raw) -> int:
    default, low, high = INT_SETTINGS[key]
    try:
        value = int(raw) if raw is not None else default
    except (TypeError, ValueError):
        value = default
    return min(max(value, low), high)


def int_setting(session: Session, key: str) -> int:
    row = session.get(SiteSetting, key)
    return clamp_int_setting(key, row.value if row else None)


def bool_setting(session: Session, key: str) -> bool:
    row = session.get(SiteSetting, key)
    if row is None:
        return BOOL_SETTINGS[key]
    return str(row.value).lower() == "true"


def ticket_likely(event: CachedEvent, min_hours: int) -> tuple[bool, Optional[str]]:
    """Return (likely, reason) where reason is admin | international | multi_day | None."""
    if event.advance_ticket_override is not None:
        return event.advance_ticket_override, "admin"
    if event.reach == "international":
        return True, "international"
    if _aware(event.end) - _aware(event.start) >= timedelta(hours=min_hours):
        return True, "multi_day"
    return False, None


def ticket_fields(event: CachedEvent, min_hours: int) -> dict:
    likely, reason = ticket_likely(event, min_hours)
    return {
        "advance_ticket_override": event.advance_ticket_override,
        "ticket_likely": likely,
        "ticket_likely_reason": reason,
    }


def ticket_min_hours(session: Optional[Session]) -> int:
    if session is None:
        return INT_SETTINGS["ticket_likely_min_hours"][0]
    return int_setting(session, "ticket_likely_min_hours")


def max_bytes(session: Session, kind: str) -> int:
    key = (
        "event_assets_max_memory_mb"
        if kind == KIND_MEMORY
        else "event_assets_max_ticket_mb"
    )
    return int_setting(session, key) * 1024 * 1024


def user_is_going(session: Session, user_id: UUID, event_id: str) -> bool:
    return (
        session.exec(
            select(UserEventAttendance.id)
            .where(UserEventAttendance.user_id == user_id)
            .where(UserEventAttendance.event_id == event_id)
        ).first()
        is not None
    )


def memory_window(session: Session, event: CachedEvent) -> tuple[datetime, datetime]:
    opens = _aware(event.start)
    days = int_setting(session, "event_assets_memory_window_days")
    return opens, opens + timedelta(days=days)


def ticket_expires_at(session: Session, event: CachedEvent) -> datetime:
    days = int_setting(session, "event_assets_ticket_retention_days")
    return _aware(event.end) + timedelta(days=days)


def _count(session: Session, user_id: UUID, event_id: str, kinds) -> int:
    return len(
        session.exec(
            select(EventUserAsset.id)
            .where(EventUserAsset.user_id == user_id)
            .where(EventUserAsset.event_id == event_id)
            .where(col(EventUserAsset.kind).in_(kinds))
        ).all()
    )


def ticket_count(session: Session, user_id: UUID, event_id: str) -> int:
    return _count(session, user_id, event_id, TICKET_KINDS)


def memory_count(session: Session, user_id: UUID, event_id: str) -> int:
    return _count(session, user_id, event_id, (KIND_MEMORY,))


def can_add_memory_now(
    session: Session, event: CachedEvent, now: Optional[datetime] = None
) -> bool:
    opens, closes = memory_window(session, event)
    now = now or datetime.now(timezone.utc)
    return opens <= now <= closes


def check_can_add(
    session: Session,
    user_id: UUID,
    event: CachedEvent,
    kind: str,
    now: Optional[datetime] = None,
) -> None:
    if not user_is_going(session, user_id, event.event_id):
        raise AssetRuleError("Mark yourself as going to add files", 403)
    if kind in TICKET_KINDS:
        limit = int_setting(session, "event_assets_max_tickets")
        if ticket_count(session, user_id, event.event_id) >= limit:
            raise AssetRuleError(f"You can keep up to {limit} tickets", 409)
        return
    if not can_add_memory_now(session, event, now):
        raise AssetRuleError("Memories can only be added after the event starts", 400)
    limit = int_setting(session, "event_assets_max_memories")
    if memory_count(session, user_id, event.event_id) >= limit:
        raise AssetRuleError(f"You can keep up to {limit} memories", 409)


def _scaled(image, max_edge: int):
    copy = image.copy()
    copy.thumbnail((max_edge, max_edge))
    return copy


def _webp(image, quality: int) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="WEBP", quality=quality, method=4)
    return buffer.getvalue()


def process_file(data: bytes, kind: str, limit_bytes: int) -> ProcessedFile:
    if not data:
        raise ImageValidationError("File is empty")
    if len(data) > limit_bytes:
        raise ImageValidationError(
            f"File is larger than {limit_bytes // (1024 * 1024)}MB"
        )
    if data.startswith(b"%PDF-"):
        if kind != KIND_TICKET:
            raise ImageValidationError("Memories must be JPEG, PNG or WebP images")
        return ProcessedFile(
            content_type=PDF_CONTENT_TYPE,
            size_bytes=len(data),
            objects={"ticket.pdf": (data, PDF_CONTENT_TYPE)},
        )

    with _PROCESSING:
        try:
            source = flatten_image(load_image(data))
        except ImageValidationError as exc:
            raise ImageValidationError(
                "Only PDF, JPEG, PNG and WebP files are supported"
            ) from exc
        max_edge = TICKET_MAX_EDGE if kind == KIND_TICKET else MEMORY_MAX_EDGE
        # Ticket codes must stay scannable, so keep them near-lossless.
        full = _scaled(source, max_edge)
        full_bytes = _webp(full, 92 if kind == KIND_TICKET else 85)
        thumb_bytes = _webp(cover_crop(source, THUMB_SIZE, 1), 80)
    return ProcessedFile(
        content_type=WEBP_CONTENT_TYPE,
        size_bytes=len(full_bytes),
        width=full.width,
        height=full.height,
        objects={
            "full.webp": (full_bytes, WEBP_CONTENT_TYPE),
            "thumb.webp": (thumb_bytes, WEBP_CONTENT_TYPE),
        },
    )


def _base_key(user_id: UUID, event_id: str, asset_id: UUID) -> str:
    return f"{KEY_PREFIX}{user_id}/{event_id}/{asset_id}"


def store_file_asset(
    session: Session,
    *,
    user_id: UUID,
    event_id: str,
    kind: str,
    processed: ProcessedFile,
    visibility: str = "private",
    caption: Optional[str] = None,
    asset_id: Optional[UUID] = None,
    client=None,
) -> EventUserAsset:
    asset_id = asset_id or uuid.uuid4()
    base_key = _base_key(user_id, event_id, asset_id)
    client = client or object_storage.get_client()
    for suffix, (body, content_type) in processed.objects.items():
        object_storage.put_private(
            f"{base_key}/{suffix}", body, content_type, client=client
        )
    asset = EventUserAsset(
        id=asset_id,
        user_id=user_id,
        event_id=event_id,
        kind=kind,
        object_key=base_key,
        content_type=processed.content_type,
        size_bytes=processed.size_bytes,
        width=processed.width,
        height=processed.height,
        visibility=visibility if kind == KIND_MEMORY else "private",
        caption=caption,
    )
    session.add(asset)
    return asset


def _delete_objects(asset: EventUserAsset, client=None) -> None:
    if not asset.object_key:
        return
    object_storage.delete_prefix(
        f"{asset.object_key}/", object_storage.get_private_bucket(), client=client
    )


def delete_asset(session: Session, asset: EventUserAsset, client=None) -> None:
    _delete_objects(asset, client=client)
    session.delete(asset)


def delete_user_assets(session: Session, user_id: UUID) -> int:
    assets = session.exec(
        select(EventUserAsset).where(EventUserAsset.user_id == user_id)
    ).all()
    if not assets:
        return 0
    object_storage.delete_prefix(
        f"{KEY_PREFIX}{user_id}/", object_storage.get_private_bucket()
    )
    for asset in assets:
        session.delete(asset)
    return len(assets)


def sweep_expired_tickets(session: Session, now: Optional[datetime] = None) -> int:
    now = now or datetime.now(timezone.utc)
    days = int_setting(session, "event_assets_ticket_retention_days")
    cutoff = now - timedelta(days=days)
    expired = session.exec(
        select(EventUserAsset)
        .join(CachedEvent, CachedEvent.event_id == EventUserAsset.event_id)
        .where(col(EventUserAsset.kind).in_(TICKET_KINDS))
        .where(CachedEvent.end < cutoff)
    ).all()
    if not expired:
        return 0
    client = object_storage.get_client() if any(a.object_key for a in expired) else None
    for asset in expired:
        delete_asset(session, asset, client=client)
    session.commit()
    return len(expired)


def run_sweep_once() -> dict:
    from backend.db.database import get_engine

    with Session(get_engine()) as session:
        return {"removed": sweep_expired_tickets(session)}


def asset_urls(asset: EventUserAsset, client=None) -> dict:
    urls = {"thumb_url": None, "full_url": None, "file_url": None}
    if asset.kind == KIND_TICKET_LINK or not asset.object_key:
        return urls
    if asset.content_type == PDF_CONTENT_TYPE:
        urls["file_url"] = object_storage.presigned_private_url(
            f"{asset.object_key}/ticket.pdf",
            URL_TTL_SECONDS,
            content_type=PDF_CONTENT_TYPE,
            content_disposition='inline; filename="ticket.pdf"',
            client=client,
        )
        return urls
    for name in ("thumb", "full"):
        urls[f"{name}_url"] = object_storage.presigned_private_url(
            f"{asset.object_key}/{name}.webp",
            URL_TTL_SECONDS,
            content_type=WEBP_CONTENT_TYPE,
            client=client,
        )
    return urls


def visible_to(
    session: Session,
    viewer_id: UUID,
    asset: EventUserAsset,
    viewer_is_going: bool,
) -> bool:
    from backend.api.deps import is_mutual_follow

    if asset.user_id == viewer_id:
        return True
    if asset.kind != KIND_MEMORY or asset.visibility == "private":
        return False
    if asset.visibility == "attendees":
        return viewer_is_going
    return is_mutual_follow(session, viewer_id, asset.user_id)


def event_assets_for_viewer(
    session: Session, viewer_id: UUID, event_id: str
) -> list[EventUserAsset]:
    """Assets the viewer may see: their own (while going) + shared memories."""
    going_owner_ids = set(
        session.exec(
            select(UserEventAttendance.user_id)
            .where(UserEventAttendance.event_id == event_id)
            .where(col(UserEventAttendance.user_id).is_not(None))
        ).all()
    )
    viewer_is_going = viewer_id in going_owner_ids
    assets = session.exec(
        select(EventUserAsset)
        .where(EventUserAsset.event_id == event_id)
        .where(col(EventUserAsset.user_id).in_(going_owner_ids))
        .order_by(col(EventUserAsset.created_at))
    ).all()
    return [a for a in assets if visible_to(session, viewer_id, a, viewer_is_going)]


def user_assets_by_event(
    session: Session, user_id: UUID, event_ids: list[str]
) -> dict[str, list[EventUserAsset]]:
    rows = session.exec(
        select(EventUserAsset)
        .join(
            UserEventAttendance,
            (UserEventAttendance.event_id == EventUserAsset.event_id)
            & (UserEventAttendance.user_id == EventUserAsset.user_id),
        )
        .where(EventUserAsset.user_id == user_id)
        .where(col(EventUserAsset.event_id).in_(event_ids))
        .order_by(col(EventUserAsset.created_at))
    ).all()
    grouped: dict[str, list[EventUserAsset]] = {}
    for row in rows:
        grouped.setdefault(row.event_id, []).append(row)
    return grouped
