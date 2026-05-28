"""Phase C: in-app notification feed endpoints.

Endpoints (all require an authenticated end-user):
  - GET    /api/notifications            list with pagination + filters
  - GET    /api/notifications/unread-count
  - POST   /api/notifications/{id}/read   mark single
  - POST   /api/notifications/read-all    mark all unread

Notifications are produced by the fan-out helpers in
``backend.services.notifications`` from the Going + suggestion-approval
write paths.
"""

from datetime import UTC, datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlmodel import Session, col, func, select

from backend.api.deps import require_user
from backend.api.schemas import (
    NotificationActor,
    NotificationItem,
    NotificationListResponse,
    UnreadCountResponse,
)
from backend.db.database import get_session
from backend.db.models import CachedEvent, Notification, User, UserFollow


router = APIRouter(prefix="/api/notifications", tags=["notifications"])


VALID_KINDS = {
    "subscription_going",
    "subscription_suggested",
    "new_follower",
    "new_friend",
    "follow_request",
    "follow_request_approved",
}


def _as_utc(dt: Optional[datetime]) -> Optional[datetime]:
    if dt is None or dt.tzinfo is not None:
        return dt
    return dt.replace(tzinfo=UTC)


def _hydrate(
    session: Session,
    rows: list[Notification],
    *,
    viewer_id=None,
) -> list[NotificationItem]:
    if not rows:
        return []
    actor_ids = {r.actor_user_id for r in rows}
    event_ids = {r.event_id for r in rows if r.event_id is not None}

    actors = {
        u.id: u
        for u in session.exec(select(User).where(col(User.id).in_(actor_ids))).all()
    }
    # Phase E (E1): pre-compute the viewer's outbound follow set so each
    # actor row can carry an ``is_following`` flag without N+1 lookups.
    following_ids: set = set()
    if viewer_id is not None and actor_ids:
        following_ids = set(
            session.exec(
                select(UserFollow.followee_id)
                .where(UserFollow.follower_id == viewer_id)
                .where(UserFollow.status == "approved")
                .where(col(UserFollow.followee_id).in_(actor_ids))
            ).all()
        )
    events = (
        {
            e.event_id: e
            for e in session.exec(
                select(CachedEvent).where(col(CachedEvent.event_id).in_(event_ids))
            ).all()
        }
        if event_ids
        else {}
    )

    items: list[NotificationItem] = []
    for r in rows:
        a = actors.get(r.actor_user_id)
        e = events.get(r.event_id)
        items.append(
            NotificationItem(
                id=r.id,
                kind=r.kind,
                event_id=r.event_id,
                event_title=e.title if e else None,
                event_start=_as_utc(e.start if e else None),
                actor=NotificationActor(
                    handle=(a.handle if a and a.handle else ""),
                    display_name=(
                        a.display_name
                        if a and a.display_name
                        else (a.email.split("@", 1)[0] if a else "")
                    ),
                    avatar_url=a.avatar_url if a else None,
                    is_verified_organizer=bool(a.is_verified_organizer if a else False),
                    is_following=bool(a and a.id in following_ids),
                ),
                created_at=_as_utc(r.created_at),
                read_at=_as_utc(r.read_at),
            )
        )
    return items


@router.get("", response_model=NotificationListResponse)
def list_notifications(
    kind: Optional[str] = Query(
        default=None,
        description="Filter to one kind (subscription_going|subscription_suggested)",
    ),
    unread_only: bool = Query(default=False),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_session),
    user: User = Depends(require_user),
):
    if kind is not None and kind not in VALID_KINDS:
        raise HTTPException(status_code=400, detail="Invalid kind")

    base = select(Notification).where(Notification.recipient_user_id == user.id)
    count_base = select(func.count(Notification.id)).where(
        Notification.recipient_user_id == user.id
    )
    if kind is not None:
        base = base.where(Notification.kind == kind)
        count_base = count_base.where(Notification.kind == kind)
    if unread_only:
        base = base.where(Notification.read_at.is_(None))
        count_base = count_base.where(Notification.read_at.is_(None))

    total = session.exec(count_base).one()
    unread = session.exec(
        select(func.count(Notification.id))
        .where(Notification.recipient_user_id == user.id)
        .where(Notification.read_at.is_(None))
    ).one()

    rows = session.exec(
        base.order_by(col(Notification.created_at).desc()).offset(offset).limit(limit)
    ).all()

    return NotificationListResponse(
        items=_hydrate(session, list(rows), viewer_id=user.id),
        total=int(total),
        unread_count=int(unread),
        limit=limit,
        offset=offset,
    )


@router.get("/unread-count", response_model=UnreadCountResponse)
def unread_count(
    session: Session = Depends(get_session),
    user: User = Depends(require_user),
):
    n = session.exec(
        select(func.count(Notification.id))
        .where(Notification.recipient_user_id == user.id)
        .where(Notification.read_at.is_(None))
    ).one()
    return UnreadCountResponse(count=int(n))


@router.post("/{notification_id}/read", response_model=NotificationItem)
def mark_read(
    notification_id: int,
    session: Session = Depends(get_session),
    user: User = Depends(require_user),
):
    row = session.get(Notification, notification_id)
    if row is None or row.recipient_user_id != user.id:
        # 404 (not 403) so we don't leak existence of others' rows.
        raise HTTPException(status_code=404, detail="Notification not found")
    if row.read_at is None:
        row.read_at = datetime.utcnow()
        session.add(row)
        session.commit()
        session.refresh(row)
    return _hydrate(session, [row], viewer_id=user.id)[0]


@router.post("/read-all", response_model=UnreadCountResponse)
def mark_all_read(
    session: Session = Depends(get_session),
    user: User = Depends(require_user),
):
    now = datetime.utcnow()
    rows = session.exec(
        select(Notification)
        .where(Notification.recipient_user_id == user.id)
        .where(Notification.read_at.is_(None))
    ).all()
    for r in rows:
        r.read_at = now
        session.add(r)
    if rows:
        session.commit()
    return UnreadCountResponse(count=0)
