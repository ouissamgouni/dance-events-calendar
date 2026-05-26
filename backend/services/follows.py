from uuid import UUID

from sqlmodel import Session, select

from backend.db.models import CalendarSubscription, UserFollow


def ensure_calendar_subscription(
    session: Session,
    subscriber_id: UUID,
    target_user_id: UUID,
    *,
    notify_new_events: bool = True,
) -> tuple[CalendarSubscription, bool]:
    existing = session.exec(
        select(CalendarSubscription)
        .where(CalendarSubscription.subscriber_id == subscriber_id)
        .where(CalendarSubscription.target_user_id == target_user_id)
    ).first()
    if existing is not None:
        return existing, False
    subscription = CalendarSubscription(
        subscriber_id=subscriber_id,
        target_user_id=target_user_id,
        notify_new_events=notify_new_events,
    )
    session.add(subscription)
    return subscription, True


def ensure_approved_follow_with_subscription(
    session: Session,
    follower_id: UUID,
    followee_id: UUID,
) -> tuple[UserFollow, bool, CalendarSubscription, bool]:
    existing = session.exec(
        select(UserFollow)
        .where(UserFollow.follower_id == follower_id)
        .where(UserFollow.followee_id == followee_id)
    ).first()
    follow_created = False
    if existing is None:
        existing = UserFollow(
            follower_id=follower_id,
            followee_id=followee_id,
            status="approved",
        )
        session.add(existing)
        follow_created = True
    elif existing.status != "approved":
        existing.status = "approved"
        session.add(existing)
        follow_created = True
    subscription, subscription_created = ensure_calendar_subscription(
        session,
        follower_id,
        followee_id,
        notify_new_events=True,
    )
    return existing, follow_created, subscription, subscription_created
