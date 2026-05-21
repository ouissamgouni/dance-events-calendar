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
import os
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
    CompleteOnboardingRequest,
    CompleteOnboardingResponse,
    FoFSuggestionItem,
    FoFSuggestionsResponse,
    FollowActionResponse,
    FollowListResponse,
    FollowNotifyRequest,
    FollowRequestItem,
    FollowRequestListResponse,
    FollowUserResponse,
    FriendsLeaderboardEntry,
    FriendsLeaderboardResponse,
    InterestSummaryItem,
    InterestSummaryResponse,
    MutualSubscriberPreview,
    NotificationActor,
    OnboardingSuggestionsResponse,
    ProfileCalendarItem,
    ProfileCalendarResponse,
    ProfileEventListResponse,
    PublicProfileResponse,
    ReferralResponse,
    ShareSourceResponse,
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
    UserReferral,
    UserSavedEvent,
)
from backend.services.notifications import (
    discard_follow_request_notification,
    notify_follow_request,
    notify_follow_request_approved,
    notify_new_follower,
    notify_new_friend,
)
from backend.api.deps import get_admin_user_id, is_admin_user

router = APIRouter(prefix="/api/social", tags=["social"])
limiter = Limiter(key_func=client_ip)


# --- Helpers ----------------------------------------------------------------


