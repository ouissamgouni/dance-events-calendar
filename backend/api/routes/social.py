"""Social/friends graph endpoints (Phase A — v1 social foundation).

Asymmetric follow model: a row in ``user_follows`` represents a one-way
edge from ``follower_id`` to ``followee_id``. A "friend" is a mutual
follow, derived at query time by self-joining the table.

Privacy notes:
- All endpoints that read another user's data go through
  ``backend.api.deps.can_view`` and respond 404 (not 403) on denial to
  avoid leaking the existence of private resources.
- Email is never exposed by these routes; the public identifier is
  ``handle``.
"""

from datetime import datetime, timedelta
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from slowapi import Limiter
from sqlalchemy import func, or_
from sqlalchemy.orm import aliased
from sqlmodel import Session, col, select

from backend.api.deps import (
    _audience_passes,
    can_view,
    can_view_event_in_calendar,
    get_current_user_optional,
    is_mutual_follow,
    require_admin,
    require_user,
)
from backend.api.event_serializer import serialize_events
from backend.api.rate_limit import client_ip
from backend.api.routes.auth import purge_user_account
from backend.api.schemas import (
    AdminUser,
    AdminUserListResponse,
    CalendarSubscriptionRequest,
    FollowActionResponse,
    FollowListResponse,
    FollowNotifyRequest,
    FollowUserResponse,
    FriendsLeaderboardEntry,
    FriendsLeaderboardResponse,
    MutualSubscriberPreview,
    NotificationActor,
    ProfileCalendarItem,
    ProfileCalendarResponse,
    ProfileEventListResponse,
    PublicProfileResponse,
    SubscribedEventItem,
    SubscribedEventListResponse,
    SubscribedEventVia,
    SubscribedUser,
    SubscriberListResponse,
    SubscriberUser,
    SubscriptionActionResponse,
    SubscriptionListResponse,
    SuggestedUsersResponse,
    UpdateBioRequest,
    UpdateSocialLinksRequest,
    UpdateVisibilityRequest,
    UserSearchResponse,
    UserSearchResult,
)
from backend.db.database import get_session
from backend.db.models import (
    CachedEvent,
    CalendarSetting,
    CalendarSubscription,
    EventSuggestion,
    User,
    UserEventAttendance,
    UserFollow,
    UserSavedEvent,
)
from backend.services.notifications import notify_new_follower, notify_new_friend
from backend.config.loader import get_admin_email

router = APIRouter(prefix="/api/social", tags=["social"])
limiter = Limiter(key_func=client_ip)


# --- Helpers ----------------------------------------------------------------


def _resolve_handle(session: Session, handle: str) -> User:
    """Look up an active user by case-insensitive handle, or raise 404."""
    h = (handle or "").strip().lower()
    if not h:
        raise HTTPException(status_code=404, detail="User not found")
    user = session.exec(
        select(User).where((func.lower(User.handle) == h) & (User.deleted_at.is_(None)))
    ).first()
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    return user


def _followers_count(session: Session, user_id: UUID) -> int:
    return int(
        session.exec(
            select(func.count(UserFollow.id)).where(UserFollow.followee_id == user_id)
        ).one()
    )


def _subscribers_count(session: Session, user_id: UUID) -> int:
    """How many users have subscribed to this owner's shared calendar."""
    return int(
        session.exec(
            select(func.count(CalendarSubscription.id)).where(
                CalendarSubscription.target_user_id == user_id
            )
        ).one()
    )


def _following_count(session: Session, user_id: UUID) -> int:
    return int(
        session.exec(
            select(func.count(UserFollow.id)).where(UserFollow.follower_id == user_id)
        ).one()
    )


def _friend_count(session: Session, user_id: UUID) -> int:
    """Total mutual follows (friends) of ``user_id``."""
    f1 = aliased(UserFollow)
    f2 = aliased(UserFollow)
    sub = (
        select(func.count())
        .select_from(f1)
        .join(
            f2,
            (f2.follower_id == f1.followee_id) & (f2.followee_id == f1.follower_id),
        )
        .where(f1.follower_id == user_id)
    )
    return int(session.exec(sub).one())


def _going_count_30d(session: Session, user_id: UUID) -> int:
    """Phase D: count of public Going attendances in the last 30 days for a user.

    Joined to ``cached_events`` so we only count events that still exist
    (not soft-deleted, not hidden) and whose start falls in the window.
    Used for the profile stat row; the caller is responsible for visibility
    gating (this function does not check ``can_view``).
    """
    cutoff = datetime.utcnow() - timedelta(days=30)
    return int(
        session.exec(
            select(func.count(UserEventAttendance.id))
            .join(
                CachedEvent,
                CachedEvent.event_id == UserEventAttendance.event_id,
            )
            .where(UserEventAttendance.user_id == user_id)
            .where(UserEventAttendance.share_publicly == True)  # noqa: E712
            .where(CachedEvent.start >= cutoff)
            .where(CachedEvent.deleted_at.is_(None))
            .where(CachedEvent.is_hidden == False)  # noqa: E712
        ).one()
    )


def _mutual_subscribers(
    session: Session, viewer_id: UUID, owner_id: UUID, preview_limit: int = 3
) -> tuple[list[MutualSubscriberPreview], int]:
    """Phase D: subscribers of ``owner_id`` whom ``viewer_id`` also follows
    or is subscribed to.

    Used to render "Subscribed to by @alice, @bob and N others" on the
    public profile. Returns up to ``preview_limit`` preview cards plus the
    untruncated total.

    Returns ``([], 0)`` when viewer == owner (the chip is hidden in that
    case at render time anyway).
    """
    if viewer_id == owner_id:
        return [], 0
    # Set of users the viewer "considers" as their network: anyone they
    # follow or are subscribed to. Both signals are voluntary so combining
    # them maximises the chance of a non-empty mutual set without
    # needing a friend relationship.
    viewer_network = (
        select(UserFollow.followee_id).where(UserFollow.follower_id == viewer_id)
    ).union(
        select(CalendarSubscription.target_user_id).where(
            CalendarSubscription.subscriber_id == viewer_id
        )
    )
    # Subscribers of the owner who are also in the viewer's network.
    matched = (
        select(CalendarSubscription.subscriber_id)
        .where(CalendarSubscription.target_user_id == owner_id)
        .where(CalendarSubscription.subscriber_id.in_(viewer_network))
    )
    total = int(
        session.exec(select(func.count()).select_from(matched.subquery())).one()
    )
    if total == 0:
        return [], 0
    rows = session.exec(
        select(User)
        .where(User.id.in_(matched))
        .where(User.deleted_at.is_(None))
        .order_by(User.display_name.asc(), User.handle.asc())
        .limit(preview_limit)
    ).all()
    previews = [
        MutualSubscriberPreview(
            handle=u.handle or "",
            display_name=u.display_name,
            avatar_url=u.avatar_url,
        )
        for u in rows
    ]
    return previews, total


def _mutual_friends_count(session: Session, viewer_id: UUID, owner_id: UUID) -> int:
    """Count of users who are mutual friends with BOTH viewer and owner.

    "Friend of X" = user U such that U follows X and X follows U. We compute
    this by self-joining ``user_follows`` to find users who are friends of
    ``viewer_id`` and intersecting with the friend set of ``owner_id``.
    Returns 0 when viewer == owner.
    """
    if viewer_id == owner_id:
        return 0
    # CTE-style subqueries: friends_of(viewer), friends_of(owner)
    fv1 = aliased(UserFollow)
    fv2 = aliased(UserFollow)
    viewer_friends = (
        select(fv1.followee_id)
        .join(
            fv2,
            (fv2.follower_id == fv1.followee_id) & (fv2.followee_id == fv1.follower_id),
        )
        .where(fv1.follower_id == viewer_id)
    )
    fo1 = aliased(UserFollow)
    fo2 = aliased(UserFollow)
    owner_friends = (
        select(fo1.followee_id)
        .join(
            fo2,
            (fo2.follower_id == fo1.followee_id) & (fo2.followee_id == fo1.follower_id),
        )
        .where(fo1.follower_id == owner_id)
    )
    vsub = viewer_friends.subquery()
    osub = owner_friends.subquery()
    rows = session.exec(
        select(func.count()).select_from(
            vsub.join(osub, vsub.c.followee_id == osub.c.followee_id)
        )
    ).one()
    # ``func.count()`` over a joined subquery returns an int directly.
    return int(rows if not isinstance(rows, tuple) else rows[0])


