"""Event message board (Q&A / requests) — post, reply, delete, report.

Signed-in users post a top-level message (question / accommodation / ride /
tickets / meetup / lost_found / other) or a flat reply on an event. Anonymous
users may read but not write. New top-level posts notify everyone engaged with
the event (Going ∪ Saved) plus
the site admin; replies notify that thread's participants. Free-text is
post-moderated: users report, and the author or an admin can soft-delete.
"""

from __future__ import annotations

import logging
from datetime import datetime
from uuid import UUID

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    HTTPException,
    Query,
    Request,
    Response,
)
from slowapi import Limiter
from sqlmodel import Session, col, func, select

from backend.api.deps import (
    get_current_user_optional,
    is_admin_user,
    require_user,
)
from backend.api.rate_limit import client_ip
from backend.api.schemas import (
    BatchAggregateRequest,
    EventMessageAuthor,
    EventMessageCount,
    EventMessageCreate,
    EventMessageReportCreate,
    EventMessageResponse,
    EventMessagesListResponse,
)
from backend.db.database import get_session
from backend.db.models import (
    CachedEvent,
    EventMessage,
    EventMessageReport,
    User,
    UserEventAttendance,
    UserEventMute,
    UserSavedEvent,
)
from backend.services.event_message_instant import (
    dispatch_event_message_instant,
)
from backend.services.notifications import (
    fan_out_event_message,
    notify_message_reported,
    notify_thread_reply,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["event-messages"])
limiter = Limiter(key_func=client_ip)


def _ensure_author_engaged(session: Session, user: User, event_id: str) -> None:
    """Make the poster count as engaged with the event so they receive future
    posts/replies. Posting an event message is an implicit interest signal.

    Idempotent: skips when the user is already Going or has Saved the event.
    Writes a private saved-event row under a synthetic per-user device id so it
    powers notification fan-out without broadcasting to other users.
    """
    going = session.exec(
        select(UserEventAttendance.id)
        .where(UserEventAttendance.event_id == event_id)
        .where(UserEventAttendance.user_id == user.id)
    ).first()
    if going is not None:
        return
    saved = session.exec(
        select(UserSavedEvent.id)
        .where(UserSavedEvent.event_id == event_id)
        .where(UserSavedEvent.user_id == user.id)
    ).first()
    if saved is not None:
        return
    session.add(
        UserSavedEvent(
            device_id=f"msg-author-{user.id}",
            event_id=event_id,
            user_id=user.id,
            audience="private",
        )
    )


def _snippet(text: str, limit: int = 140) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "\u2026"


def _author_schema(u: User | None) -> EventMessageAuthor | None:
    if u is None:
        return None
    return EventMessageAuthor(
        handle=u.handle or "",
        display_name=(u.display_name or (u.email.split("@", 1)[0] if u.email else "")),
        avatar_url=u.avatar_url,
        is_verified_organizer=bool(u.is_verified_organizer),
    )


def _to_response(
    msg: EventMessage,
    author: User | None,
    *,
    viewer: User | None,
    viewer_is_admin: bool,
    reply_count: int = 0,
    replies: list[EventMessageResponse] | None = None,
    reply_to: User | None = None,
) -> EventMessageResponse:
    is_own = viewer is not None and msg.author_user_id == viewer.id
    return EventMessageResponse(
        id=msg.id,
        event_id=msg.event_id,
        parent_id=msg.parent_id,
        category=msg.category,
        body=msg.body,
        author=_author_schema(author),
        is_own=is_own,
        can_delete=is_own or viewer_is_admin,
        reply_count=reply_count,
        replies=replies or [],
        reply_to=_author_schema(reply_to),
        created_at=msg.created_at,
    )


