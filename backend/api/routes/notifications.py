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
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import or_
from sqlmodel import Session, col, func, select

from backend.api.deps import require_user
from backend.api.schemas import (
    NotificationActor,
    NotificationItem,
    NotificationListResponse,
    NotificationMilestoneSummary,
    UnreadCountResponse,
)
from backend.db.database import get_session
from backend.db.models import (
    CachedEvent,
    Notification,
    User,
    UserFollow,
    UserEventAttendance,
)
from backend.services.user_avatars import resolve_user_avatar
from backend.services.event_visibility import (
    event_is_user_facing,
    show_pending_events_enabled,
)


router = APIRouter(prefix="/api/notifications", tags=["notifications"])


VALID_KINDS = {
    "subscription_going",
    "subscription_saved",
    "subscription_suggested",
    "subscription_review",
    "subscription_milestone",
    "new_follower",
    "new_friend",
    "follow_request",
    "follow_request_approved",
    "event_reminder",
    "event_review_prompt",
    "interest_event",
    "promo_code_approved",
    "promo_code_rejected",
    "promo_code_added",
    "milestone_unlocked",
    "organizer_claim_decided",
    "event_message",
    "event_message_reply",
    "event_message_reported",
    "planned_session_changed",
    "schedule_program_available",
    "schedule_program_updated",
}


def _as_utc(dt: Optional[datetime]) -> Optional[datetime]:
    if dt is None or dt.tzinfo is not None:
        return dt
    return dt.replace(tzinfo=UTC)


# Person+event activity kinds that collapse into one multi-actor feed row
# (e.g. "Emma, Samir +9 others are going to X"). Follow-graph, milestone and
# system kinds stay one row each.
COLLAPSIBLE_KINDS = {
    "subscription_going",
    "subscription_saved",
    "subscription_suggested",
    "subscription_review",
}
MILESTONE_KINDS = {"milestone_unlocked", "subscription_milestone"}
RELATIONSHIP_KINDS = {"new_follower", "new_friend"}
# How many distinct actors to preview in an aggregated row.
ACTOR_PREVIEW_CAP = 12
# Upper bound of raw rows scanned per list request before aggregation. The
# feed has no deep pagination, so a generous window keeps grouping correct
# without a GROUP BY round-trip.
AGGREGATION_WINDOW = 200


def _apply_visibility(statement, session: Session):
    if show_pending_events_enabled(session):
        return statement
    visible_event_ids = select(CachedEvent.event_id).where(
        CachedEvent.review_status != "pending"
    )
    return statement.where(
        or_(
            Notification.event_id.is_(None),
            Notification.event_id.in_(visible_event_ids),
        )
    )