def _mutual_friends_who_follow(
    session: Session, viewer_id: UUID, organizer_id: UUID
) -> int:
    """Phase E (E10): viewer's friends who follow ``organizer_id``.

    Used as a trust signal on verified-organizer profiles. Returns 0
    for self-views (the viewer always implicitly knows themselves).
    Anonymous viewers do not call this (caller short-circuits).
    """
    if viewer_id == organizer_id:
        return 0
    # Friends of viewer = U s.t. viewer↔U mutual.
    fv1 = aliased(UserFollow)
    fv2 = aliased(UserFollow)
    viewer_friends = (
        select(fv1.followee_id)
        .join(
            fv2,
            (fv2.follower_id == fv1.followee_id) & (fv2.followee_id == fv1.follower_id),
        )
        .where(fv1.follower_id == viewer_id)
    ).subquery()
    # Followers of organizer.
    organizer_followers = (
        select(UserFollow.follower_id).where(UserFollow.followee_id == organizer_id)
    ).subquery()
    rows = session.exec(
        select(func.count()).select_from(
            viewer_friends.join(
                organizer_followers,
                viewer_friends.c.followee_id == organizer_followers.c.follower_id,
            )
        )
    ).one()
    return int(rows if not isinstance(rows, tuple) else rows[0])


def _to_follow_user(
    session: Session, viewer_id: Optional[UUID], target: User
) -> FollowUserResponse:
    is_friend = (
        viewer_id is not None
        and viewer_id != target.id
        and is_mutual_follow(session, viewer_id, target.id)
    )
    return FollowUserResponse(
        handle=target.handle or "",
        display_name=target.display_name,
        avatar_url=target.avatar_url,
        is_verified_organizer=target.is_verified_organizer,
        is_friend=is_friend,
    )


def _list_users(
    session: Session,
    user_ids_subquery,
    viewer: Optional[User],
    limit: int,
    offset: int,
) -> FollowListResponse:
    total = int(
        session.exec(
            select(func.count()).select_from(user_ids_subquery.subquery())
        ).one()
    )
    rows = session.exec(
        select(User)
        .where(User.id.in_(user_ids_subquery))
        .where(User.deleted_at.is_(None))
        .order_by(User.display_name.asc(), User.handle.asc())
        .limit(limit)
        .offset(offset)
    ).all()
    viewer_id = viewer.id if viewer else None
    return FollowListResponse(
        items=[_to_follow_user(session, viewer_id, u) for u in rows],
        total=total,
    )


# --- Public profile ----------------------------------------------------------


@router.get("/users/{handle}", response_model=PublicProfileResponse)
def get_public_profile(
    handle: str,
    session: Session = Depends(get_session),
    viewer: User | None = Depends(get_current_user_optional),
):
    """Return the public profile shown on /u/{handle}.

    Email is never returned. Visibility flags are echoed so the client can
    render "private" labels for tabs the viewer is not allowed to see, but
    no counts or items from those tabs leak through this endpoint.
    """
    target = _resolve_handle(session, handle)
    is_self = viewer is not None and viewer.id == target.id
    is_following = False
    follows_you = False
    is_friend = False
    if viewer is not None and not is_self:
        is_following = (
            session.exec(
                select(UserFollow.id).where(
                    (UserFollow.follower_id == viewer.id)
                    & (UserFollow.followee_id == target.id)
                )
            ).first()
            is not None
        )
        follows_you = (
            session.exec(
                select(UserFollow.id).where(
                    (UserFollow.follower_id == target.id)
                    & (UserFollow.followee_id == viewer.id)
                )
            ).first()
            is not None
        )
        is_friend = is_following and follows_you
    # Subscribe-to-calendar state (Phase B): only meaningful for authenticated
    # non-self viewers. ``can_view_calendar`` mirrors the chokepoint used by
    # POST /subscribe so the UI can hide the CTA when it would 404.
    can_view_calendar = False
    is_subscribed = False
    notify_new_events = True
    if viewer is not None and not is_self:
        can_view_calendar = can_view(session, viewer, target)
        sub = _get_subscription(session, viewer.id, target.id)
        is_subscribed = sub is not None
        if sub is not None:
            notify_new_events = bool(sub.notify_new_events)
    # 30-day public-going count, gated by account visibility so we don't
    # leak activity that the user has hidden.
    going_count_30d = 0
    if can_view(session, viewer, target):
        going_count_30d = _going_count_30d(session, target.id)
    # Phase D: mutual subscribers ("subscribed to by @a, @b and N others").
    # Hidden for anon viewers and for self.
    mutual_previews: list[MutualSubscriberPreview] = []
    mutual_total = 0
    if viewer is not None and not is_self:
        mutual_previews, mutual_total = _mutual_subscribers(
            session, viewer.id, target.id
        )
    return PublicProfileResponse(
        handle=target.handle or "",
        display_name=target.display_name,
        avatar_url=target.avatar_url,
        is_verified_organizer=target.is_verified_organizer,
        instagram_url=target.instagram_url,
        facebook_url=target.facebook_url,
        bio=target.bio,
        member_since=target.created_at,
        followers_count=_followers_count(session, target.id),
        following_count=_following_count(session, target.id),
        subscribers_count=_subscribers_count(session, target.id),
        going_count_30d=going_count_30d,
        is_self=is_self,
        is_following=is_following,
        follows_you=follows_you,
        is_friend=is_friend,
        account_visibility=target.account_visibility,
        friend_count=_friend_count(session, target.id),
        mutual_friend_count=(
            _mutual_friends_count(session, viewer.id, target.id)
            if viewer is not None and not is_self
            else 0
        ),
        share_attendance_default_audience=(
            target.share_attendance_default_audience
            or ("public" if target.share_attendance_default else "private")
        ),
        can_view_calendar=can_view_calendar,
        is_subscribed=is_subscribed,
        notify_new_events=notify_new_events,
        mutual_subscribers=mutual_previews,
        mutual_subscribers_count=mutual_total,
        mutual_friends_who_follow=(
            _mutual_friends_who_follow(session, viewer.id, target.id)
            if (viewer is not None and not is_self and target.is_verified_organizer)
            else 0
        ),
    )


# --- Follow / Unfollow -------------------------------------------------------


@router.post(
    "/users/{handle}/follow",
    response_model=FollowActionResponse,
    status_code=201,
)
@limiter.limit("60/hour")
def follow_user(
    request: Request,
    handle: str,
    session: Session = Depends(get_session),
    viewer: User = Depends(require_user),
):
    target = _resolve_handle(session, handle)
    if target.id == viewer.id:
        raise HTTPException(status_code=400, detail="Cannot follow yourself")
    existing = session.exec(
        select(UserFollow).where(
            (UserFollow.follower_id == viewer.id)
            & (UserFollow.followee_id == target.id)
        )
    ).first()
    is_new_follow = existing is None
    if is_new_follow:
        session.add(UserFollow(follower_id=viewer.id, followee_id=target.id))
        notify_new_follower(session, followee=target, follower=viewer)
    # Phase B: Follow now implies Subscribe-to-calendar so the social graph
    # produces actual user-facing value (notifications + feed inclusion).
    # Idempotent: if a subscription already exists we leave its
    # ``notify_new_events`` flag intact so unfollow→refollow doesn't
    # surprise-toggle the bell.
    # Follow always creates the implied subscription, regardless of the
    # target's account visibility. Visibility only controls whether the
    # subscriber sees content on the target's profile and in their feed;
    # the relationship itself is unconditional so a follow back can
    # promote both sides to mutual-friend status without manual fixup.
    sub = _get_subscription(session, viewer.id, target.id)
    if sub is None:
        sub = CalendarSubscription(
            subscriber_id=viewer.id,
            target_user_id=target.id,
            notify_new_events=True,
        )
        session.add(sub)
    session.commit()
    is_friend = is_mutual_follow(session, viewer.id, target.id)
    # Mutual-follow promotion: when the follow that just landed produced a
    # mutual-friendship, also create the reverse subscription so both
    # sides immediately see each other in their subscribed-events feed.
    if is_friend:
        reverse_sub = _get_subscription(session, target.id, viewer.id)
        needs_commit = False
        if reverse_sub is None:
            session.add(
                CalendarSubscription(
                    subscriber_id=target.id,
                    target_user_id=viewer.id,
                    notify_new_events=True,
                )
            )
            needs_commit = True
        if is_new_follow:
            notify_new_friend(session, user_a=target, user_b=viewer)
            needs_commit = True
        if needs_commit:
            session.commit()
    sub_after = _get_subscription(session, viewer.id, target.id)
    return FollowActionResponse(
        handle=target.handle or "",
        is_following=True,
        is_friend=is_friend,
        followers_count=_followers_count(session, target.id),
        is_subscribed=sub_after is not None,
        notify_new_events=bool(sub_after.notify_new_events) if sub_after else False,
    )