def _friend_requests_enabled() -> bool:
    """Phase E (E8): is the friend-request flow active?

    Controlled by the ``FEATURE_FRIEND_REQUESTS`` env var. Defaults to
    "true" so dev/test environments exercise the flow without
    additional config; production opts in by leaving the variable
    unset-or-"true" and out by setting it to "false"/"0".
    """
    raw = os.environ.get("FEATURE_FRIEND_REQUESTS", "true").strip().lower()
    return raw in {"1", "true", "yes", "on"}


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
    # Phase E (E8): pending follow-requests don't count as followers.
    return int(
        session.exec(
            select(func.count(UserFollow.id))
            .where(UserFollow.followee_id == user_id)
            .where(UserFollow.status == "approved")
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
    # Phase E (E8): pending follow-requests don't count as following.
    return int(
        session.exec(
            select(func.count(UserFollow.id))
            .where(UserFollow.follower_id == user_id)
            .where(UserFollow.status == "approved")
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
        .where(f1.status == "approved")
        .where(f2.status == "approved")
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
        .where(fv1.status == "approved")
        .where(fv2.status == "approved")
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
        .where(fo1.status == "approved")
        .where(fo2.status == "approved")
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
        .where(fv1.status == "approved")
        .where(fv2.status == "approved")
    ).subquery()
    # Followers of organizer (approved only; pending requests don't count).
    organizer_followers = (
        select(UserFollow.follower_id)
        .where(UserFollow.followee_id == organizer_id)
        .where(UserFollow.status == "approved")
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


@router.get(
    "/users/interest-summary",
    response_model=InterestSummaryResponse,
)
@limiter.limit("60/minute")
def users_interest_summary(
    request: Request,
    handles: list[str] = Query(
        ...,
        description=(
            "Up to 50 @handles to summarise. Unknown / deleted handles "
            "silently return zeros — never 404 — to avoid leaking "
            "account existence."
        ),
    ),
    session: Session = Depends(get_session),
    viewer: User | None = Depends(get_current_user_optional),
):
    """Per-handle upcoming visible-activity counts for the picker.

    Counts only rows that ``viewer`` is allowed to see (per-row audience
    check via ``_audience_passes``; account-level ``can_view`` gates the
    owner up front). Anonymous viewers see only public-audience rows on
    public profiles. Handles past the 50-cap are silently dropped to
    keep the response bounded.

    IMPORTANT: Must be declared BEFORE ``/users/{handle}`` so FastAPI's
    route matcher does not greedily capture "interest-summary" as a
    handle path-param (which would 404 the request).
    """
    # Normalise + dedupe + cap. Empty / whitespace handles are skipped.
    seen: list[str] = []
    seen_set: set[str] = set()
    for raw in handles:
        h = (raw or "").strip().lstrip("@").lower()
        if not h or h in seen_set:
            continue
        seen_set.add(h)
        seen.append(h)
        if len(seen) >= 50:
            break
    if not seen:
        return InterestSummaryResponse(items=[])

    users = session.exec(
        select(User)
        .where(func.lower(User.handle).in_(seen))
        .where(User.deleted_at.is_(None))
    ).all()
    user_by_handle: dict[str, User] = {(u.handle or "").lower(): u for u in users}

    now = datetime.utcnow()
    items: list[InterestSummaryItem] = []
    for h in seen:
        owner = user_by_handle.get(h)
        if owner is None or not can_view(session, viewer, owner):
            items.append(InterestSummaryItem(handle=h))
            continue

        going_rows = session.exec(
            select(
                UserEventAttendance.event_id,
                UserEventAttendance.share_audience,
            )
            .join(CachedEvent, CachedEvent.event_id == UserEventAttendance.event_id)
            .where(UserEventAttendance.user_id == owner.id)
            .where(CachedEvent.start >= now)
            .where(CachedEvent.deleted_at.is_(None))
        ).all()
        saved_rows = session.exec(
            select(UserSavedEvent.event_id, UserSavedEvent.audience)
            .join(CachedEvent, CachedEvent.event_id == UserSavedEvent.event_id)
            .where(UserSavedEvent.user_id == owner.id)
            .where(CachedEvent.start >= now)
            .where(CachedEvent.deleted_at.is_(None))
        ).all()

        going_visible = sum(
            1
            for _eid, audience in going_rows
            if _audience_passes(session, viewer, owner, audience or "private")
        )
        saved_visible = sum(
            1
            for _eid, audience in saved_rows
            if _audience_passes(session, viewer, owner, audience or "private")
        )
        items.append(
            InterestSummaryItem(
                handle=h,
                upcoming_going_visible=going_visible,
                upcoming_saved_visible=saved_visible,
            )
        )
    return InterestSummaryResponse(items=items)


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
    follow_status = "approved"
    if viewer is not None and not is_self:
        # Phase E (E8): the visible "Following" state requires an
        # approved edge; a pending follow-request shows as
        # ``follow_status='pending'`` with ``is_following=False`` so the
        # UI renders the "Requested" button.
        forward = session.exec(
            select(UserFollow).where(
                (UserFollow.follower_id == viewer.id)
                & (UserFollow.followee_id == target.id)
            )
        ).first()
        if forward is not None:
            if forward.status == "approved":
                is_following = True
            else:
                follow_status = "pending"
        follows_you = (
            session.exec(
                select(UserFollow.id)
                .where(UserFollow.follower_id == target.id)
                .where(UserFollow.followee_id == viewer.id)
                .where(UserFollow.status == "approved")
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
        is_admin_managed=bool(target.is_admin_managed),
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
        follow_status=follow_status,
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

    # Phase E (E8): friend-request gate. When the target's account is
    # ``friends``-only AND the viewer is not already an approved
    # follower in the reverse direction (which would auto-approve via
    # follow-back semantics), create a *pending* edge that grants no
    # visibility until the target approves it.
    reverse_already = (
        session.exec(
            select(UserFollow.id)
            .where(UserFollow.follower_id == target.id)
            .where(UserFollow.followee_id == viewer.id)
            .where(UserFollow.status == "approved")
        ).first()
        is not None
    )
    requires_approval = (
        _friend_requests_enabled()
        and getattr(target, "account_visibility", "public") == "friends"
        and not reverse_already
    )
    if existing is not None and existing.status == "pending" and not requires_approval:
        # Visibility relaxed between request and now: auto-approve.
        existing.status = "approved"
        session.add(existing)
        is_new_follow = True  # treat as a fresh approved follow for side effects
    if is_new_follow:
        new_status = "pending" if requires_approval else "approved"
        if existing is None:
            session.add(
                UserFollow(
                    follower_id=viewer.id,
                    followee_id=target.id,
                    status=new_status,
                )
            )
        if new_status == "pending":
            notify_follow_request(session, target=target, requester=viewer)
            session.commit()
            return FollowActionResponse(
                handle=target.handle or "",
                is_following=False,
                is_friend=False,
                followers_count=_followers_count(session, target.id),
                is_subscribed=False,
                notify_new_events=False,
                follow_status="pending",
            )
        notify_new_follower(session, followee=target, follower=viewer)
    elif existing is not None and existing.status == "pending":
        # Still pending (target still friends-only, no reverse follow).
        # Idempotent re-request: just return the pending status.
        return FollowActionResponse(
            handle=target.handle or "",
            is_following=False,
            is_friend=False,
            followers_count=_followers_count(session, target.id),
            is_subscribed=False,
            notify_new_events=False,
            follow_status="pending",
        )
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
        follow_status="approved",
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
        was_pending = existing.status == "pending"
        session.delete(existing)
        if was_pending:
            # Phase E (E8): also clear the pending request notification
            # so the target's inbox doesn't keep a dangling "wants to
            # follow you" entry after the requester rescinds.
            discard_follow_request_notification(
                session, target_id=target.id, requester_id=viewer.id
            )
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
        follow_status="approved",
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
    # Phase E (E8): the implied calendar subscription only exists for
    # approved follows; pending requests cannot toggle the bell.
    if follow.status != "approved":
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


# --- Phase E (E8): Follow requests -----------------------------------------


@router.get(
    "/me/follow-requests",
    response_model=FollowRequestListResponse,
)
@limiter.limit("60/hour")
def list_follow_requests(
    request: Request,
    session: Session = Depends(get_session),
    viewer: User = Depends(require_user),
):
    """Return the viewer's inbound pending follow-requests, newest first.

    Empty list (not 404) when the feature flag is off or there are no
    pending rows — the inbox UI just hides the section.
    """
    rows = session.exec(
        select(UserFollow, User)
        .join(User, User.id == UserFollow.follower_id)
        .where(UserFollow.followee_id == viewer.id)
        .where(UserFollow.status == "pending")
        .where(User.deleted_at.is_(None))
        .order_by(UserFollow.created_at.desc())
    ).all()
    items = [
        FollowRequestItem(
            handle=u.handle or "",
            display_name=u.display_name,
            avatar_url=u.avatar_url,
            requested_at=f.created_at,
        )
        for (f, u) in rows
    ]
    return FollowRequestListResponse(items=items)


@router.post(
    "/me/follow-requests/{handle}/approve",
    response_model=FollowActionResponse,
)
@limiter.limit("60/hour")
def approve_follow_request(
    request: Request,
    handle: str,
    session: Session = Depends(get_session),
    viewer: User = Depends(require_user),
):
    """Approve a pending follow-request targeting the viewer.

    Promotes the row to ``status='approved'``, runs the full set of
    side-effects an immediate follow would have produced (implied
    calendar subscription, new_follower notification, reverse
    subscription + new_friend if the approval creates mutuality), and
    deletes the pending ``follow_request`` inbox row.
    """
    requester = _resolve_handle(session, handle)
    follow = session.exec(
        select(UserFollow)
        .where(UserFollow.follower_id == requester.id)
        .where(UserFollow.followee_id == viewer.id)
        .where(UserFollow.status == "pending")
    ).first()
    if follow is None:
        raise HTTPException(status_code=404, detail="No pending request")
    follow.status = "approved"
    session.add(follow)
    session.flush()  # make status visible to is_mutual_follow
    # Implied calendar subscription for the requester (mirrors the
    # follow_user flow which creates this on the approved path).
    sub = _get_subscription(session, requester.id, viewer.id)
    if sub is None:
        session.add(
            CalendarSubscription(
                subscriber_id=requester.id,
                target_user_id=viewer.id,
                notify_new_events=True,
            )
        )
    is_friend = is_mutual_follow(session, requester.id, viewer.id)
    if is_friend:
        reverse_sub = _get_subscription(session, viewer.id, requester.id)
        if reverse_sub is None:
            session.add(
                CalendarSubscription(
                    subscriber_id=viewer.id,
                    target_user_id=requester.id,
                    notify_new_events=True,
                )
            )
        notify_new_friend(session, user_a=viewer, user_b=requester)
    # Notify the requester that their request was approved (not the approver).
    notify_follow_request_approved(session, requester=requester, approver=viewer)
    discard_follow_request_notification(
        session, target_id=viewer.id, requester_id=requester.id
    )
    session.commit()
    return FollowActionResponse(
        handle=requester.handle or "",
        is_following=False,  # the viewer doesn't auto-follow back
        is_friend=is_friend,
        followers_count=_followers_count(session, viewer.id),
        is_subscribed=False,
        notify_new_events=False,
        follow_status="approved",
    )


@router.post(
    "/me/follow-requests/{handle}/decline",
    status_code=204,
)
@limiter.limit("60/hour")
def decline_follow_request(
    request: Request,
    handle: str,
    session: Session = Depends(get_session),
    viewer: User = Depends(require_user),
):
    """Decline a pending follow-request. Deletes the UserFollow row and
    the inbox notification. Per the product spec we do NOT tell the
    requester they were declined.
    """
    requester = _resolve_handle(session, handle)
    follow = session.exec(
        select(UserFollow)
        .where(UserFollow.follower_id == requester.id)
        .where(UserFollow.followee_id == viewer.id)
        .where(UserFollow.status == "pending")
    ).first()
    if follow is None:
        raise HTTPException(status_code=404, detail="No pending request")
    session.delete(follow)
    discard_follow_request_notification(
        session, target_id=viewer.id, requester_id=requester.id
    )
    session.commit()
    return None


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
    q: Optional[str] = Query(
        default=None,
        description=(
            "Optional case-insensitive substring filter on handle and "
            "display_name. Friends (mutual followers) are returned first; "
            "remaining matches follow in display-name order."
        ),
    ),
    session: Session = Depends(get_session),
    viewer: User = Depends(require_user),
):
    """Authenticated viewer's own following list.

    When ``q`` is supplied, results are restricted to followees whose
    handle or display_name contains the substring (case-insensitive).
    Friends (mutual followers) are sorted ahead of one-way followees
    regardless of the search filter — this powers the interest picker's
    "friends first" ordering.
    """
    sub = select(UserFollow.followee_id).where(UserFollow.follower_id == viewer.id)
    # Friend ids = followees who also follow back (approved). Used to
    # rank friends ahead of one-way follows in the picker.
    fv1 = aliased(UserFollow)
    fv2 = aliased(UserFollow)
    friend_ids_sub = (
        select(fv1.followee_id)
        .join(
            fv2,
            (fv2.follower_id == fv1.followee_id) & (fv2.followee_id == fv1.follower_id),
        )
        .where(fv1.follower_id == viewer.id)
    )
    base_query = select(User).where(User.id.in_(sub)).where(User.deleted_at.is_(None))
    if q:
        needle = f"%{q.strip().lower()}%"
        base_query = base_query.where(
            func.lower(User.handle).like(needle)
            | func.lower(User.display_name).like(needle)
        )
    total = int(
        session.exec(select(func.count()).select_from(base_query.subquery())).one()
    )
    # Sort: friends first (in_ → bool desc), then display name / handle.
    rows = session.exec(
        base_query.order_by(
            User.id.in_(friend_ids_sub).desc(),
            User.display_name.asc(),
            User.handle.asc(),
        )
        .limit(limit)
        .offset(offset)
    ).all()
    return FollowListResponse(
        items=[_to_follow_user(session, viewer.id, u) for u in rows],
        total=total,
    )


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
    page_ids = [ev.event_id for ev in page]
    curated_ids: list[str] = []
    if page_ids:
        curated_rows = session.exec(
            select(UserEventAttendance.event_id)
            .where(UserEventAttendance.user_id == target.id)
            .where(UserEventAttendance.event_id.in_(page_ids))
            .where(UserEventAttendance.created_by_admin_user_id.is_not(None))
        ).all()
        curated_ids = [eid for eid in curated_rows if eid]
    return ProfileEventListResponse(
        items=serialize_events(session, page),
        total=total,
        limit=limit,
        offset=offset,
        curated_event_ids=curated_ids,
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
    page_ids = [ev.event_id for ev in page]
    curated_ids: list[str] = []
    if page_ids:
        curated_rows = session.exec(
            select(UserSavedEvent.event_id)
            .where(UserSavedEvent.user_id == target.id)
            .where(UserSavedEvent.event_id.in_(page_ids))
            .where(UserSavedEvent.created_by_admin_user_id.is_not(None))
        ).all()
        curated_ids = [eid for eid in curated_rows if eid]
    return ProfileEventListResponse(
        items=serialize_events(session, page),
        total=total,
        limit=limit,
        offset=offset,
        curated_event_ids=curated_ids,
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
    page_ids = [ev.event_id for ev in serialized]
    curated_set: set[str] = set()
    if page_ids:
        curated_going = session.exec(
            select(UserEventAttendance.event_id)
            .where(UserEventAttendance.user_id == target.id)
            .where(UserEventAttendance.event_id.in_(page_ids))
            .where(UserEventAttendance.created_by_admin_user_id.is_not(None))
        ).all()
        curated_saved = session.exec(
            select(UserSavedEvent.event_id)
            .where(UserSavedEvent.user_id == target.id)
            .where(UserSavedEvent.event_id.in_(page_ids))
            .where(UserSavedEvent.created_by_admin_user_id.is_not(None))
        ).all()
        curated_set = {eid for eid in (*curated_going, *curated_saved) if eid}
    items = [
        ProfileCalendarItem(
            event=ev,
            intent=intent_by_event.get(ev.event_id, "saved"),
            curated=ev.event_id in curated_set,
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
    followed_ids: Optional[set[UUID]] = None,
    friend_ids: Optional[set[UUID]] = None,
    source: Optional[str] = None,
) -> UserSearchResult:
    """Project a ``User`` row into the discovery card shape.

    ``subscriber_ids``, ``followed_ids`` and ``friend_ids`` let the
    caller batch-precompute the viewer's current edges to avoid N+1.
    When not supplied we fall back to per-row queries.
    """
    is_subscribed = False
    is_followed_by_viewer = False
    is_friend = False
    if viewer is not None and viewer.id != user.id:
        if subscriber_ids is not None:
            is_subscribed = user.id in subscriber_ids
        else:
            is_subscribed = _get_subscription(session, viewer.id, user.id) is not None
        if followed_ids is not None:
            is_followed_by_viewer = user.id in followed_ids
        else:
            is_followed_by_viewer = (
                session.exec(
                    select(UserFollow.id)
                    .where(UserFollow.follower_id == viewer.id)
                    .where(UserFollow.followee_id == user.id)
                    .where(UserFollow.status == "approved")
                ).first()
                is not None
            )
        if friend_ids is not None:
            is_friend = user.id in friend_ids
        else:
            is_friend = is_mutual_follow(session, viewer.id, user.id)
    return UserSearchResult(
        handle=user.handle or "",
        display_name=user.display_name,
        avatar_url=user.avatar_url,
        is_verified_organizer=bool(user.is_verified_organizer),
        is_admin_managed=bool(user.is_admin_managed),
        subscribers_count=_subscribers_count(session, user.id),
        is_subscribed=is_subscribed,
        is_followed_by_viewer=is_followed_by_viewer,
        is_friend=is_friend,
        source=source,
    )


def _viewer_subscription_ids(session: Session, viewer: User) -> set[UUID]:
    """Cached set of target_user_id for the viewer's current subscriptions."""
    rows = session.exec(
        select(CalendarSubscription.target_user_id).where(
            CalendarSubscription.subscriber_id == viewer.id
        )
    ).all()
    return {r for r in rows}


def _viewer_followed_ids(session: Session, viewer: User) -> set[UUID]:
    rows = session.exec(
        select(UserFollow.followee_id)
        .where(UserFollow.follower_id == viewer.id)
        .where(UserFollow.status == "approved")
    ).all()
    return {UUID(str(r)) if not isinstance(r, UUID) else r for r in rows}


def _viewer_follow_edge_ids(session: Session, viewer: User) -> set[UUID]:
    rows = session.exec(
        select(UserFollow.followee_id).where(UserFollow.follower_id == viewer.id)
    ).all()
    return {UUID(str(r)) if not isinstance(r, UUID) else r for r in rows}


def _curator_users(
    session: Session,
    viewer: Optional[User],
    *,
    limit: int,
    q: Optional[str] = None,
    excluded_ids: Optional[set[UUID]] = None,
    exclude_followed: bool = False,
    exclude_subscribed: bool = False,
) -> list[User]:
    excluded: set[UUID] = set(excluded_ids or set())
    if viewer is not None:
        excluded.add(viewer.id)
        if exclude_followed:
            excluded.update(_viewer_follow_edge_ids(session, viewer))
        if exclude_subscribed:
            excluded.update(_viewer_subscription_ids(session, viewer))

    stmt = (
        select(User)
        .outerjoin(CalendarSubscription, CalendarSubscription.target_user_id == User.id)
        .where(User.is_admin_managed == True)  # noqa: E712
        .where(User.deleted_at.is_(None))
        .where(User.handle.is_not(None))
        .group_by(User.id)
    )
    needle = (q or "").strip().lower()
    if needle:
        like = f"{needle}%"
        stmt = stmt.where(
            or_(
                func.lower(User.handle).like(like),
                func.lower(User.display_name).like(like),
            )
        )
    if excluded:
        stmt = stmt.where(~col(User.id).in_(excluded))
    stmt = stmt.order_by(
        func.count(CalendarSubscription.subscriber_id).desc(),
        User.managed_label.is_not(None).desc(),
        User.handle.asc(),
    ).limit(limit)
    return list(session.exec(stmt).all())


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
    """Case-insensitive search on handle and display_name.

    Excludes soft-deleted users. Friends-only accounts remain enumerable
    (their profile body is gated separately by ``can_view``); the only
    truly hidden accounts are those soft-deleted.

    Rate-limited 30/min/IP. Returns up to ``limit`` cards (default 10,
    max 25).
    """
    needle = (q or "").strip().lower()
    if not needle:
        return UserSearchResponse(items=[])
    prefix_like = f"{needle}%"
    contains_like = f"%{needle}%"
    stmt = (
        select(User)
        .where(User.deleted_at.is_(None))
        .where(
            or_(
                func.lower(User.handle).like(prefix_like),
                func.lower(User.display_name).like(contains_like),
            )
        )
    )
    admin_id = get_admin_user_id(session)
    if admin_id is not None:
        stmt = stmt.where(User.id != admin_id)
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
    "/curators",
    response_model=UserSearchResponse,
)
@limiter.limit("30/minute")
def list_curators(
    request: Request,
    q: Optional[str] = Query(default=None, min_length=1, max_length=64),
    limit: int = Query(default=12, ge=1, le=25),
    exclude_subscribed: bool = Query(default=False),
    exclude_followed: bool = Query(default=False),
    session: Session = Depends(get_session),
    viewer: User | None = Depends(get_current_user_optional),
):
    rows = _curator_users(
        session,
        viewer,
        limit=limit,
        q=q,
        exclude_followed=exclude_followed,
        exclude_subscribed=exclude_subscribed,
    )
    sub_ids = _viewer_subscription_ids(session, viewer) if viewer else None
    followed_ids = _viewer_followed_ids(session, viewer) if viewer else None
    return UserSearchResponse(
        items=[
            _user_to_search_result(
                session,
                viewer,
                u,
                subscriber_ids=sub_ids,
                followed_ids=followed_ids,
                source="curator",
            )
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
        curators = _curator_users(
            session,
            viewer,
            limit=limit,
            exclude_followed=True,
            exclude_subscribed=True,
        )
        sub_ids = _viewer_subscription_ids(session, viewer)
        return SuggestedUsersResponse(
            items=[
                _user_to_search_result(
                    session,
                    viewer,
                    u,
                    subscriber_ids=sub_ids,
                    source="curator",
                )
                for u in curators
            ]
        )

    # People that the viewer's network is subscribed to. Exclude users
    # the viewer already follows or subscribes to, self, and the site
    # admin (hidden from public discovery).
    excluded: set[UUID] = set(network_ids)
    excluded.add(viewer.id)
    admin_id = get_admin_user_id(session)
    if admin_id is not None:
        excluded.add(admin_id)
    rows = session.exec(
        select(
            CalendarSubscription.target_user_id,
            func.count(CalendarSubscription.subscriber_id).label("intermediaries"),
        )
        .where(CalendarSubscription.subscriber_id.in_(network_ids))
        .where(~CalendarSubscription.target_user_id.in_(excluded))
        .group_by(CalendarSubscription.target_user_id)
    ).all()
    # Rank by intermediary count desc, then by absolute subscriber count
    # desc as a tiebreak. ``_subscribers_count`` is cheap (one query per
    # candidate) and the result set is bounded by ``limit`` * a small
    # multiplier.
    ranked = sorted(rows, key=lambda r: (-int(r[1]), str(r[0])))[
        : max(limit * 3, limit)
    ]
    candidate_ids = [r[0] for r in ranked]

    candidates = (
        list(
            session.exec(
                select(User)
                .where(User.id.in_(candidate_ids))
                .where(User.deleted_at.is_(None))
            ).all()
        )
        if candidate_ids
        else []
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
    items = [
        _user_to_search_result(
            session,
            viewer,
            u,
            subscriber_ids=sub_ids,
            source="network",
        )
        for u in candidates
    ]
    if len(items) < limit:
        curators = _curator_users(
            session,
            viewer,
            limit=limit - len(items),
            excluded_ids={u.id for u in candidates},
            exclude_followed=True,
            exclude_subscribed=True,
        )
        items.extend(
            _user_to_search_result(
                session,
                viewer,
                u,
                subscriber_ids=sub_ids,
                source="curator",
            )
            for u in curators
        )
    return SuggestedUsersResponse(items=items)


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


# --- Admin: admin-managed account toggle ------------------------------------


class _AdminManagedToggleRequest(BaseModel):
    is_admin_managed: bool
    # Optional internal label (max 120 chars). Empty string clears.
    managed_label: Optional[str] = None


@router.patch("/admin/users/{handle}/managed", response_model=PublicProfileResponse)
def admin_set_admin_managed(
    handle: str,
    payload: _AdminManagedToggleRequest,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """Admin-only: mark/unmark a user as an admin-managed curator account.

    Admin-managed accounts are the only legal write target for the
    bulk-curation routes (Phase 2) and pipeline rules (Phase 3). The
    optional ``managed_label`` is an internal note shown in the Admin
    Users tab to disambiguate curator personas (e.g. "Salsa Nights
    Paris"). The label is **not** exposed on the public profile.
    """
    user = _resolve_handle(session, handle)
    user.is_admin_managed = bool(payload.is_admin_managed)
    raw_label = (payload.managed_label or "").strip()
    user.managed_label = raw_label[:120] if raw_label else None
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
    managed_only: bool = Query(default=False),
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
    if managed_only:
        stmt = stmt.where(User.is_admin_managed == True)  # noqa: E712
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

    items: list[AdminUser] = []
    for u in rows:
        items.append(
            AdminUser(
                user_id=str(u.id),
                email=u.email,
                handle=u.handle,
                display_name=u.display_name,
                avatar_url=u.avatar_url,
                is_admin=is_admin_user(u),
                is_verified_organizer=bool(u.is_verified_organizer),
                is_admin_managed=bool(u.is_admin_managed),
                managed_label=u.managed_label,
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
    if is_admin_user(user):
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

    # Phase E (E8): pending-follow targets are not in CalendarSubscription, so
    # they never appear via the subscription path. Include their public-audience
    # going-events directly so the feed reflects activity from people the viewer
    # has expressed interest in following (but hasn't been approved yet).
    # Only "subscription_going" with share_audience=public is allowed — saved
    # events and suggested events require an approved relationship.
    pending_going_rows: list[tuple] = []
    if from_handle is None:
        pending_followee_rows = session.exec(
            select(UserFollow.followee_id)
            .where(UserFollow.follower_id == viewer.id)
            .where(UserFollow.status == "pending")
        ).all()
        pending_ids = [
            r
            for r in pending_followee_rows
            if r not in target_by_id  # skip if already subscribed (approved follow)
        ]
        if pending_ids:
            pending_users: list[User] = list(
                session.exec(
                    select(User).where(
                        User.id.in_(pending_ids),
                        User.deleted_at.is_(None),
                    )
                ).all()
            )
            pending_target_by_id: dict = {u.id: u for u in pending_users}
            pending_attendances = session.exec(
                select(
                    UserEventAttendance.event_id,
                    UserEventAttendance.user_id,
                    UserEventAttendance.share_audience,
                )
                .where(UserEventAttendance.user_id.in_(pending_ids))
                .where(UserEventAttendance.share_audience == "public")
            ).all()
            for ev_id, uid, audience in pending_attendances:
                if not ev_id:
                    continue
                owner = pending_target_by_id.get(uid)
                if owner is None:
                    continue
                pending_going_rows.append((ev_id, uid))
                # Merge this user into target_by_id so via_map hydration
                # can resolve their display info later.
                target_by_id.setdefault(uid, owner)

    if not visible_ids and not pending_going_rows:
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
    # Phase E (E8): pending-follow targets' public-going events.
    for ev_id, uid in pending_going_rows:
        if not ev_id:
            continue
        existing_uids = {actor_id for actor_id, _ in via_map.get(ev_id, [])}
        if uid not in existing_uids:
            via_map.setdefault(ev_id, []).append((uid, "subscription_going"))

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


# ---------------------------------------------------------------------------
# Phase E (E3) — onboarding "find your crew" step
# ---------------------------------------------------------------------------


def _friend_ids(session: Session, user_id: UUID) -> set[UUID]:
    """Return the set of viewer's friends (mutual follows).

    Phase E (E8): only ``status='approved'`` edges count.
    """
    f1 = aliased(UserFollow)
    f2 = aliased(UserFollow)
    rows = session.exec(
        select(f1.followee_id)
        .join(
            f2,
            (f2.follower_id == f1.followee_id) & (f2.followee_id == f1.follower_id),
        )
        .where(f1.follower_id == user_id)
        .where(f1.status == "approved")
        .where(f2.status == "approved")
    ).all()
    return {UUID(str(r)) if not isinstance(r, UUID) else r for r in rows}


def _already_followed_ids(session: Session, viewer_id: UUID) -> set[UUID]:
    # Phase E (E8): include pending requests so we don't suggest a target
    # the viewer has already asked to follow.
    rows = session.exec(
        select(UserFollow.followee_id).where(UserFollow.follower_id == viewer_id)
    ).all()
    return {UUID(str(r)) if not isinstance(r, UUID) else r for r in rows}


@router.get(
    "/onboarding/suggestions",
    response_model=OnboardingSuggestionsResponse,
)
@limiter.limit("30/hour")
def onboarding_suggestions(
    request: Request,
    limit: int = Query(default=10, ge=1, le=25),
    session: Session = Depends(get_session),
    viewer: User = Depends(require_user),
):
    """Phase E (E3): initial follow candidates for the post-signup screen.

    Ranking (in order, dedup by user id, never include self / already-
    followed / soft-deleted):

    1. Verified organizers — high-trust seed signal.
    2. Admin-managed curator accounts — editorial seed signal.
    3. Most-followed accounts overall — fills remaining slots.

    Future iterations can layer area-locality once we add a geo column
    to ``users``; today the user model has no city, so we keep the
    ranking simple and explicit (see PHASE_E_FRIENDSHIP_ADOPTION.md).
    """
    excluded: set[UUID] = _already_followed_ids(session, viewer.id)
    excluded.add(viewer.id)

    picked: list[User] = []
    seen: set[UUID] = set()

    # 1. Verified organizers.
    organizers = list(
        session.exec(
            select(User)
            .where(User.is_verified_organizer == True)  # noqa: E712
            .where(User.deleted_at.is_(None))
            .where(User.handle.is_not(None))
            .where(~col(User.id).in_(excluded))
            .limit(limit)
        ).all()
    )
    for u in organizers:
        if u.id in seen:
            continue
        picked.append(u)
        seen.add(u.id)
        if len(picked) >= limit:
            break

    # 2. Admin-managed curator accounts.
    if len(picked) < limit:
        remaining = limit - len(picked)
        skip_ids = excluded | seen
        curators = list(
            session.exec(
                select(User)
                .where(User.is_admin_managed == True)  # noqa: E712
                .where(User.deleted_at.is_(None))
                .where(User.handle.is_not(None))
                .where(~col(User.id).in_(skip_ids))
                .order_by(User.handle.asc())
                .limit(remaining)
            ).all()
        )
        for u in curators:
            if u.id in seen:
                continue
            picked.append(u)
            seen.add(u.id)
            if len(picked) >= limit:
                break

    # 3. Most-followed accounts (by absolute followers count).
    if len(picked) < limit:
        remaining = limit - len(picked)
        skip_ids = excluded | seen
        rows = session.exec(
            select(
                UserFollow.followee_id,
                func.count(UserFollow.id).label("followers"),
            )
            .where(~col(UserFollow.followee_id).in_(skip_ids))
            .group_by(UserFollow.followee_id)
            .order_by(func.count(UserFollow.id).desc())
            .limit(remaining * 3)
        ).all()
        candidate_ids = [r[0] for r in rows]
        if candidate_ids:
            extra = list(
                session.exec(
                    select(User)
                    .where(col(User.id).in_(candidate_ids))
                    .where(User.deleted_at.is_(None))
                    .where(User.handle.is_not(None))
                ).all()
            )
            rank = {r[0]: int(r[1]) for r in rows}
            extra.sort(key=lambda u: (-rank.get(u.id, 0), u.handle or ""))
            for u in extra:
                if u.id in seen or len(picked) >= limit:
                    continue
                picked.append(u)
                seen.add(u.id)

    sub_ids = _viewer_subscription_ids(session, viewer)
    return OnboardingSuggestionsResponse(
        items=[
            _user_to_search_result(session, viewer, u, subscriber_ids=sub_ids)
            for u in picked
        ]
    )


@router.post(
    "/onboarding/complete",
    response_model=CompleteOnboardingResponse,
)
@limiter.limit("10/hour")
def onboarding_complete(
    request: Request,
    payload: CompleteOnboardingRequest,
    session: Session = Depends(get_session),
    viewer: User = Depends(require_user),
):
    """Phase E (E3): batch-follow + stamp ``onboarded_at``.

    Idempotent in two senses:
      - Calling with the same handles twice does NOT create duplicate
        ``UserFollow`` rows (the unique constraint on
        ``(follower_id, followee_id)`` no-ops the second insert).
      - Calling after ``onboarded_at`` is already set silently re-stamps
        it but doesn't error — the frontend route guard already redirects
        away, so this only matters for replay safety.

    Unknown handles, self-follows, and soft-deleted targets are dropped
    silently to avoid leaking existence and to keep the UX forgiving.
    """
    handles = [h.strip().lower() for h in (payload.handles or []) if h and h.strip()]
    handles = list(dict.fromkeys(handles))  # de-dup, preserve order

    followed: list[str] = []
    if handles:
        already = _already_followed_ids(session, viewer.id)
        # Resolve all in one query.
        targets = list(
            session.exec(
                select(User)
                .where(func.lower(User.handle).in_(handles))
                .where(User.deleted_at.is_(None))
            ).all()
        )
        for target in targets:
            if target.id == viewer.id or target.id in already:
                continue
            session.add(UserFollow(follower_id=viewer.id, followee_id=target.id))
            try:
                notify_new_follower(session, followee=target, follower=viewer)
            except Exception:
                # Best-effort — never block onboarding on notification
                # delivery (e.g. transient email/queue errors).
                pass
            # Detect mutual completion (the inviter may already follow
            # the new user back via an earlier referral redemption).
            if is_mutual_follow(session, viewer.id, target.id):
                try:
                    notify_new_friend(session, viewer, target)
                except Exception:
                    pass
            followed.append(target.handle or "")

    viewer.onboarded_at = datetime.utcnow()
    session.add(viewer)
    session.commit()
    session.refresh(viewer)

    return CompleteOnboardingResponse(
        onboarded_at=viewer.onboarded_at.isoformat(),
        followed=[h for h in followed if h],
    )


# ---------------------------------------------------------------------------
# Phase E (E4) — friend-of-friend suggestions
# ---------------------------------------------------------------------------


@router.get(
    "/me/suggestions",
    response_model=FoFSuggestionsResponse,
)
@limiter.limit("60/hour")
def friend_of_friend_suggestions(
    request: Request,
    limit: int = Query(default=12, ge=1, le=50),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_session),
    viewer: User = Depends(require_user),
):
    """Phase E (E4): "People you may know" — ranked by mutual friends.

    For each candidate ``c`` we compute ``mutual_friend_count`` =
    number of viewer-friends who also follow ``c``. Tiebreakers (in
    order): verified-organizer flag desc, then handle asc.

    Excludes: self, viewer's existing follows, soft-deleted accounts,
    and accounts with no public handle. Anonymous viewers never hit
    this route (``require_user``).
    """
    excluded: set[UUID] = _already_followed_ids(session, viewer.id)
    excluded.add(viewer.id)
    admin_id = get_admin_user_id(session)
    if admin_id is not None:
        excluded.add(admin_id)

    candidate_scores: dict[UUID, int] = {}
    viewer_friends = _friend_ids(session, viewer.id)
    if viewer_friends:
        rows = session.exec(
            select(
                UserFollow.followee_id,
                func.count(UserFollow.follower_id).label("mutuals"),
            )
            .where(col(UserFollow.follower_id).in_(viewer_friends))
            .where(~col(UserFollow.followee_id).in_(excluded))
            .group_by(UserFollow.followee_id)
            .order_by(func.count(UserFollow.follower_id).desc())
        ).all()
        candidate_scores.update({r[0]: int(r[1]) for r in rows})

    curator_ids = session.exec(
        select(User.id)
        .where(User.is_admin_managed == True)  # noqa: E712
        .where(User.deleted_at.is_(None))
        .where(User.handle.is_not(None))
        .where(~col(User.id).in_(excluded))
    ).all()
    for curator_id in curator_ids:
        candidate_scores.setdefault(curator_id, 0)

    if not candidate_scores:
        return FoFSuggestionsResponse(items=[], total=0)

    total = len(candidate_scores)
    candidate_ids = list(candidate_scores.keys())

    candidates = list(
        session.exec(
            select(User)
            .where(col(User.id).in_(candidate_ids))
            .where(User.deleted_at.is_(None))
            .where(User.handle.is_not(None))
        ).all()
    )
    candidates.sort(
        key=lambda u: (
            -candidate_scores.get(u.id, 0),
            0 if u.is_verified_organizer else 1,
            0 if u.is_admin_managed else 1,
            (u.handle or "").lower(),
        )
    )
    candidates = candidates[offset : offset + limit]

    # Preview: up to 3 viewer-friends who follow each candidate.
    items: list[FoFSuggestionItem] = []
    for u in candidates:
        preview_rows = session.exec(
            select(User.handle)
            .join(UserFollow, UserFollow.follower_id == User.id)
            .where(UserFollow.followee_id == u.id)
            .where(col(UserFollow.follower_id).in_(viewer_friends))
            .where(User.handle.is_not(None))
            .order_by(User.handle.asc())
            .limit(3)
        ).all()
        items.append(
            FoFSuggestionItem(
                handle=u.handle or "",
                display_name=u.display_name,
                avatar_url=u.avatar_url,
                is_verified_organizer=bool(u.is_verified_organizer),
                is_admin_managed=bool(u.is_admin_managed),
                mutual_friend_count=candidate_scores.get(u.id, 0),
                mutual_friends_preview=[h for h in preview_rows if h],
            )
        )

    return FoFSuggestionsResponse(items=items, total=total)


# ---------------------------------------------------------------------------
# Phase E (E7) — referrals
# ---------------------------------------------------------------------------


def _generate_referral_code() -> str:
    """Generate a short opaque case-insensitive referral code.

    Base32-without-padding over 6 random bytes → 10 chars (e.g.
    ``A7K2QZNM3X``). ~3e14 codespace; collisions are vanishingly rare
    and re-tried by the caller if they ever happen.
    """
    import base64
    import secrets

    return base64.b32encode(secrets.token_bytes(6)).decode("ascii").rstrip("=")


def _public_app_url() -> str:
    """Return the public app base URL for referral links.

    Reads ``PUBLIC_APP_URL`` env var (set in fly.toml / .env). Falls
    back to ``http://localhost:5173`` for local dev so the link is
    still copy-pasteable.
    """
    import os

    return (os.getenv("PUBLIC_APP_URL") or "http://localhost:5173").rstrip("/")


def _referral_url(code: str) -> str:
    return f"{_public_app_url()}/r/{code}"


@router.get(
    "/me/referral",
    response_model=ReferralResponse,
)
def get_or_create_my_referral(
    session: Session = Depends(get_session),
    viewer: User = Depends(require_user),
):
    """Phase E (E7): return the viewer's referral code, creating one lazily.

    Idempotent — repeated calls return the same code. Enforced at the
    DB level by ``uq_user_referrals_inviter``.
    """
    row = session.exec(
        select(UserReferral).where(UserReferral.inviter_user_id == viewer.id)
    ).first()
    if row is None:
        # Retry on the (extremely unlikely) code collision.
        for _ in range(5):
            code = _generate_referral_code()
            exists = session.exec(
                select(UserReferral).where(UserReferral.code == code)
            ).first()
            if exists is None:
                row = UserReferral(inviter_user_id=viewer.id, code=code)
                session.add(row)
                session.commit()
                session.refresh(row)
                break
        if row is None:
            raise HTTPException(
                status_code=500, detail="Could not allocate referral code"
            )
    return ReferralResponse(
        code=row.code,
        url=_referral_url(row.code),
        used_count=int(row.used_count or 0),
    )


@router.post(
    "/me/referral",
    response_model=ReferralResponse,
)
def create_my_referral(
    session: Session = Depends(get_session),
    viewer: User = Depends(require_user),
):
    """Alias for ``GET /me/referral`` — kept POST-shaped for clients
    that prefer side-effecting verbs for the lazy-create case."""
    return get_or_create_my_referral(session=session, viewer=viewer)


# ---------------------------------------------------------------------------
# Phase E (D2) — share-source lookup for the share-referral banner
# ---------------------------------------------------------------------------


@router.get("/share-source/{share_code}", response_model=ShareSourceResponse)
def get_share_source(
    share_code: str,
    session: Session = Depends(get_session),
):
    """Resolve a ``?ref=share&src=`` token to the originating user.

    Public on purpose — the ``share_code`` is already present in the
    URL the caller arrived from, so revealing the matching handle +
    avatar does not leak new information. Returns the minimal preview
    the share-referral banner needs ("You arrived via @alpha — follow
    them?"). 404 when the code is unknown or the owner is
    soft-deleted (matches the silent-redemption contract — we don't
    leak existence of expired or anonymized accounts).
    """
    code = (share_code or "").strip().lower()
    if not code:
        raise HTTPException(status_code=404, detail="Unknown share source")
    sharer = session.exec(
        select(User).where(User.share_code == code).where(User.deleted_at.is_(None))
    ).first()
    if sharer is None:
        raise HTTPException(status_code=404, detail="Unknown share source")
    return ShareSourceResponse(
        handle=sharer.handle,
        display_name=sharer.display_name,
        avatar_url=sharer.avatar_url,
    )