def _aggregation_key(notification: Notification) -> tuple:
    if notification.kind in COLLAPSIBLE_KINDS and notification.event_id is not None:
        return ("__event__", notification.kind, notification.event_id)
    if notification.kind in MILESTONE_KINDS:
        return (
            "__milestone__",
            notification.kind,
            notification.actor_user_id,
        )
    if notification.kind in RELATIONSHIP_KINDS:
        return ("__relationship__", notification.actor_user_id)
    return ("__row__", notification.id)


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

    # Which of these events is the viewer also attending? Only needed for
    # subscription_going rows to render "You and X are going to ...".
    also_going_event_ids: set = set()
    going_event_ids = {
        r.event_id
        for r in rows
        if r.kind == "subscription_going" and r.event_id is not None
    }
    if viewer_id is not None and going_event_ids:
        also_going_event_ids = set(
            session.exec(
                select(UserEventAttendance.event_id)
                .where(UserEventAttendance.user_id == viewer_id)
                .where(col(UserEventAttendance.event_id).in_(going_event_ids))
            ).all()
        )

    def _make_actor(a: Optional[User]) -> NotificationActor:
        return NotificationActor(
            handle=(a.handle if a and a.handle else ""),
            display_name=(
                a.display_name
                if a and a.display_name
                else (a.email.split("@", 1)[0] if a else "")
            ),
            avatar_url=resolve_user_avatar(a) if a else None,
            is_verified_organizer=bool(a.is_verified_organizer if a else False),
            is_following=bool(a and a.id in following_ids),
        )

    # Group collapsible person+event rows; keep everything else 1:1. Rows
    # arrive newest-first, so the first row seen for a group is its
    # representative (drives copy, event, timestamp).
    order: list[tuple] = []
    groups: dict[tuple, dict] = {}
    for r in rows:
        key = _aggregation_key(r)
        g = groups.get(key)
        if g is None:
            g = {
                "rep": r,
                "members": [r],
                "actor_ids": [r.actor_user_id],
                "actor_id_set": {r.actor_user_id},
            }
            groups[key] = g
            order.append(key)
        else:
            g["members"].append(r)
            if r.kind == "new_friend" and g["rep"].kind == "new_follower":
                g["rep"] = r
            if r.actor_user_id not in g["actor_id_set"]:
                g["actor_id_set"].add(r.actor_user_id)
                g["actor_ids"].append(r.actor_user_id)

    items: list[NotificationItem] = []
    for key in order:
        g = groups[key]
        rep = g["rep"]
        e = events.get(rep.event_id)
        preview = [
            _make_actor(actors.get(aid)) for aid in g["actor_ids"][:ACTOR_PREVIEW_CAP]
        ]
        member_reads = [m.read_at for m in g["members"]]
        # A group is unread while any folded member is unread.
        group_read = (
            None if any(rd is None for rd in member_reads) else max(member_reads)
        )
        milestone_members = (
            sorted(g["members"], key=lambda member: (member.created_at, member.id))
            if rep.kind in MILESTONE_KINDS
            else []
        )
        items.append(
            NotificationItem(
                id=rep.id,
                kind=rep.kind,
                event_id=rep.event_id,
                event_title=e.title if e else None,
                event_start=_as_utc(e.start if e else None),
                event_image_url=(e.image_url if e else None),
                actor=preview[0],
                actors=preview,
                actor_count=len(g["actor_ids"]),
                member_ids=[m.id for m in g["members"]],
                milestones=[
                    NotificationMilestoneSummary(
                        subject_key=member.subject_key,
                        name=member.context or "a new achievement",
                        description=member.description,
                    )
                    for member in milestone_members
                    if member.subject_key is not None
                ],
                context=rep.context,
                subject_key=rep.subject_key,
                schedule_session_id=(
                    UUID(rep.group_key)
                    if rep.kind == "planned_session_changed" and rep.group_key
                    else None
                ),
                description=rep.description,
                also_going=(
                    rep.kind == "subscription_going"
                    and rep.event_id in also_going_event_ids
                ),
                created_at=_as_utc(rep.created_at),
                read_at=_as_utc(group_read),
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

    base = _apply_visibility(base, session)
    count_base = _apply_visibility(count_base, session)

    total = session.exec(count_base).one()
    unread_statement = (
        select(func.count(Notification.id))
        .where(Notification.recipient_user_id == user.id)
        .where(Notification.read_at.is_(None))
    )
    unread_statement = _apply_visibility(unread_statement, session)
    unread = session.exec(unread_statement).one()

    # Scan a capped newest-first window, aggregate collapsible rows into
    # multi-actor items, then paginate the grouped result. ``total`` becomes
    # the grouped count so the feed's "has more" math matches what renders.
    rows = session.exec(
        base.order_by(col(Notification.created_at).desc()).limit(AGGREGATION_WINDOW)
    ).all()
    aggregated = _hydrate(session, list(rows), viewer_id=user.id)
    grouped_total = len(aggregated) if len(rows) < AGGREGATION_WINDOW else int(total)
    page = aggregated[offset : offset + limit]

    grouped_unread = (
        sum(item.read_at is None for item in aggregated)
        if len(rows) < AGGREGATION_WINDOW
        else int(unread)
    )
    return NotificationListResponse(
        items=page,
        total=grouped_total,
        unread_count=grouped_unread,
        limit=limit,
        offset=offset,
    )


@router.get("/unread-count", response_model=UnreadCountResponse)
def unread_count(
    session: Session = Depends(get_session),
    user: User = Depends(require_user),
):
    statement = (
        select(Notification)
        .where(Notification.recipient_user_id == user.id)
        .where(Notification.read_at.is_(None))
    )
    statement = _apply_visibility(statement, session)
    rows = session.exec(statement).all()
    return UnreadCountResponse(count=len({_aggregation_key(row) for row in rows}))


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
    if row.event_id is not None:
        event = session.get(CachedEvent, row.event_id)
        if event is None or not event_is_user_facing(session, event):
            raise HTTPException(status_code=404, detail="Notification not found")
    now = datetime.utcnow()
    # Collapsible rows render as one aggregated group, so marking the
    # representative read clears every sibling (same kind + event) too.
    if row.kind in MILESTONE_KINDS:
        siblings = session.exec(
            select(Notification)
            .where(Notification.recipient_user_id == user.id)
            .where(Notification.kind == row.kind)
            .where(Notification.actor_user_id == row.actor_user_id)
            .where(Notification.read_at.is_(None))
        ).all()
    elif row.kind in RELATIONSHIP_KINDS:
        siblings = session.exec(
            select(Notification)
            .where(Notification.recipient_user_id == user.id)
            .where(col(Notification.kind).in_(RELATIONSHIP_KINDS))
            .where(Notification.actor_user_id == row.actor_user_id)
            .where(Notification.read_at.is_(None))
        ).all()
    elif row.kind in COLLAPSIBLE_KINDS and row.event_id is not None:
        siblings = session.exec(
            select(Notification)
            .where(Notification.recipient_user_id == user.id)
            .where(Notification.kind == row.kind)
            .where(Notification.event_id == row.event_id)
            .where(Notification.read_at.is_(None))
        ).all()
    else:
        siblings = [row] if row.read_at is None else []
    for sib in siblings:
        sib.read_at = now
        session.add(sib)
    if siblings:
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