@router.delete(
    "/users/{handle}/follow",
    response_model=FollowActionResponse,
)
@limiter.limit("60/hour")
def unfollow_user(
    request: Request,
    handle: str,
    session: Session = Depends(get_session),
    viewer: User = Depends(require_user),
):
    target = _resolve_handle(session, handle)
    if target.id == viewer.id:
        raise HTTPException(status_code=400, detail="Cannot unfollow yourself")
    existing = session.exec(
        select(UserFollow).where(
            (UserFollow.follower_id == viewer.id)
            & (UserFollow.followee_id == target.id)
        )
    ).first()
    if existing is not None:
        session.delete(existing)
    # Phase B: unfollow also drops the implied calendar subscription so
    # the user stops receiving notifications and feed entries.
    sub = _get_subscription(session, viewer.id, target.id)
    if sub is not None:
        session.delete(sub)
    session.commit()
    return FollowActionResponse(
        handle=target.handle or "",
        is_following=False,
        is_friend=False,
        followers_count=_followers_count(session, target.id),
        is_subscribed=False,
        notify_new_events=False,
    )


@router.patch(
    "/users/{handle}/follow/notify",
    response_model=FollowActionResponse,
)
@limiter.limit("60/hour")
def set_follow_notify(
    request: Request,
    handle: str,
    payload: FollowNotifyRequest,
    session: Session = Depends(get_session),
    viewer: User = Depends(require_user),
):
    """Toggle the notification bell on the implied calendar subscription
    that was created when ``viewer`` followed ``handle``. Does not affect
    the ``UserFollow`` row.

    404 if the viewer is not currently following ``handle`` (the bell
    only exists in the Following state).
    """
    target = _resolve_handle(session, handle)
    follow = session.exec(
        select(UserFollow).where(
            (UserFollow.follower_id == viewer.id)
            & (UserFollow.followee_id == target.id)
        )
    ).first()
    if follow is None:
        raise HTTPException(status_code=404, detail="Not following")
    sub = _get_subscription(session, viewer.id, target.id)
    if sub is None:
        # Re-create the implied subscription if it was somehow lost (e.g.
        # legacy follow row predating the merge). Always allowed since
        # the underlying follow already exists.
        sub = CalendarSubscription(
            subscriber_id=viewer.id,
            target_user_id=target.id,
            notify_new_events=payload.notify_new_events,
        )
        session.add(sub)
    else:
        sub.notify_new_events = payload.notify_new_events
        session.add(sub)
    session.commit()
    is_friend = is_mutual_follow(session, viewer.id, target.id)
    return FollowActionResponse(
        handle=target.handle or "",
        is_following=True,
        is_friend=is_friend,
        followers_count=_followers_count(session, target.id),
        is_subscribed=True,
        notify_new_events=bool(sub.notify_new_events),
    )


# --- Followers / Following / Friends listings --------------------------------


def _ensure_can_list(
    session: Session,
    viewer: User | None,
    target: User,
) -> None:
    """Guard list endpoints using the single account-visibility gate.
    Self always allowed."""
    if viewer is not None and viewer.id == target.id:
        return
    if not can_view(session, viewer, target):
        # 404 to avoid leaking existence of restricted resources.
        raise HTTPException(status_code=404, detail="Not found")


@router.get(
    "/users/{handle}/followers",
    response_model=FollowListResponse,
)
def list_followers(
    handle: str,
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_session),
    viewer: User | None = Depends(get_current_user_optional),
):
    target = _resolve_handle(session, handle)
    _ensure_can_list(session, viewer, target)
    sub = select(UserFollow.follower_id).where(UserFollow.followee_id == target.id)
    return _list_users(session, sub, viewer, limit, offset)


@router.get(
    "/users/{handle}/following",
    response_model=FollowListResponse,
)
def list_following(
    handle: str,
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_session),
    viewer: User | None = Depends(get_current_user_optional),
):
    target = _resolve_handle(session, handle)
    _ensure_can_list(session, viewer, target)
    sub = select(UserFollow.followee_id).where(UserFollow.follower_id == target.id)
    return _list_users(session, sub, viewer, limit, offset)


@router.get("/me/followers", response_model=FollowListResponse)
def list_my_followers(
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_session),
    viewer: User = Depends(require_user),
):
    """Authenticated viewer's own followers list (self-view; no privacy
    gate beyond the auth requirement)."""
    sub = select(UserFollow.follower_id).where(UserFollow.followee_id == viewer.id)
    return _list_users(session, sub, viewer, limit, offset)


@router.get("/me/following", response_model=FollowListResponse)
def list_my_following(
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_session),
    viewer: User = Depends(require_user),
):
    """Authenticated viewer's own following list."""
    sub = select(UserFollow.followee_id).where(UserFollow.follower_id == viewer.id)
    return _list_users(session, sub, viewer, limit, offset)


@router.delete("/me/followers/{handle}", status_code=204)
@limiter.limit("60/hour")
def remove_my_follower(
    request: Request,
    handle: str,
    session: Session = Depends(get_session),
    viewer: User = Depends(require_user),
):
    """Owner-side removal of a specific follower (\"remove from your
    followers\"). Idempotent — returns 204 whether the row existed or
    not. Also drops the implied calendar subscription so the removed
    user stops receiving fan-out notifications.
    """
    target = session.exec(select(User).where(User.handle == handle.lower())).first()
    if target is None:
        return  # 204 \u2014 silently idempotent.
    follow = session.exec(
        select(UserFollow).where(
            (UserFollow.follower_id == target.id)
            & (UserFollow.followee_id == viewer.id)
        )
    ).first()
    if follow is not None:
        session.delete(follow)
    sub = _get_subscription(session, target.id, viewer.id)
    if sub is not None:
        session.delete(sub)
    session.commit()


@router.get(
    "/users/{handle}/mutual-friends",
    response_model=FollowListResponse,
)
def list_mutual_friends(
    handle: str,
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_session),
    viewer: User = Depends(require_user),
):
    """Mutual friends between the authenticated viewer and the profile owner.

    "Friend of X" = user U such that U follows X and X follows U. The
    intersection of viewer's friends and owner's friends is returned,
    sorted by display name. Empty list when viewer == owner.
    """
    target = _resolve_handle(session, handle)
    if target.id == viewer.id:
        return FollowListResponse(items=[], total=0)
    _ensure_can_list(session, viewer, target)
    fv1 = aliased(UserFollow)
    fv2 = aliased(UserFollow)
    viewer_friends = (
        select(fv1.followee_id)
        .join(
            fv2,
            (fv2.follower_id == fv1.followee_id) & (fv2.followee_id == fv1.follower_id),
        )
        .where(fv1.follower_id == viewer.id)
    )
    fo1 = aliased(UserFollow)
    fo2 = aliased(UserFollow)
    owner_friends = (
        select(fo1.followee_id)
        .join(
            fo2,
            (fo2.follower_id == fo1.followee_id) & (fo2.followee_id == fo1.follower_id),
        )
        .where(fo1.follower_id == target.id)
    )
    intersect_ids = select(viewer_friends.subquery().c.followee_id).where(
        viewer_friends.subquery().c.followee_id.in_(owner_friends)
    )
    base = (
        select(User).where(User.id.in_(intersect_ids)).where(User.deleted_at.is_(None))
    )
    total = int(session.exec(select(func.count()).select_from(base.subquery())).one())
    rows = session.exec(
        base.order_by(User.display_name.asc(), User.handle.asc())
        .limit(limit)
        .offset(offset)
    ).all()
    return FollowListResponse(
        items=[_to_follow_user(session, viewer.id, u) for u in rows],
        total=total,
    )