@router.get(
    "/api/events/{event_id}/messages",
    response_model=EventMessagesListResponse,
)
def list_messages(
    event_id: str,
    category: str | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=50),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_session),
    viewer: User | None = Depends(get_current_user_optional),
):
    viewer_is_admin = is_admin_user(viewer)
    muted = viewer is not None and (
        session.exec(
            select(UserEventMute.id)
            .where(UserEventMute.user_id == viewer.id)
            .where(UserEventMute.event_id == event_id)
        ).first()
        is not None
    )

    top_q = (
        select(EventMessage)
        .where(EventMessage.event_id == event_id)
        .where(col(EventMessage.parent_id).is_(None))
        .where(col(EventMessage.deleted_at).is_(None))
        .where(EventMessage.is_hidden == False)  # noqa: E712
    )
    count_q = (
        select(func.count(EventMessage.id))
        .where(EventMessage.event_id == event_id)
        .where(col(EventMessage.parent_id).is_(None))
        .where(col(EventMessage.deleted_at).is_(None))
        .where(EventMessage.is_hidden == False)  # noqa: E712
    )
    if category:
        top_q = top_q.where(EventMessage.category == category)
        count_q = count_q.where(EventMessage.category == category)

    total = int(session.exec(count_q).one())
    tops = session.exec(
        top_q.order_by(col(EventMessage.created_at).desc()).offset(offset).limit(limit)
    ).all()
    top_ids = [m.id for m in tops]
    # Flattened threading: a top-level post owns its entire subtree (replies,
    # replies-to-replies, …). Fetch every non-deleted reply for the event,
    # build a parent→children map, then flatten each visible top's descendants
    # into one chronological list. A reply that addresses another reply (not
    # the top post) carries ``reply_to`` = that reply's author for an "@name".
    reply_rows = session.exec(
        select(EventMessage)
        .where(EventMessage.event_id == event_id)
        .where(col(EventMessage.parent_id).is_not(None))
        .where(col(EventMessage.deleted_at).is_(None))
        .where(EventMessage.is_hidden == False)  # noqa: E712
        .order_by(col(EventMessage.created_at).asc())
    ).all()
    children_by_parent: dict[UUID, list[EventMessage]] = {}
    reply_by_id: dict[UUID, EventMessage] = {}
    for r in reply_rows:
        children_by_parent.setdefault(r.parent_id, []).append(r)
        reply_by_id[r.id] = r

    def _descendants(root_id: UUID) -> list[EventMessage]:
        """All descendants of ``root_id`` (any depth), chronological."""
        collected: list[EventMessage] = []
        queue: list[UUID] = [root_id]
        seen: set[UUID] = set()
        while queue:
            pid = queue.pop(0)
            for child in children_by_parent.get(pid, []):
                if child.id in seen:
                    continue
                seen.add(child.id)
                collected.append(child)
                queue.append(child.id)
        collected.sort(key=lambda m: m.created_at)
        return collected

    descendants_by_top: dict[UUID, list[EventMessage]] = {
        tid: _descendants(tid) for tid in top_ids
    }

    author_ids = {m.author_user_id for m in tops if m.author_user_id is not None}
    for ds in descendants_by_top.values():
        author_ids.update(d.author_user_id for d in ds if d.author_user_id is not None)
    authors = (
        {
            u.id: u
            for u in session.exec(
                select(User).where(col(User.id).in_(author_ids))
            ).all()
        }
        if author_ids
        else {}
    )

    items: list[EventMessageResponse] = []
    for m in tops:
        descendants = descendants_by_top.get(m.id, [])
        reply_items: list[EventMessageResponse] = []
        for r in descendants:
            # Show "@author" only when replying to another reply, not the top.
            parent_author: User | None = None
            if r.parent_id is not None and r.parent_id != m.id:
                parent_reply = reply_by_id.get(r.parent_id)
                if parent_reply is not None:
                    parent_author = authors.get(parent_reply.author_user_id)
            reply_items.append(
                _to_response(
                    r,
                    authors.get(r.author_user_id),
                    viewer=viewer,
                    viewer_is_admin=viewer_is_admin,
                    reply_to=parent_author,
                )
            )
        items.append(
            _to_response(
                m,
                authors.get(m.author_user_id),
                viewer=viewer,
                viewer_is_admin=viewer_is_admin,
                reply_count=len(reply_items),
                replies=reply_items,
            )
        )

    return EventMessagesListResponse(items=items, total=total, muted=muted)


@router.post(
    "/api/events/messages/counts",
    response_model=list[EventMessageCount],
)
def message_counts_batch(
    body: BatchAggregateRequest,
    session: Session = Depends(get_session),
):
    """Top-level message counts for a batch of events (for explorer cards).

    Count-only and open to anonymous visitors, mirroring the ratings-aggregate
    batch. Counts visible top-level posts (not replies, deleted, or hidden) so
    it matches the "Messages · N" header on the event detail page.
    """
    counts: dict[str, int] = {eid: 0 for eid in body.event_ids}
    rows = session.exec(
        select(EventMessage.event_id, func.count(EventMessage.id))
        .where(col(EventMessage.event_id).in_(body.event_ids))
        .where(col(EventMessage.parent_id).is_(None))
        .where(col(EventMessage.deleted_at).is_(None))
        .where(EventMessage.is_hidden == False)  # noqa: E712
        .group_by(EventMessage.event_id)
    ).all()
    for eid, n in rows:
        if eid in counts:
            counts[eid] = int(n)
    return [
        EventMessageCount(event_id=eid, count=counts[eid]) for eid in body.event_ids
    ]


