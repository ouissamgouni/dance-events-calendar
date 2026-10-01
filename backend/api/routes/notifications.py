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

from datetime import UTC, date, datetime, time, timedelta, timezone, tzinfo
from typing import Optional
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, or_
from sqlmodel import Session, col, select

from backend.api.deps import require_user
from backend.api.schemas import (
    NotificationActor,
    NotificationEventSummary,
    NotificationItem,
    NotificationListResponse,
    NotificationMilestoneSummary,
    NotificationOpenedRequest,
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
from backend.services.notifications import (
    filter_privacy_safe_notifications,
    notification_is_privacy_safe,
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
    "plan_session_added",
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
# Matched events previewed on a day-grouped interest row.
MATCHED_EVENTS_CAP = 20

# Feed filter pills; must mirror frontend/src/utils/notificationRender.ts.
# Kinds outside every listed set fall into "others".
CATEGORY_KINDS: dict[str, set[str]] = {
    "plans": {
        "event_reminder",
        "planned_session_changed",
        "schedule_program_available",
        "schedule_program_updated",
        "event_message",
        "event_message_reply",
    },
    "matches": {"interest_event"},
    "people": {
        "subscription_going",
        "subscription_saved",
        "subscription_suggested",
        "plan_session_added",
        "new_follower",
        "new_friend",
        "follow_request",
        "follow_request_approved",
    },
    "reviews": {"subscription_review", "event_review_prompt"},
    "milestones": {"subscription_milestone", "milestone_unlocked"},
}
# Tribe > Activity feed: friend/follow-triggered kinds only.
SOCIAL_KINDS = CATEGORY_KINDS["people"] | {
    "subscription_review",
    "subscription_milestone",
}
VALID_CATEGORIES = set(CATEGORY_KINDS) | {"others", "social"}


def _apply_category(statement, category: str):
    if category == "social":
        return statement.where(col(Notification.kind).in_(SOCIAL_KINDS))
    if category == "others":
        listed = set().union(*CATEGORY_KINDS.values())
        return statement.where(col(Notification.kind).not_in(listed))
    return statement.where(col(Notification.kind).in_(CATEGORY_KINDS[category]))


def _user_tz(user: User) -> tzinfo:
    try:
        return ZoneInfo(user.timezone or "UTC")
    except (ZoneInfoNotFoundError, ValueError):
        return UTC


def _local_date(notification: Notification, tz: tzinfo):
    return _as_utc(notification.created_at).astimezone(tz).date()


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


def _aggregation_key(
    notification: Notification, interest_tz: Optional[tzinfo] = None
) -> tuple:
    if notification.kind in COLLAPSIBLE_KINDS and notification.event_id is not None:
        return ("__event__", notification.kind, notification.event_id)
    if notification.kind == "interest_event" and interest_tz is not None:
        return ("__interest__", _local_date(notification, interest_tz))
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
    interest_tz: Optional[tzinfo] = None,
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
        key = _aggregation_key(r, interest_tz)
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
        is_interest_group = key[0] == "__interest__"
        matched_events: list[NotificationEventSummary] = []
        context = rep.context
        if is_interest_group:
            for m in g["members"][:MATCHED_EVENTS_CAP]:
                if m.event_id is None:
                    continue
                me = events.get(m.event_id)
                matched_events.append(
                    NotificationEventSummary(
                        event_id=m.event_id,
                        title=me.title if me else None,
                        start=_as_utc(me.start if me else None),
                        image_url=me.image_url if me else None,
                    )
                )
            labels = [
                label.strip()
                for m in g["members"]
                for label in (m.context or "").split(",")
                if label.strip()
            ]
            context = ", ".join(dict.fromkeys(labels))[:200] or None
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
                matched_events=matched_events,
                matched_event_count=len(g["members"]) if is_interest_group else 1,
                matched_day=key[1] if is_interest_group else None,
                context=context,
                subject_key=rep.subject_key,
                schedule_session_id=(
                    UUID(rep.group_key)
                    if rep.kind in {"planned_session_changed", "plan_session_added"}
                    and rep.group_key
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
    category: Optional[str] = Query(
        default=None,
        description="Filter pill: plans|matches|people|reviews|milestones|others|social",
    ),
    day: Optional[date] = Query(
        default=None,
        description="Recipient-local day (YYYY-MM-DD) of interest matches to list",
    ),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_session),
    user: User = Depends(require_user),
):
    if kind is not None and kind not in VALID_KINDS:
        raise HTTPException(status_code=400, detail="Invalid kind")
    if category is not None and category not in VALID_CATEGORIES:
        raise HTTPException(status_code=400, detail="Invalid category")

    base = select(Notification).where(Notification.recipient_user_id == user.id)
    if kind is not None:
        base = base.where(Notification.kind == kind)
    if category is not None:
        base = _apply_category(base, category)
    if unread_only:
        base = base.where(Notification.read_at.is_(None))
    tz = _user_tz(user)
    if day is not None:
        start = datetime.combine(day, time.min, tzinfo=tz).astimezone(UTC)
        end = datetime.combine(day + timedelta(days=1), time.min, tzinfo=tz).astimezone(
            UTC
        )
        base = (
            base.where(Notification.kind == "interest_event")
            .where(Notification.created_at >= start.replace(tzinfo=None))
            .where(Notification.created_at < end.replace(tzinfo=None))
        )

    base = _apply_visibility(base, session)
    unread_statement = (
        select(Notification)
        .where(Notification.recipient_user_id == user.id)
        .where(Notification.read_at.is_(None))
    )
    unread_statement = _apply_visibility(unread_statement, session)
    unread_rows = filter_privacy_safe_notifications(
        session, list(session.exec(unread_statement).all())
    )

    grouped_unread = len({_aggregation_key(row, tz) for row in unread_rows})

    # Flat interest matches never aggregate, so page in SQL past the window.
    if kind == "interest_event" or category == "matches" or day is not None:
        total = session.exec(select(func.count()).select_from(base.subquery())).one()
        page_rows = session.exec(
            base.order_by(col(Notification.created_at).desc())
            .offset(offset)
            .limit(limit)
        ).all()
        return NotificationListResponse(
            items=_hydrate(session, list(page_rows), viewer_id=user.id),
            total=total,
            unread_count=grouped_unread,
            limit=limit,
            offset=offset,
        )

    # Scan a capped newest-first window, aggregate collapsible rows into
    # multi-actor items, then paginate the grouped result. ``total`` becomes
    # the grouped count so the feed's "has more" math matches what renders.
    rows = filter_privacy_safe_notifications(
        session,
        list(
            session.exec(
                base.order_by(col(Notification.created_at).desc()).limit(
                    AGGREGATION_WINDOW
                )
            ).all()
        ),
    )
    # Interest matches collapse per local day only in the unfiltered feed;
    # the Matches pill / ?kind= deep link list them one per row.
    group_tz = tz if kind is None and category is None else None
    aggregated = _hydrate(session, rows, viewer_id=user.id, interest_tz=group_tz)
    grouped_total = len(aggregated)
    page = aggregated[offset : offset + limit]

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
    rows = filter_privacy_safe_notifications(
        session, list(session.exec(statement).all())
    )
    tz = _user_tz(user)
    return UnreadCountResponse(count=len({_aggregation_key(row, tz) for row in rows}))


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
    if not notification_is_privacy_safe(session, row):
        raise HTTPException(status_code=404, detail="Notification not found")
    if row.event_id is not None:
        event = session.get(CachedEvent, row.event_id)
        if event is None or not event_is_user_facing(session, event):
            raise HTTPException(status_code=404, detail="Notification not found")
    now = datetime.now(timezone.utc)
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
    elif row.kind == "interest_event":
        tz = _user_tz(user)
        day = _local_date(row, tz)
        siblings = [
            sib
            for sib in session.exec(
                select(Notification)
                .where(Notification.recipient_user_id == user.id)
                .where(Notification.kind == row.kind)
                .where(Notification.read_at.is_(None))
            ).all()
            if _local_date(sib, tz) == day
        ]
    else:
        siblings = [row] if row.read_at is None else []
    for sib in siblings:
        sib.read_at = now
        session.add(sib)
    if siblings:
        session.commit()
        session.refresh(row)
    return _hydrate(session, [row], viewer_id=user.id)[0]


@router.post("/{notification_id}/opened", status_code=204)
def mark_opened(
    notification_id: int,
    payload: NotificationOpenedRequest,
    session: Session = Depends(get_session),
    user: User = Depends(require_user),
):
    row = session.get(Notification, notification_id)
    if row is None or row.recipient_user_id != user.id:
        raise HTTPException(status_code=404, detail="Notification not found")
    now = datetime.now(timezone.utc)
    if payload.channel == "push":
        # A combined push covers every row stamped in the same dispatch run.
        rows = (
            session.exec(
                select(Notification)
                .where(Notification.recipient_user_id == user.id)
                .where(Notification.kind == row.kind)
                .where(Notification.pushed_at == row.pushed_at)
                .where(Notification.push_opened_at.is_(None))
            ).all()
            if row.pushed_at is not None and row.kind == "interest_event"
            else ([row] if row.push_opened_at is None else [])
        )
        for r in rows:
            r.push_opened_at = now
            session.add(r)
    elif row.email_clicked_at is None:
        row.email_clicked_at = now
        session.add(row)
    session.commit()


@router.post("/read-all", response_model=UnreadCountResponse)
def mark_all_read(
    session: Session = Depends(get_session),
    user: User = Depends(require_user),
):
    now = datetime.now(timezone.utc)
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