@router.get("/me/friends", response_model=FollowListResponse)
def list_my_friends(
    limit: int = Query(default=100, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    q: Optional[str] = Query(default=None, max_length=64),
    session: Session = Depends(get_session),
    viewer: User = Depends(require_user),
):
    """Mutual follows of the authenticated user. ``q`` filters by handle or
    display_name (case-insensitive substring) — used by the friend autocomplete
    in the explorer (Phase B)."""
    f1 = aliased(UserFollow)
    f2 = aliased(UserFollow)
    friends_sub = (
        select(f1.followee_id)
        .join(
            f2,
            (f2.follower_id == f1.followee_id) & (f2.followee_id == f1.follower_id),
        )
        .where(f1.follower_id == viewer.id)
    )
    base = select(User).where(User.id.in_(friends_sub)).where(User.deleted_at.is_(None))
    if q:
        like = f"%{q.lower()}%"
        base = base.where(
            or_(
                func.lower(User.handle).like(like),
                func.lower(User.display_name).like(like),
            )
        )
    total = int(session.exec(select(func.count()).select_from(base.subquery())).one())
    rows = session.exec(
        base.order_by(User.display_name.asc(), User.handle.asc())
        .limit(limit)
        .offset(offset)
    ).all()
    return FollowListResponse(
        items=[_to_follow_user(session, viewer.id, u) for u in rows],
        total=total,
    )


# Phase E (E9): friends leaderboard ranked by Going count over a window.
_LEADERBOARD_PERIODS = {"7d": 7, "30d": 30, "90d": 90}


@router.get(
    "/me/friends/leaderboard",
    response_model=FriendsLeaderboardResponse,
)
def friends_leaderboard(
    period: str = Query(default="30d", description="7d | 30d | 90d"),
    limit: int = Query(default=10, ge=1, le=50),
    session: Session = Depends(get_session),
    viewer: User = Depends(require_user),
):
    """Top friends by Going count over ``period``.

    Friends-only by design (no public/global leaderboard — explicit
    non-goal in PHASE_E doc). Ties broken by handle ASC for stability.
    Only counts attendances whose ``share_audience`` is ``public`` or
    ``friends`` — ``private`` rows are invisible to the viewer and so
    must not influence the ranking.
    """
    days = _LEADERBOARD_PERIODS.get(period)
    if days is None:
        raise HTTPException(
            status_code=400, detail="period must be one of 7d, 30d, 90d"
        )
    cutoff = datetime.utcnow() - timedelta(days=days)

    # Friend set (mutuals).
    f1 = aliased(UserFollow)
    f2 = aliased(UserFollow)
    friends_sub = (
        select(f1.followee_id)
        .join(
            f2,
            (f2.follower_id == f1.followee_id) & (f2.followee_id == f1.follower_id),
        )
        .where(f1.follower_id == viewer.id)
    ).subquery()

    # Going count per friend over the window. Visibility: friends ring
    # (viewer is a friend of every row in the leaderboard by definition,
    # so we admit ``public`` + ``friends`` and exclude ``private``).
    going_count_col = func.count(UserEventAttendance.id).label("going_count")
    rows = session.exec(
        select(User, going_count_col)
        .join(friends_sub, friends_sub.c.followee_id == User.id)
        .join(
            UserEventAttendance,
            UserEventAttendance.user_id == User.id,
        )
        .join(
            CachedEvent,
            CachedEvent.event_id == UserEventAttendance.event_id,
        )
        .where(User.deleted_at.is_(None))
        .where(UserEventAttendance.share_audience.in_(["public", "friends"]))
        .where(CachedEvent.start >= cutoff)
        .where(CachedEvent.deleted_at.is_(None))
        .where(CachedEvent.is_hidden == False)  # noqa: E712
        .group_by(User.id)
        .order_by(going_count_col.desc(), User.handle.asc())
        .limit(limit)
    ).all()

    items: list[FriendsLeaderboardEntry] = []
    for idx, row in enumerate(rows, start=1):
        u, count = row  # type: ignore[misc]
        items.append(
            FriendsLeaderboardEntry(
                rank=idx,
                handle=u.handle or "",
                display_name=u.display_name,
                avatar_url=u.avatar_url,
                is_verified_organizer=bool(u.is_verified_organizer),
                going_count=int(count),
            )
        )
    return FriendsLeaderboardResponse(period=period, items=items)


# --- Account: visibility + social links --------------------------------------


@router.patch("/me/visibility", response_model=PublicProfileResponse)
@limiter.limit("60/hour")
def update_visibility(
    request: Request,
    payload: UpdateVisibilityRequest,
    session: Session = Depends(get_session),
    viewer: User = Depends(require_user),
):
    """Update the single account-visibility setting."""
    if payload.account_visibility is not None:
        viewer.account_visibility = payload.account_visibility
    if payload.share_attendance_default_audience is not None:
        viewer.share_attendance_default_audience = (
            payload.share_attendance_default_audience
        )
        viewer.share_attendance_default = (
            payload.share_attendance_default_audience == "public"
        )
        viewer.share_attendance_default_set_by_user = True
    session.add(viewer)
    session.commit()
    session.refresh(viewer)
    # Return the same shape the profile endpoint returns so the Account page
    # doesn't need a separate refetch.
    return get_public_profile(viewer.handle or "", session=session, viewer=viewer)


@router.patch("/me/social-links", response_model=PublicProfileResponse)
@limiter.limit("20/hour")
def update_social_links(
    request: Request,
    payload: UpdateSocialLinksRequest,
    session: Session = Depends(get_session),
    viewer: User = Depends(require_user),
):
    """Set or clear the optional, unverified IG/FB profile links.

    URLs must point at the platform's domain to avoid surfacing arbitrary
    outbound links. Empty string clears the field.
    """
    if payload.instagram_url is not None:
        viewer.instagram_url = _validate_social_url(
            payload.instagram_url, ("instagram.com",)
        )
    if payload.facebook_url is not None:
        viewer.facebook_url = _validate_social_url(
            payload.facebook_url, ("facebook.com", "fb.com")
        )
    session.add(viewer)
    session.commit()
    session.refresh(viewer)
    return get_public_profile(viewer.handle or "", session=session, viewer=viewer)


def _validate_social_url(value: str, allowed_hosts: tuple[str, ...]) -> Optional[str]:
    v = (value or "").strip()
    if not v:
        return None
    if not v.startswith(("http://", "https://")):
        v = "https://" + v
    try:
        from urllib.parse import urlparse

        parsed = urlparse(v)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid URL") from exc
    host = (parsed.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    if host not in allowed_hosts:
        raise HTTPException(
            status_code=400,
            detail=f"URL must be on one of: {', '.join(allowed_hosts)}",
        )
    if len(v) > 255:
        raise HTTPException(status_code=400, detail="URL too long")
    return v


# --- Phase D: profile bio ---------------------------------------------------


def _normalize_bio(value: Optional[str]) -> Optional[str]:
    """Trim whitespace, strip control chars, enforce 280-char cap.

    Returns ``None`` for empty / whitespace-only inputs so the column can
    flip back to NULL ("no bio yet" rendering).
    """
    if value is None:
        return None
    # Strip C0/C1 control characters except whitespace inside the string
    # (newlines and tabs allowed). Tabs are converted to spaces to keep
    # the rendered card compact.
    cleaned_chars = []
    for ch in value.replace("\t", " "):
        if ch in ("\n", "\r"):
            cleaned_chars.append(ch)
            continue
        if ord(ch) < 0x20 or ord(ch) == 0x7F:
            continue
        cleaned_chars.append(ch)
    cleaned = "".join(cleaned_chars).strip()
    if not cleaned:
        return None
    if len(cleaned) > 280:
        # Defense in depth: pydantic max_length=280 will reject this on
        # input, but stripping control chars happens server-side and could
        # in theory rebalance length. Truncate rather than 400.
        cleaned = cleaned[:280].rstrip()
    return cleaned


@router.patch("/me/bio", response_model=PublicProfileResponse)
@limiter.limit("30/hour")
def update_bio(
    request: Request,
    payload: UpdateBioRequest,
    session: Session = Depends(get_session),
    viewer: User = Depends(require_user),
):
    """Set or clear the user's free-form bio (Phase D).

    Empty string clears the field. Always returns the same shape as
    ``GET /api/social/users/{handle}`` so the Account page doesn't need a
    separate refetch after saving.
    """
    viewer.bio = _normalize_bio(payload.bio)
    session.add(viewer)
    session.commit()
    session.refresh(viewer)
    return get_public_profile(viewer.handle or "", session=session, viewer=viewer)


# --- Phase D: profile content tabs ------------------------------------------


_PROFILE_TAB_LIMIT_DEFAULT = 20
_PROFILE_TAB_LIMIT_MAX = 50


def _hydrate_profile_events(
    session: Session,
    event_ids: list[str],
    *,
    include_past: bool,
    limit: int,
    offset: int,
) -> tuple[list[CachedEvent], int]:
    """Load CachedEvent rows for a profile tab.

    Filters out soft-deleted, hidden, and (by default) past events. Past
    events sort newest-first; upcoming sort earliest-first. Returns
    ``(page, total)`` so the caller can build a paginated response.
    """
    if not event_ids:
        return [], 0
    enabled_calendar_ids = {
        c.calendar_id
        for c in session.exec(
            select(CalendarSetting).where(CalendarSetting.enabled == True)  # noqa: E712
        ).all()
    }
    if not enabled_calendar_ids:
        return [], 0
    now = datetime.utcnow()
    stmt = (
        select(CachedEvent)
        .where(col(CachedEvent.event_id).in_(event_ids))
        .where(col(CachedEvent.calendar_id).in_(enabled_calendar_ids))
        .where(CachedEvent.deleted_at.is_(None))
        .where(CachedEvent.is_hidden == False)  # noqa: E712
    )
    if not include_past:
        stmt = stmt.where(CachedEvent.start >= now)
    rows = list(session.exec(stmt).all())
    if include_past:
        rows.sort(key=lambda e: e.start, reverse=True)
    else:
        rows.sort(key=lambda e: e.start)
    total = len(rows)
    page = rows[offset : offset + limit]
    return page, total


@router.get(
    "/users/{handle}/going",
    response_model=ProfileEventListResponse,
)
@limiter.limit("60/minute")
def list_user_going(
    request: Request,
    handle: str,
    include_past: bool = Query(
        default=False,
        description=(
            "Include past events (start < now). When False (default) the "
            "list is restricted to upcoming events sorted earliest-first."
        ),
    ),
    limit: int = Query(
        default=_PROFILE_TAB_LIMIT_DEFAULT, ge=1, le=_PROFILE_TAB_LIMIT_MAX
    ),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_session),
    viewer: User | None = Depends(get_current_user_optional),
):
    """Public Going list for the /u/{handle} Going tab.

    Account-visibility-gated by ``can_view`` and further restricted to
    attendances whose ``share_audience`` admits the viewer (public to
    all; friends only to mutual followers; private hidden). Responds
    with **404** on visibility denial to avoid leaking the existence
    of a restricted profile.
    """
    target = _resolve_handle(session, handle)
    if not can_view(session, viewer, target):
        raise HTTPException(status_code=404, detail="Not found")
    rows = session.exec(
        select(
            UserEventAttendance.event_id,
            UserEventAttendance.share_audience,
        ).where(UserEventAttendance.user_id == target.id)
    ).all()
    # Per-row audience gate — public always, friends iff mutual follow.
    event_ids = list(
        {
            eid
            for (eid, audience) in rows
            if eid and _audience_passes(session, viewer, target, audience or "private")
        }
    )
    page, total = _hydrate_profile_events(
        session, event_ids, include_past=include_past, limit=limit, offset=offset
    )
    return ProfileEventListResponse(
        items=serialize_events(session, page),
        total=total,
        limit=limit,
        offset=offset,
    )


@router.get(
    "/users/{handle}/saved",
    response_model=ProfileEventListResponse,
)
@limiter.limit("60/minute")
def list_user_saved(
    request: Request,
    handle: str,
    limit: int = Query(
        default=_PROFILE_TAB_LIMIT_DEFAULT, ge=1, le=_PROFILE_TAB_LIMIT_MAX
    ),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_session),
    viewer: User | None = Depends(get_current_user_optional),
):
    """Public Saved list for the /u/{handle} Saved tab.

    Account-visibility-gated by ``can_view``. Each saved row carries its
    own audience that further narrows visibility to public / friends /
    private. Upcoming-only — saved is forward-looking by intent.
    """
    target = _resolve_handle(session, handle)
    if not can_view(session, viewer, target):
        raise HTTPException(status_code=404, detail="Not found")
    rows = session.exec(
        select(UserSavedEvent.event_id, UserSavedEvent.audience).where(
            UserSavedEvent.user_id == target.id
        )
    ).all()
    event_ids = list(
        {
            eid
            for (eid, audience) in rows
            if eid and _audience_passes(session, viewer, target, audience or "private")
        }
    )
    page, total = _hydrate_profile_events(
        session, event_ids, include_past=False, limit=limit, offset=offset
    )
    return ProfileEventListResponse(
        items=serialize_events(session, page),
        total=total,
        limit=limit,
        offset=offset,
    )