@router.post(
    "/api/events/{event_id}/messages",
    response_model=EventMessageResponse,
    status_code=201,
)
@limiter.limit("10/hour")
def create_message(
    event_id: str,
    body: EventMessageCreate,
    request: Request,
    background_tasks: BackgroundTasks,
    session: Session = Depends(get_session),
    user: User = Depends(require_user),
):
    event = session.get(CachedEvent, event_id)
    if not event or event.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Event not found")

    # The board closes once the event is over — attendee coordination
    # (roommate/ride/questions) is only useful up to the event's end.
    if event.end < datetime.utcnow():
        raise HTTPException(status_code=409, detail="Event has ended")

    text = body.body.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Message cannot be empty")

    parent: EventMessage | None = None
    root: EventMessage | None = None
    if body.parent_id is not None:
        parent = session.get(EventMessage, body.parent_id)
        if (
            parent is None
            or parent.event_id != event_id
            or parent.deleted_at is not None
            or parent.is_hidden
        ):
            raise HTTPException(status_code=404, detail="Parent message not found")
        # Flattened threads allow replying to any message (reply-to-reply).
        # Resolve the top-level ancestor so the whole thread stays grouped and
        # every participant is notified.
        root = parent
        while root.parent_id is not None:
            ancestor = session.get(EventMessage, root.parent_id)
            if ancestor is None:
                break
            root = ancestor

    # Replies inherit the parent's category; only top-level posts choose one.
    category = parent.category if parent is not None else body.category
    now = datetime.utcnow()
    msg = EventMessage(
        event_id=event_id,
        author_user_id=user.id,
        parent_id=body.parent_id,
        category=category,
        body=text,
        created_at=now,
        updated_at=now,
    )
    session.add(msg)
    session.commit()
    session.refresh(msg)

    # Posting is an implicit interest signal: make the author engaged so they
    # get notified about later activity on this event. Best-effort.
    try:
        _ensure_author_engaged(session, user, event_id)
        session.commit()
    except Exception:  # noqa: BLE001 — engagement is best-effort
        session.rollback()
        logger.warning("Auto-engage on post failed", exc_info=True)

    # Best-effort fan-out: never break posting on a notification error.
    notifs = []
    try:
        if parent is None:
            notifs = fan_out_event_message(
                session,
                user,
                event_id,
                msg.id,
                category=category,
                snippet=_snippet(text),
            )
        else:
            notifs = notify_thread_reply(
                session,
                user,
                event_id,
                (root or parent).id,
                msg.id,
                category=category,
                snippet=_snippet(text),
            )
        session.commit()
    except Exception:  # noqa: BLE001 — notification is best-effort
        session.rollback()
        notifs = []
        logger.warning("Event message fan-out failed", exc_info=True)

    # When the admin has enabled instant email for event messages, deliver the
    # email + push right now instead of waiting for the digest scheduler. This
    # stamps the notifications so the scheduler skips them (idempotent).
    if notifs:
        try:
            dispatch_event_message_instant(session, notifs, actor=user, event=event)
        except Exception:  # noqa: BLE001 — instant delivery is best-effort
            session.rollback()
            logger.warning("Event message instant delivery failed", exc_info=True)

    return _to_response(msg, user, viewer=user, viewer_is_admin=is_admin_user(user))


@router.delete(
    "/api/events/{event_id}/messages/{message_id}",
    status_code=204,
)
def delete_message(
    event_id: str,
    message_id: UUID,
    session: Session = Depends(get_session),
    user: User = Depends(require_user),
):
    msg = session.get(EventMessage, message_id)
    if msg is None or msg.event_id != event_id or msg.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Message not found")
    if msg.author_user_id != user.id and not is_admin_user(user):
        raise HTTPException(status_code=403, detail="Not allowed")

    msg.deleted_at = datetime.utcnow()
    session.add(msg)
    session.commit()
    return Response(status_code=204)


@router.post(
    "/api/events/{event_id}/messages/{message_id}/report",
    status_code=204,
)
def report_message(
    event_id: str,
    message_id: UUID,
    body: EventMessageReportCreate,
    session: Session = Depends(get_session),
    user: User = Depends(require_user),
):
    msg = session.get(EventMessage, message_id)
    if msg is None or msg.event_id != event_id or msg.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Message not found")

    existing = session.exec(
        select(EventMessageReport)
        .where(EventMessageReport.message_id == message_id)
        .where(EventMessageReport.reporter_user_id == user.id)
    ).first()
    if existing is None:
        session.add(
            EventMessageReport(
                message_id=message_id,
                reporter_user_id=user.id,
                reason=(body.reason or None),
            )
        )
        session.commit()
        try:
            notify_message_reported(
                session, user, event_id, message_id, reason=body.reason
            )
            session.commit()
        except Exception:  # noqa: BLE001 — notification is best-effort
            session.rollback()
            logger.warning("Report notification failed", exc_info=True)

    return Response(status_code=204)


@router.put("/api/events/{event_id}/mute", status_code=204)
def mute_event(
    event_id: str,
    session: Session = Depends(get_session),
    user: User = Depends(require_user),
):
    """Mute event-message notifications for this event (idempotent)."""
    event = session.get(CachedEvent, event_id)
    if not event or event.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Event not found")
    existing = session.exec(
        select(UserEventMute.id)
        .where(UserEventMute.user_id == user.id)
        .where(UserEventMute.event_id == event_id)
    ).first()
    if existing is None:
        session.add(UserEventMute(user_id=user.id, event_id=event_id))
        session.commit()
    return Response(status_code=204)


@router.delete("/api/events/{event_id}/mute", status_code=204)
def unmute_event(
    event_id: str,
    session: Session = Depends(get_session),
    user: User = Depends(require_user),
):
    """Un-mute event-message notifications for this event (idempotent)."""
    row = session.exec(
        select(UserEventMute)
        .where(UserEventMute.user_id == user.id)
        .where(UserEventMute.event_id == event_id)
    ).first()
    if row is not None:
        session.delete(row)
        session.commit()
    return Response(status_code=204)
