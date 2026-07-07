"""Phase C notification fan-out helpers.

Triggered from write paths (attendance Going + EventSuggestion approval).
Each helper:
  1. Selects all CalendarSubscriptions where target_user_id == actor.id
     and notify_new_events == True.
  2. Re-checks ``can_view(subscriber, actor, 'calendar')`` so revoked
     access (visibility tightened post-subscribe) does not leak.
  3. Inserts one Notification per eligible subscriber. The unique
     constraint (recipient, kind, actor, event) makes re-triggers
     idempotent (e.g. flipping share_publicly off then on again).

These helpers do NOT commit; the caller owns the transaction so the
notification rows land atomically with the source-of-truth row.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from sqlmodel import Session, select

from backend.api.deps import can_view, is_mutual_follow
from backend.db.models import (
    CalendarSubscription,
    Notification,
    User,
)
from backend.services.notification_delivery import record_delivery

if TYPE_CHECKING:  # pragma: no cover
    from uuid import UUID  # noqa: F401


SUBSCRIPTION_GOING = "subscription_going"
SUBSCRIPTION_SUGGESTED = "subscription_suggested"
NEW_FOLLOWER = "new_follower"
NEW_FRIEND = "new_friend"
# Phase E (E8): pending follow request awaiting approval. The recipient
# is the *target* of the follow (the account whose visibility is
# ``friends``); the actor is the requester.
FOLLOW_REQUEST = "follow_request"
# Phase E (E8): the requester is notified when the target approves their
# pending follow-request. The recipient is the *requester* (bob); the
# actor is the approver (alice). Replaces the wrong new_follower that
# previously went to the approver instead.
FOLLOW_REQUEST_APPROVED = "follow_request_approved"


def _fan_out(
    session: Session,
    actor: User,
    event_id: str,
    kind: str,
    *,
    audience: str = "public",
) -> int:
    """Common fan-out logic; returns count of notifications inserted.

    ``audience`` gates delivery using the same 3-tier model as the rest
    of the privacy system. ``private`` short-circuits to zero. ``friends``
    only delivers to subscribers who are mutual followers of ``actor``.
    ``public`` delivers to all eligible subscribers.
    """
    if audience == "private":
        return 0
    rows = session.exec(
        select(CalendarSubscription, User)
        .join(User, User.id == CalendarSubscription.subscriber_id)
        .where(CalendarSubscription.target_user_id == actor.id)
        .where(CalendarSubscription.notify_new_events == True)  # noqa: E712
    ).all()

    # Pre-fetch existing (recipient, kind, actor, event) tuples so we can
    # skip duplicates without relying on IntegrityError handling (which is
    # awkward inside a caller-owned transaction).
    if not rows:
        return 0
    subscriber_ids = [sub.id for _s, sub in rows]
    existing = set(
        session.exec(
            select(Notification.recipient_user_id)
            .where(Notification.kind == kind)
            .where(Notification.actor_user_id == actor.id)
            .where(Notification.event_id == event_id)
            .where(Notification.recipient_user_id.in_(subscriber_ids))
        ).all()
    )

    inserted = 0
    for _sub, subscriber in rows:
        if subscriber.id in existing:
            continue
        # Re-check visibility at emit time so a target can revoke access
        # by tightening calendar visibility without unsubscribing manually.
        if not can_view(session, subscriber, actor):
            continue
        # Friends-tier RSVPs only notify mutual friends.
        if audience == "friends" and not is_mutual_follow(
            session, subscriber.id, actor.id
        ):
            continue
        notif = Notification(
            recipient_user_id=subscriber.id,
            actor_user_id=actor.id,
            kind=kind,
            event_id=event_id,
        )
        session.add(notif)
        session.flush()
        record_delivery(session, notif.id, "app")
        inserted += 1
    return inserted


def fan_out_going(
    session: Session,
    actor: User,
    event_id: str,
    *,
    audience: str = "public",
) -> int:
    """Notify subscribers that ``actor`` marked Going to ``event_id``.

    ``audience`` is the per-RSVP audience tier (``public`` | ``friends``
    | ``private``). Caller is responsible for ensuring the underlying
    ``UserEventAttendance.share_audience`` matches.
    """
    return _fan_out(session, actor, event_id, SUBSCRIPTION_GOING, audience=audience)


def fan_out_suggested(
    session: Session,
    actor: User,
    event_id: str,
) -> int:
    """Notify subscribers that ``actor``'s suggested event was approved.

    ``event_id`` is the resulting CachedEvent id (from approval), not the
    EventSuggestion uuid.
    """
    return _fan_out(session, actor, event_id, SUBSCRIPTION_SUGGESTED)


def withdraw_going(
    session: Session,
    actor: User,
    event_id: str,
) -> int:
    """Delete previously fanned-out subscription_going notifications for
    ``(actor, event_id)``.

    Called when an authenticated user transitions ``share_publicly`` from
    True to False on an existing Going row, or unsets Going entirely.
    Without this, a privacy opt-out would leave the notification visible
    in subscribers' feeds — silently leaking the (now-private) attendance.

    Returns the number of rows removed. Caller owns the transaction.
    """
    rows = session.exec(
        select(Notification)
        .where(Notification.kind == SUBSCRIPTION_GOING)
        .where(Notification.actor_user_id == actor.id)
        .where(Notification.event_id == event_id)
    ).all()
    for row in rows:
        session.delete(row)
    if rows:
        session.flush()
    return len(rows)


def _notification_exists(
    session: Session, *, recipient_id: int, actor_id: int, kind: str
) -> bool:
    """Check for an existing event-less notification row.

    Mirrors the ``uq_notif_no_event`` partial unique index
    (recipient, kind, actor) WHERE event_id IS NULL — used by
    ``new_follower`` / ``new_friend`` kinds — so callers can skip an
    INSERT that would otherwise raise IntegrityError on re-follow
    after a prior unfollow (the original notification row survives
    the unfollow).
    """
    return (
        session.exec(
            select(Notification.id)
            .where(Notification.recipient_user_id == recipient_id)
            .where(Notification.actor_user_id == actor_id)
            .where(Notification.kind == kind)
            .where(Notification.event_id.is_(None))  # type: ignore[union-attr]
            .limit(1)
        ).first()
        is not None
    )


def notify_new_follower(session: Session, followee: User, follower: User) -> None:
    """Notify ``followee`` that ``follower`` has started following them.

    Idempotent across unfollow/refollow cycles: a prior ``new_follower``
    notification row is not removed when the follow is revoked, so we
    must dedup here against the ``uq_notif_no_event`` partial index
    rather than rely on the call-site check in ``follow_user``.
    """
    if _notification_exists(
        session,
        recipient_id=followee.id,
        actor_id=follower.id,
        kind=NEW_FOLLOWER,
    ):
        return
    notif = Notification(
        recipient_user_id=followee.id,
        actor_user_id=follower.id,
        kind=NEW_FOLLOWER,
        event_id=None,
    )
    session.add(notif)
    session.flush()
    record_delivery(session, notif.id, "app")


def notify_new_friend(session: Session, user_a: User, user_b: User) -> None:
    """Notify both users that they are now mutual friends.

    Produces one ``Notification`` row per participant. Idempotent
    against the ``uq_notif_no_event`` partial index so a friendship
    that re-forms after being broken does not raise IntegrityError.
    """
    if not _notification_exists(
        session, recipient_id=user_a.id, actor_id=user_b.id, kind=NEW_FRIEND
    ):
        notif_a = Notification(
            recipient_user_id=user_a.id,
            actor_user_id=user_b.id,
            kind=NEW_FRIEND,
            event_id=None,
        )
        session.add(notif_a)
        session.flush()
        record_delivery(session, notif_a.id, "app")
    if not _notification_exists(
        session, recipient_id=user_b.id, actor_id=user_a.id, kind=NEW_FRIEND
    ):
        notif_b = Notification(
            recipient_user_id=user_b.id,
            actor_user_id=user_a.id,
            kind=NEW_FRIEND,
            event_id=None,
        )
        session.add(notif_b)
        session.flush()
        record_delivery(session, notif_b.id, "app")


def notify_follow_request(session: Session, target: User, requester: User) -> None:
    """Phase E (E8): notify ``target`` that ``requester`` wants to follow.

    Idempotent against the partial unique index on
    ``(recipient, actor, kind)`` for event-less notifications: a repeat
    request from the same user (e.g. unfollow→re-request) reuses the
    existing row.
    """
    if _notification_exists(
        session,
        recipient_id=target.id,
        actor_id=requester.id,
        kind=FOLLOW_REQUEST,
    ):
        return
    notif = Notification(
        recipient_user_id=target.id,
        actor_user_id=requester.id,
        kind=FOLLOW_REQUEST,
        event_id=None,
    )
    session.add(notif)
    session.flush()
    record_delivery(session, notif.id, "app")


def notify_follow_request_approved(
    session: Session, requester: User, approver: User
) -> None:
    """Phase E (E8): notify ``requester`` that ``approver`` has approved their
    pending follow-request.

    The recipient is the requester (bob); the actor is the approver (alice).
    Idempotent against the partial unique index.
    """
    if _notification_exists(
        session,
        recipient_id=requester.id,
        actor_id=approver.id,
        kind=FOLLOW_REQUEST_APPROVED,
    ):
        return
    notif = Notification(
        recipient_user_id=requester.id,
        actor_user_id=approver.id,
        kind=FOLLOW_REQUEST_APPROVED,
        event_id=None,
    )
    session.add(notif)
    session.flush()
    record_delivery(session, notif.id, "app")


def discard_follow_request_notification(
    session: Session, target_id, requester_id
) -> None:
    """Phase E (E8): remove the pending ``follow_request`` row, if any.

    Called when a request is approved or declined so the recipient's
    inbox stays in sync. Uses a direct ``delete()`` to avoid loading
    the row; commits are owned by the caller.
    """
    from backend.db.models import Notification as _N  # local import

    session.exec(
        _N.__table__.delete().where(
            (_N.recipient_user_id == target_id)
            & (_N.actor_user_id == requester_id)
            & (_N.kind == FOLLOW_REQUEST)
        )
    )