@router.get(
    "/users/{handle}/calendar",
    response_model=ProfileCalendarResponse,
)
@limiter.limit("60/minute")
def list_user_calendar(
    request: Request,
    handle: str,
    include_past: bool = Query(default=False),
    limit: int = Query(
        default=_PROFILE_TAB_LIMIT_DEFAULT, ge=1, le=_PROFILE_TAB_LIMIT_MAX
    ),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_session),
    viewer: User | None = Depends(get_current_user_optional),
):
    """Unified Calendar tab for /u/{handle} — union of Going + Saved.

    Each row is filtered with the simplified two-step rule
    (``can_view_event_in_calendar``): the per-event audience AND the
    owner's account visibility must both admit the viewer. Rows where
    the owner has both saved and RSVP'd-going to the same event are
    merged with ``intent='both'``.

    Responds with **404** when account visibility denies the viewer.
    """
    target = _resolve_handle(session, handle)
    if not can_view(session, viewer, target):
        raise HTTPException(status_code=404, detail="Not found")

    going_rows = session.exec(
        select(
            UserEventAttendance.event_id,
            UserEventAttendance.share_audience,
        ).where(UserEventAttendance.user_id == target.id)
    ).all()
    saved_rows = session.exec(
        select(
            UserSavedEvent.event_id,
            UserSavedEvent.audience,
        ).where(UserSavedEvent.user_id == target.id)
    ).all()

    intent_by_event: dict[str, str] = {}
    for event_id, audience in going_rows:
        if not event_id:
            continue
        if not can_view_event_in_calendar(
            session, viewer, target, audience or "private"
        ):
            continue
        intent_by_event[event_id] = "going"
    for event_id, audience in saved_rows:
        if not event_id:
            continue
        if not can_view_event_in_calendar(
            session, viewer, target, audience or "private"
        ):
            continue
        if event_id in intent_by_event:
            intent_by_event[event_id] = "both"
        else:
            intent_by_event[event_id] = "saved"

    event_ids = list(intent_by_event.keys())
    page, total = _hydrate_profile_events(
        session, event_ids, include_past=include_past, limit=limit, offset=offset
    )
    serialized = serialize_events(session, page)
    items = [
        ProfileCalendarItem(
            event=ev,
            intent=intent_by_event.get(ev.event_id, "saved"),
        )
        for ev in serialized
    ]
    return ProfileCalendarResponse(
        items=items,
        total=total,
        limit=limit,
        offset=offset,
    )


@router.get(
    "/users/{handle}/suggested",
    response_model=ProfileEventListResponse,
)
@limiter.limit("60/minute")
def list_user_suggested(
    request: Request,
    handle: str,
    limit: int = Query(
        default=_PROFILE_TAB_LIMIT_DEFAULT, ge=1, le=_PROFILE_TAB_LIMIT_MAX
    ),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_session),
    viewer: User | None = Depends(get_current_user_optional),
):
    """Approved suggestions submitted by ``handle`` (Phase D).

    Always public (suggested-by attribution is already a public field on
    the event card). Restricted to ``status='approved'`` rows linked to a
    cached event via ``created_event_id``; pending/rejected rows are
    invisible. Upcoming-only.
    """
    target = _resolve_handle(session, handle)
    rows = session.exec(
        select(EventSuggestion.created_event_id)
        .where(EventSuggestion.submitter_user_id == target.id)
        .where(EventSuggestion.status == "approved")
        .where(EventSuggestion.created_event_id.is_not(None))
    ).all()
    event_ids = list({eid for eid in rows if eid})
    page, total = _hydrate_profile_events(
        session, event_ids, include_past=False, limit=limit, offset=offset
    )
    return ProfileEventListResponse(
        items=serialize_events(session, page),
        total=total,
        limit=limit,
        offset=offset,
    )


# --- Phase D: discovery (search + friends-of-friends suggested) -------------


def _user_to_search_result(
    session: Session,
    viewer: Optional[User],
    user: User,
    *,
    subscriber_ids: Optional[set[UUID]] = None,
) -> UserSearchResult:
    """Project a ``User`` row into the discovery card shape.

    ``subscriber_ids`` lets the caller batch-precompute the viewer's
    current subscriptions to avoid an N+1 over the result page.
    """
    is_subscribed = False
    if viewer is not None and viewer.id != user.id:
        if subscriber_ids is not None:
            is_subscribed = user.id in subscriber_ids
        else:
            is_subscribed = _get_subscription(session, viewer.id, user.id) is not None
    return UserSearchResult(
        handle=user.handle or "",
        display_name=user.display_name,
        avatar_url=user.avatar_url,
        is_verified_organizer=bool(user.is_verified_organizer),
        subscribers_count=_subscribers_count(session, user.id),
        is_subscribed=is_subscribed,
    )


def _viewer_subscription_ids(session: Session, viewer: User) -> set[UUID]:
    """Cached set of target_user_id for the viewer's current subscriptions."""
    rows = session.exec(
        select(CalendarSubscription.target_user_id).where(
            CalendarSubscription.subscriber_id == viewer.id
        )
    ).all()
    return {r for r in rows}


@router.get(
    "/search/users",
    response_model=UserSearchResponse,
)
@limiter.limit("30/minute")
def search_users(
    request: Request,
    q: str = Query(..., min_length=1, max_length=64),
    limit: int = Query(default=10, ge=1, le=25),
    session: Session = Depends(get_session),
    viewer: User | None = Depends(get_current_user_optional),
):
    """Case-insensitive prefix search on handle and display_name.

    Excludes soft-deleted users. Friends-only accounts remain enumerable
    (their profile body is gated separately by ``can_view``); the only
    truly hidden accounts are those soft-deleted.

    Rate-limited 30/min/IP. Returns up to ``limit`` cards (default 10,
    max 25).
    """
    needle = (q or "").strip().lower()
    if not needle:
        return UserSearchResponse(items=[])
    like = f"{needle}%"
    stmt = (
        select(User)
        .where(User.deleted_at.is_(None))
        .where(
            or_(
                func.lower(User.handle).like(like),
                func.lower(User.display_name).like(like),
            )
        )
    )
    stmt = stmt.order_by(
        User.is_verified_organizer.desc(),
        User.handle.asc(),
    ).limit(limit)
    rows = session.exec(stmt).all()
    sub_ids = _viewer_subscription_ids(session, viewer) if viewer else None
    return UserSearchResponse(
        items=[
            _user_to_search_result(session, viewer, u, subscriber_ids=sub_ids)
            for u in rows
        ]
    )


@router.get(
    "/discover/suggested",
    response_model=SuggestedUsersResponse,
)
@limiter.limit("60/hour")
def discover_suggested(
    request: Request,
    limit: int = Query(default=10, ge=1, le=25),
    session: Session = Depends(get_session),
    viewer: User | None = Depends(get_current_user_optional),
):
    """Friends-of-friends discovery (Phase D, D.2.b).

    Surfaces users that the people **you** are subscribed to (or follow)
    are themselves subscribed to, excluding self and people you already
    follow/subscribe to. Ranked by count of distinct intermediaries
    ("subscribed to by N of your people") then by absolute subscribers
    count as a tiebreak.

    Anonymous viewers receive an empty list — discovery is intentionally
    a logged-in surface; anon users use ``/users/search`` instead.
    """
    if viewer is None:
        return SuggestedUsersResponse(items=[])

    # Viewer's "network" = anyone they follow OR are subscribed to.
    network_ids: set[UUID] = set()
    network_ids.update(
        session.exec(
            select(UserFollow.followee_id).where(UserFollow.follower_id == viewer.id)
        ).all()
    )
    network_ids.update(
        session.exec(
            select(CalendarSubscription.target_user_id).where(
                CalendarSubscription.subscriber_id == viewer.id
            )
        ).all()
    )
    if not network_ids:
        return SuggestedUsersResponse(items=[])

    # People that the viewer's network is subscribed to. Exclude users
    # the viewer already follows or subscribes to, and self.
    excluded: set[UUID] = set(network_ids)
    excluded.add(viewer.id)
    rows = session.exec(
        select(
            CalendarSubscription.target_user_id,
            func.count(CalendarSubscription.subscriber_id).label("intermediaries"),
        )
        .where(CalendarSubscription.subscriber_id.in_(network_ids))
        .where(~CalendarSubscription.target_user_id.in_(excluded))
        .group_by(CalendarSubscription.target_user_id)
    ).all()
    if not rows:
        return SuggestedUsersResponse(items=[])

    # Rank by intermediary count desc, then by absolute subscriber count
    # desc as a tiebreak. ``_subscribers_count`` is cheap (one query per
    # candidate) and the result set is bounded by ``limit`` * a small
    # multiplier.
    ranked = sorted(rows, key=lambda r: (-int(r[1]), str(r[0])))[
        : max(limit * 3, limit)
    ]
    candidate_ids = [r[0] for r in ranked]

    candidates = list(
        session.exec(
            select(User)
            .where(User.id.in_(candidate_ids))
            .where(User.deleted_at.is_(None))
        ).all()
    )
    intermediary_count = {r[0]: int(r[1]) for r in ranked}
    candidates.sort(
        key=lambda u: (
            -intermediary_count.get(u.id, 0),
            -_subscribers_count(session, u.id),
            (u.handle or ""),
        )
    )
    candidates = candidates[:limit]

    sub_ids = _viewer_subscription_ids(session, viewer)
    return SuggestedUsersResponse(
        items=[
            _user_to_search_result(session, viewer, u, subscriber_ids=sub_ids)
            for u in candidates
        ]
    )


# --- Admin: verified-organizer toggle ----------------------------------------


class _VerifiedToggleRequest(BaseModel):
    is_verified_organizer: bool


@router.patch("/admin/users/{handle}/verified", response_model=PublicProfileResponse)
def admin_set_verified_organizer(
    handle: str,
    payload: _VerifiedToggleRequest,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """Admin-only: mark/unmark a user as a verified event organizer.

    The flag drives the small badge rendered on the public profile and is
    intended for organizers we have manually vetted off-platform.
    """
    user = _resolve_handle(session, handle)
    user.is_verified_organizer = bool(payload.is_verified_organizer)
    session.add(user)
    session.commit()
    session.refresh(user)
    return get_public_profile(user.handle or "", session=session, viewer=None)


# --- Admin: users management (list + hard-delete) ---------------------------


@router.get("/admin/users", response_model=AdminUserListResponse)
def admin_list_users(
    q: Optional[str] = Query(default=None, max_length=120),
    include_deleted: bool = Query(default=False),
    verified_only: bool = Query(default=False),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """List users for the admin Users tab.

    Search ``q`` matches against handle / display_name / email (case
    insensitive, substring). ``include_deleted`` surfaces soft-deleted rows
    (their email is the anonymised ``deleted-<uuid>@example.invalid`` form).
    Returns counts joined per row so the table can flag accounts with
    unusual social activity.
    """
    stmt = select(User)
    if not include_deleted:
        stmt = stmt.where(User.deleted_at.is_(None))
    if verified_only:
        stmt = stmt.where(User.is_verified_organizer == True)  # noqa: E712
    if q:
        needle = f"%{q.strip().lower()}%"
        stmt = stmt.where(
            or_(
                func.lower(User.handle).like(needle),
                func.lower(User.display_name).like(needle),
                func.lower(User.email).like(needle),
            )
        )
    total = int(session.exec(select(func.count()).select_from(stmt.subquery())).one())
    rows = session.exec(
        stmt.order_by(User.created_at.desc()).limit(limit).offset(offset)
    ).all()

    admin_email = (get_admin_email() or "").lower()
    items: list[AdminUser] = []
    for u in rows:
        items.append(
            AdminUser(
                user_id=str(u.id),
                email=u.email,
                handle=u.handle,
                display_name=u.display_name,
                avatar_url=u.avatar_url,
                is_admin=bool(admin_email and u.email.lower() == admin_email),
                is_verified_organizer=bool(u.is_verified_organizer),
                deleted_at=u.deleted_at,
                created_at=u.created_at,
                followers_count=_followers_count(session, u.id),
                following_count=_following_count(session, u.id),
            )
        )
    return AdminUserListResponse(items=items, total=total)


@router.delete("/admin/users/{handle}", status_code=200)
def admin_delete_user(
    handle: str,
    session: Session = Depends(get_session),
    admin: dict = Depends(require_admin),
):
    """Admin-initiated account deletion.

    Reuses the same purge helper as ``DELETE /api/auth/me`` so the social
    edge cleanup (the friends-graph regression fix) applies here too.
    Refuses to delete the admin's own account via this endpoint to prevent
    accidental self-lockout — admins must use ``DELETE /api/auth/me`` for
    that, which also clears their session cookie.
    """
    user = _resolve_handle(session, handle)
    admin_email = (get_admin_email() or "").lower()
    if admin_email and user.email.lower() == admin_email:
        raise HTTPException(
            status_code=400,
            detail="Refusing to delete the admin account via this endpoint",
        )
    purge_user_account(session, user.id)
    session.commit()
    return {"status": "deleted", "user_id": str(user.id)}


# --- Calendar subscriptions (Phase B) ----------------------------------------


def _to_subscribed_user(
    session: Session,
    viewer: User,
    target: User,
    sub: CalendarSubscription,
) -> SubscribedUser:
    """Project a subscription row + target user into the wire shape.

    ``can_view_calendar`` is recomputed at read time so the UI can render a
    "this user has hidden their calendar" affordance without us having to
    eagerly delete subscriptions when a target tightens visibility.
    """
    return SubscribedUser(
        handle=target.handle or "",
        display_name=target.display_name or (target.handle or ""),
        avatar_url=target.avatar_url,
        is_verified_organizer=bool(target.is_verified_organizer),
        notify_new_events=bool(sub.notify_new_events),
        can_view_calendar=can_view(session, viewer, target, "calendar"),
        subscribed_at=sub.created_at,
    )


def _get_subscription(
    session: Session, subscriber_id: UUID, target_id: UUID
) -> Optional[CalendarSubscription]:
    return session.exec(
        select(CalendarSubscription).where(
            CalendarSubscription.subscriber_id == subscriber_id,
            CalendarSubscription.target_user_id == target_id,
        )
    ).first()


@router.post(
    "/users/{handle}/subscribe",
    response_model=SubscriptionActionResponse,
    deprecated=True,
)
@limiter.limit("60/hour")
def subscribe_to_calendar(
    request: Request,
    handle: str,
    payload: CalendarSubscriptionRequest,
    session: Session = Depends(get_session),
    viewer: User = Depends(require_user),
):
    """Subscribe the current user to ``handle``'s calendar.

    Idempotent: re-POSTing updates ``notify_new_events`` on the existing
    row. Self-subscription is rejected (you already see your own calendar
    in My Calendar).
    """
    target = _resolve_handle(session, handle)
    if target.id == viewer.id:
        raise HTTPException(
            status_code=400, detail="Cannot subscribe to your own calendar"
        )
    if not can_view(session, viewer, target, "calendar"):
        # Match the privacy chokepoint policy: hide existence rather than
        # leak a 403.
        raise HTTPException(status_code=404, detail="User not found")
    sub = _get_subscription(session, viewer.id, target.id)
    if sub is None:
        sub = CalendarSubscription(
            subscriber_id=viewer.id,
            target_user_id=target.id,
            notify_new_events=payload.notify_new_events,
        )
        session.add(sub)
    else:
        sub.notify_new_events = payload.notify_new_events
        session.add(sub)
    session.commit()
    return SubscriptionActionResponse(
        handle=target.handle or "",
        is_subscribed=True,
        notify_new_events=bool(sub.notify_new_events),
    )


@router.delete(
    "/users/{handle}/subscribe",
    response_model=SubscriptionActionResponse,
    deprecated=True,
)
@limiter.limit("60/hour")
def unsubscribe_from_calendar(
    request: Request,
    handle: str,
    session: Session = Depends(get_session),
    viewer: User = Depends(require_user),
):
    """Remove the current user's subscription to ``handle``'s calendar.

    Idempotent: returning ``is_subscribed=False`` whether or not a row
    existed. We deliberately do NOT 404 on a missing row so the UI can
    treat the button as a pure toggle without race conditions.
    """
    target = _resolve_handle(session, handle)
    sub = _get_subscription(session, viewer.id, target.id)
    if sub is not None:
        session.delete(sub)
        session.commit()
    return SubscriptionActionResponse(
        handle=target.handle or "",
        is_subscribed=False,
        notify_new_events=False,
    )


@router.get("/me/subscriptions", response_model=SubscriptionListResponse)
def list_my_subscriptions(
    request: Request,
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_session),
    viewer: User = Depends(require_user),
):
    """List the calendars the current user has subscribed to.

    Includes targets whose calendar visibility has since been tightened —
    ``can_view_calendar`` on each item tells the UI whether the feed is
    currently readable so it can offer to unsubscribe rather than silently
    failing.
    """
    base = (
        select(CalendarSubscription)
        .where(CalendarSubscription.subscriber_id == viewer.id)
        .order_by(CalendarSubscription.created_at.desc())
    )
    total = session.exec(
        select(func.count())
        .select_from(CalendarSubscription)
        .where(CalendarSubscription.subscriber_id == viewer.id)
    ).one()
    rows = session.exec(base.limit(limit).offset(offset)).all()
    items: list[SubscribedUser] = []
    for sub in rows:
        target = session.get(User, sub.target_user_id)
        if target is None or target.deleted_at is not None:
            # Stale row whose target was hard-deleted between the cascade
            # firing and this query — clean up opportunistically and skip.
            session.delete(sub)
            continue
        items.append(_to_subscribed_user(session, viewer, target, sub))
    if any(s for s in rows if session.get(User, s.target_user_id) is None):
        session.commit()
    return SubscriptionListResponse(items=items, total=total)


@router.get("/me/subscribers", response_model=SubscriberListResponse)
def list_my_subscribers(
    request: Request,
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_session),
    viewer: User = Depends(require_user),
):
    """List the users that have subscribed to *my* calendar (owner-only).

    Mirrors ``/me/subscriptions`` but in the inverse direction. Returned
    rows skip soft-deleted subscribers (their row is hard-removed
    opportunistically as well — same pattern as the subscriptions list).
    The viewer's own ``account_visibility`` setting does NOT filter the
    list: a user who subscribed while the calendar was public stays in
    the count even after the owner tightens visibility, so the owner can
    still see who is subscribed and decide what to do.
    """
    base = (
        select(CalendarSubscription)
        .where(CalendarSubscription.target_user_id == viewer.id)
        .order_by(CalendarSubscription.created_at.desc())
    )
    total = session.exec(
        select(func.count())
        .select_from(CalendarSubscription)
        .where(CalendarSubscription.target_user_id == viewer.id)
    ).one()
    rows = session.exec(base.limit(limit).offset(offset)).all()
    items: list[SubscriberUser] = []
    cleaned = False
    for sub in rows:
        subscriber = session.get(User, sub.subscriber_id)
        if subscriber is None or subscriber.deleted_at is not None:
            session.delete(sub)
            cleaned = True
            continue
        items.append(
            SubscriberUser(
                handle=subscriber.handle or "",
                display_name=subscriber.display_name
                or subscriber.email.split("@", 1)[0],
                avatar_url=subscriber.avatar_url,
                is_verified_organizer=bool(subscriber.is_verified_organizer),
                subscribed_at=sub.created_at,
            )
        )
    if cleaned:
        session.commit()
    return SubscriberListResponse(items=items, total=total)


@router.delete(
    "/me/subscribers/{handle}",
    status_code=204,
)
def remove_my_subscriber(
    request: Request,
    handle: str,
    session: Session = Depends(get_session),
    viewer: User = Depends(require_user),
):
    """Owner-side removal of a subscriber from *my* calendar.

    Lets a calendar owner kick a specific subscriber without changing
    their own visibility. Mirrors the pattern of "block" without applying
    a global block — the user can re-subscribe later (no enforcement
    layer beyond the missing row), but the owner has reset the
    relationship and any pending notification fan-out to that
    subscriber stops immediately.

    Idempotent: returns 204 whether the row existed or not.
    """
    target = session.exec(select(User).where(User.handle == handle.lower())).first()
    if target is None:
        return  # 204 — silently idempotent
    sub = session.exec(
        select(CalendarSubscription)
        .where(CalendarSubscription.subscriber_id == target.id)
        .where(CalendarSubscription.target_user_id == viewer.id)
    ).first()
    if sub is not None:
        session.delete(sub)
        session.commit()


# --- Phase C: aggregated feed of events from subscribed calendars -----------


def _actor_payload(u: User) -> NotificationActor:
    return NotificationActor(
        handle=u.handle or "",
        display_name=u.display_name or u.email.split("@", 1)[0],
        avatar_url=u.avatar_url,
        is_verified_organizer=bool(u.is_verified_organizer),
    )


@router.get("/me/subscribed-events", response_model=SubscribedEventListResponse)
def list_subscribed_events(
    request: Request,
    from_handle: Optional[str] = Query(
        default=None,
        description=(
            "Restrict the feed to a single subscribed user's activity by "
            "their handle. Must be a current subscription target."
        ),
    ),
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_session),
    viewer: User = Depends(require_user),
):
    """Aggregated MyCalendar feed of events sourced from subscriptions.

    Each item carries a ``via`` list explaining why it surfaced — one
    entry per ``(subscribed_user, kind)`` pair where kind is one of
    ``subscription_going`` (the target marked Going with a
    viewer-admitting ``share_audience``), ``subscription_saved`` (the
    target saved the event with a viewer-admitting audience), or
    ``subscription_suggested`` (the target submitted an
    EventSuggestion that was approved).

    Visibility re-check: ``can_view_event_in_calendar`` is applied per
    row so a target can revoke access by tightening account visibility
    or per-event audience without explicit unsubscribe.
    """
    # Resolve target set: all current subscriptions, optionally narrowed.
    sub_rows = session.exec(
        select(CalendarSubscription).where(
            CalendarSubscription.subscriber_id == viewer.id
        )
    ).all()
    target_ids = [s.target_user_id for s in sub_rows]
    if not target_ids:
        return SubscribedEventListResponse(
            items=[], total=0, limit=limit, offset=offset
        )

    targets: list[User] = list(
        session.exec(select(User).where(User.id.in_(target_ids))).all()
    )
    target_by_id: dict = {t.id: t for t in targets if t.deleted_at is None}

    if from_handle is not None:
        h = (from_handle or "").strip().lower()
        if not h:
            return SubscribedEventListResponse(
                items=[], total=0, limit=limit, offset=offset
            )
        scoped = [t for t in target_by_id.values() if (t.handle or "").lower() == h]
        if not scoped:
            # Not actually subscribed to this handle.
            return SubscribedEventListResponse(
                items=[], total=0, limit=limit, offset=offset
            )
        target_by_id = {t.id: t for t in scoped}

    # Re-apply account-visibility at read time.
    visible_ids = [t.id for t in target_by_id.values() if can_view(session, viewer, t)]
    if not visible_ids:
        return SubscribedEventListResponse(
            items=[], total=0, limit=limit, offset=offset
        )

    # Going attribution: visible targets' attendances whose share_audience
    # admits the viewer (public always; friends iff mutual follow).
    going_attendances = session.exec(
        select(
            UserEventAttendance.event_id,
            UserEventAttendance.user_id,
            UserEventAttendance.share_audience,
        ).where(UserEventAttendance.user_id.in_(visible_ids))
    ).all()
    going_rows: list[tuple] = []
    for ev_id, uid, audience in going_attendances:
        if not ev_id:
            continue
        owner = target_by_id.get(uid)
        if owner is None:
            continue
        if not _audience_passes(session, viewer, owner, audience or "private"):
            continue
        going_rows.append((ev_id, uid))

    # Saved attribution: visible targets' saves whose audience admits the
    # viewer. Closes the bug where saved events never surfaced in the feed.
    saved_rows_raw = session.exec(
        select(
            UserSavedEvent.event_id,
            UserSavedEvent.user_id,
            UserSavedEvent.audience,
        ).where(UserSavedEvent.user_id.in_(visible_ids))
    ).all()
    saved_rows: list[tuple] = []
    for ev_id, uid, audience in saved_rows_raw:
        if not ev_id or uid is None:
            continue
        owner = target_by_id.get(uid)
        if owner is None:
            continue
        if not _audience_passes(session, viewer, owner, audience or "private"):
            continue
        saved_rows.append((ev_id, uid))

    # Suggested attribution: approved EventSuggestion rows authored by visible targets.
    suggested_rows = session.exec(
        select(EventSuggestion.created_event_id, EventSuggestion.submitter_user_id)
        .where(EventSuggestion.submitter_user_id.in_(visible_ids))
        .where(EventSuggestion.status == "approved")
        .where(EventSuggestion.created_event_id.is_not(None))
    ).all()

    # Group attribution per event_id.
    via_map: dict[str, list[tuple]] = {}  # event_id -> list of (actor_id, kind)
    for ev_id, uid in going_rows:
        if not ev_id:
            continue
        via_map.setdefault(ev_id, []).append((uid, "subscription_going"))
    for ev_id, uid in saved_rows:
        if not ev_id:
            continue
        via_map.setdefault(ev_id, []).append((uid, "subscription_saved"))
    for ev_id, uid in suggested_rows:
        if not ev_id:
            continue
        via_map.setdefault(ev_id, []).append((uid, "subscription_suggested"))

    if not via_map:
        return SubscribedEventListResponse(
            items=[], total=0, limit=limit, offset=offset
        )

    # Hydrate cached events; only include rows whose calendar is enabled
    # (matches the public /api/events visibility contract).
    enabled_calendar_ids = {
        c.calendar_id
        for c in session.exec(
            select(CalendarSetting).where(CalendarSetting.enabled == True)  # noqa: E712
        ).all()
    }
    color_map: dict = {
        c.calendar_id: c.color for c in session.exec(select(CalendarSetting)).all()
    }
    events = list(
        session.exec(
            select(CachedEvent)
            .where(col(CachedEvent.event_id).in_(list(via_map.keys())))
            .where(CachedEvent.deleted_at.is_(None))
            .where(CachedEvent.is_hidden == False)  # noqa: E712
        ).all()
    )
    events = [e for e in events if e.calendar_id in enabled_calendar_ids]
    events.sort(key=lambda e: e.start, reverse=True)
    total = len(events)
    page = events[offset : offset + limit]

    items: list[SubscribedEventItem] = []
    for e in page:
        via_pairs = via_map.get(e.event_id, [])
        via: list[SubscribedEventVia] = []
        for actor_id, kind in via_pairs:
            actor = target_by_id.get(actor_id)
            if actor is None:
                continue
            via.append(SubscribedEventVia(actor=_actor_payload(actor), kind=kind))
        items.append(
            SubscribedEventItem(
                event_id=e.event_id,
                calendar_id=e.calendar_id,
                title=e.title,
                description=e.description,
                location=e.location,
                start=e.start,
                end=e.end,
                all_day=bool(e.all_day),
                latitude=e.latitude,
                longitude=e.longitude,
                color=color_map.get(e.calendar_id),
                via=via,
            )
        )

    return SubscribedEventListResponse(
        items=items, total=total, limit=limit, offset=offset
    )
