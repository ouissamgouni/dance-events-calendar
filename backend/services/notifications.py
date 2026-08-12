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

from datetime import datetime
from typing import TYPE_CHECKING

from sqlmodel import Session, col, func, or_, select

from backend.api.deps import can_view, is_mutual_follow
from backend.db.models import (
    CachedEvent,
    CalendarSubscription,
    EventMessage,
    Notification,
    User,
    UserEventAttendance,
    UserEventMute,
    UserSavedEvent,
)
from backend.services.notification_delivery import record_delivery

if TYPE_CHECKING:  # pragma: no cover
    from uuid import UUID  # noqa: F401


SUBSCRIPTION_GOING = "subscription_going"
SUBSCRIPTION_SUGGESTED = "subscription_suggested"
# A followee dropped a review; fanned out to their subscribers. Reviews
# only exist on past events, so this bypasses the past-event fan-out guard.
SUBSCRIPTION_REVIEW = "subscription_review"
# A followee unlocked a Dance Passport milestone; fanned out to their
# subscribers. Event-less (keyed by ``subject_key`` = milestone key).
SUBSCRIPTION_MILESTONE = "subscription_milestone"
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
# Someone posted a top-level message/question on an event; fanned out to
# everyone engaged with the event (Going ∪ Saved) plus the site admin.
EVENT_MESSAGE = "event_message"
# Someone replied to a message; fanned out to that thread's participants.
EVENT_MESSAGE_REPLY = "event_message_reply"
# A user reported a message; delivered to the site admin only (in-app).
EVENT_MESSAGE_REPORTED = "event_message_reported"


def _event_is_past(session: Session, event_id: str) -> bool:
    """True when the event has already ended (end < now, naive UTC).

    Unknown events (no CachedEvent row) are treated as not-past so we
    preserve the existing fan-out behaviour.
    """
    end = session.exec(
        select(CachedEvent.end).where(CachedEvent.event_id == event_id)
    ).first()
    return end is not None and end < datetime.utcnow()


def _fan_out(
    session: Session,
    actor: User,
    event_id: str | None,
    kind: str,
    *,
    audience: str = "public",
    subject_key: str | None = None,
    context: str | None = None,
    description: str | None = None,
    skip_past_guard: bool = False,
) -> int:
    """Common fan-out logic; returns count of notifications inserted.

    ``audience`` gates delivery using the same 3-tier model as the rest
    of the privacy system. ``private`` short-circuits to zero. ``friends``
    only delivers to subscribers who are mutual followers of ``actor``.
    ``public`` delivers to all eligible subscribers.

    ``subject_key`` disambiguates event-less kinds (e.g. milestones) in the
    dedupe. ``skip_past_guard`` opts out of the past-event guard for kinds
    that are inherently about past events (reviews) or carry no event.
    """
    if audience == "private":
        return 0
    # Marking a past event (already ended) as attended must not notify
    # followers — it isn't live activity worth surfacing.
    if (
        not skip_past_guard
        and event_id is not None
        and _event_is_past(session, event_id)
    ):
        return 0
    rows = session.exec(
        select(CalendarSubscription, User)
        .join(User, User.id == CalendarSubscription.subscriber_id)
        .where(CalendarSubscription.target_user_id == actor.id)
        .where(CalendarSubscription.notify_new_events == True)  # noqa: E712
    ).all()

    # Pre-fetch existing (recipient, kind, actor, event, subject_key) tuples
    # so we can skip duplicates without relying on IntegrityError handling
    # (which is awkward inside a caller-owned transaction).
    if not rows:
        return 0
    subscriber_ids = [sub.id for _s, sub in rows]
    existing_q = (
        select(Notification.recipient_user_id)
        .where(Notification.kind == kind)
        .where(Notification.actor_user_id == actor.id)
        .where(Notification.recipient_user_id.in_(subscriber_ids))
    )
    existing_q = (
        existing_q.where(Notification.event_id == event_id)
        if event_id is not None
        else existing_q.where(Notification.event_id.is_(None))  # type: ignore[union-attr]
    )
    existing_q = (
        existing_q.where(Notification.subject_key == subject_key)
        if subject_key is not None
        else existing_q.where(Notification.subject_key.is_(None))  # type: ignore[union-attr]
    )
    existing = set(session.exec(existing_q).all())

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
            subject_key=subject_key,
            context=context,
            description=description,
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


def fan_out_review(
    session: Session,
    actor: User,
    event_id: str,
    *,
    anonymous: bool = False,
) -> int:
    """Notify subscribers that ``actor`` reviewed ``event_id``.

    Reviews only exist on past events, so the past-event guard is skipped.
    Anonymous reviews still fan out but tag ``context='anon'`` so renderers
    mask the reviewer's identity.
    """
    return _fan_out(
        session,
        actor,
        event_id,
        SUBSCRIPTION_REVIEW,
        context="anon" if anonymous else None,
        skip_past_guard=True,
    )


def fan_out_milestone(
    session: Session,
    actor: User,
    subject_key: str,
    *,
    audience: str = "public",
    context: str | None = None,
    description: str | None = None,
) -> int:
    """Notify subscribers that ``actor`` unlocked milestone ``subject_key``.

    Event-less; deduped on ``subject_key``. ``audience`` should be derived
    from the actor's ``passport_visibility`` so private passports don't leak.
    """
    return _fan_out(
        session,
        actor,
        None,
        SUBSCRIPTION_MILESTONE,
        audience=audience,
        subject_key=subject_key,
        context=context,
        description=description,
        skip_past_guard=True,
    )


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

    Dedups against the ``uq_notif_no_event`` partial index so a caller
    that already knows a row exists for this (recipient, actor) pair
    doesn't have to special-case the INSERT. ``unfollow_user`` calls
    ``discard_new_follower_notification`` when the edge is torn down, so
    a later re-follow finds no stale row here and notifies again — see
    that function's docstring for the history of this bug.
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

    Produces one ``Notification`` row per participant. Dedups against
    the ``uq_notif_no_event`` partial index so a friendship that
    re-forms after being broken does not raise IntegrityError.
    ``unfollow_user`` calls ``discard_new_friend_notifications`` when the
    mutual follow breaks, so a later re-friending notifies again instead
    of silently no-oping against a stale row (see that function's
    docstring).
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


def discard_new_follower_notification(
    session: Session, *, followee_id, follower_id
) -> None:
    """Remove a stale ``new_follower`` row when the follow edge is torn down.

    BUG (found in staging, July 2026): ``notify_new_follower``'s dedup
    check only asks "has this (recipient, actor) pair ever produced a
    ``new_follower`` row", with no time bound. ``unfollow_user`` never
    deleted that row, so once a follow had ever been notified, unfollowing
    and following again would hit the dedup guard and silently produce no
    new notification — forever, for that pair. Called from
    ``unfollow_user`` for the reverse case (target as recipient, viewer as
    actor) so a subsequent re-follow's dedup check finds nothing and
    notifies again. Uses a direct ``delete()``; caller owns the commit.
    """
    from backend.db.models import Notification as _N  # local import

    session.exec(
        _N.__table__.delete().where(
            (_N.recipient_user_id == followee_id)
            & (_N.actor_user_id == follower_id)
            & (_N.kind == NEW_FOLLOWER)
            & (_N.event_id.is_(None))
        )
    )


def discard_new_friend_notifications(session: Session, user_a_id, user_b_id) -> None:
    """Remove both directions' stale ``new_friend`` rows when a mutual
    follow breaks (either side unfollows the other).

    Same bug class as ``discard_new_follower_notification`` above:
    without this, re-forming a friendship after either side unfollows
    never renotifies either participant. Uses a direct ``delete()``;
    caller owns the commit.
    """
    from backend.db.models import Notification as _N  # local import

    session.exec(
        _N.__table__.delete()
        .where(
            or_(
                (_N.recipient_user_id == user_a_id) & (_N.actor_user_id == user_b_id),
                (_N.recipient_user_id == user_b_id) & (_N.actor_user_id == user_a_id),
            )
        )
        .where(_N.kind == NEW_FRIEND)
        .where(_N.event_id.is_(None))
    )


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


def _admin_user_ids(session: Session) -> list:
    """Return the User ids matching the configured admin email (0 or 1 row)."""
    from backend.config.loader import get_admin_email

    email = get_admin_email()
    if not email:
        return []
    return list(
        session.exec(
            select(User.id).where(func.lower(User.email) == email.lower())
        ).all()
    )


def _engaged_user_ids(session: Session, event_id: str, *, exclude) -> set:
    """User ids engaged with ``event_id`` — currently Going or has Saved it.

    Anonymous device-only rows (user_id IS NULL) are ignored: message
    notifications require a signed-in recipient. ``exclude`` (the author)
    is removed from the set.
    """
    going = session.exec(
        select(UserEventAttendance.user_id)
        .where(UserEventAttendance.event_id == event_id)
        .where(col(UserEventAttendance.user_id).is_not(None))
    ).all()
    saved = session.exec(
        select(UserSavedEvent.user_id)
        .where(UserSavedEvent.event_id == event_id)
        .where(col(UserSavedEvent.user_id).is_not(None))
    ).all()
    ids = set(going) | set(saved)
    ids.discard(exclude)
    ids.discard(None)
    return ids


def _muted_user_ids(session: Session, event_id: str) -> set:
    """User ids who muted event-message notifications for ``event_id``."""
    return set(
        session.exec(
            select(UserEventMute.user_id).where(UserEventMute.event_id == event_id)
        ).all()
    )


def _insert_message_notification(
    session: Session,
    *,
    recipient_id,
    actor_id,
    kind: str,
    event_id: str,
    subject_key: str,
    context: str | None,
    description: str | None,
) -> Notification:
    notif = Notification(
        recipient_user_id=recipient_id,
        actor_user_id=actor_id,
        kind=kind,
        event_id=event_id,
        subject_key=subject_key,
        context=context,
        description=description,
    )
    session.add(notif)
    session.flush()
    record_delivery(session, notif.id, "app")
    return notif


def fan_out_event_message(
    session: Session,
    author: User,
    event_id: str,
    message_id,
    *,
    category: str | None = None,
    snippet: str | None = None,
) -> list[Notification]:
    """Notify engaged users that ``author`` posted a message on ``event_id``.

    Recipients = (Going ∪ Saved) signed-in users plus the site admin, minus
    the author. ``category`` and ``snippet`` are stored on the notification
    (context/description) so renderers can show "asked about a roommate: …"
    without a second lookup. ``message_id`` is the dedupe/deep-link key
    (``subject_key``). Returns the created notifications so callers can
    dispatch instant email/push. Caller owns the transaction.
    """
    recipients = _engaged_user_ids(session, event_id, exclude=author.id)
    recipients |= {aid for aid in _admin_user_ids(session) if aid != author.id}
    recipients -= _muted_user_ids(session, event_id)
    created: list[Notification] = []
    for rid in recipients:
        created.append(
            _insert_message_notification(
                session,
                recipient_id=rid,
                actor_id=author.id,
                kind=EVENT_MESSAGE,
                event_id=event_id,
                subject_key=str(message_id),
                context=category,
                description=snippet,
            )
        )
    return created


def notify_thread_reply(
    session: Session,
    author: User,
    event_id: str,
    root_message_id,
    reply_message_id,
    *,
    category: str | None = None,
    snippet: str | None = None,
) -> list[Notification]:
    """Notify a thread's participants that ``author`` replied.

    Participants = the top-level post's author + everyone who posted anywhere
    in the thread (any depth), minus the current replier. Deep-links to the
    reply via ``subject_key`` = ``reply_message_id``. Returns the created
    notifications so callers can dispatch instant email/push. Caller owns the
    transaction.
    """
    root_author = session.exec(
        select(EventMessage.author_user_id).where(EventMessage.id == root_message_id)
    ).first()
    # Flattened threads allow reply-to-reply, so gather every author in the
    # subtree rooted at the top-level post, not just direct replies.
    reply_rows = session.exec(
        select(EventMessage.id, EventMessage.parent_id, EventMessage.author_user_id)
        .where(EventMessage.event_id == event_id)
        .where(col(EventMessage.parent_id).is_not(None))
    ).all()
    children_by_parent: dict = {}
    author_by_id: dict = {}
    for mid, pid, aid in reply_rows:
        children_by_parent.setdefault(pid, []).append(mid)
        author_by_id[mid] = aid
    recipients: set = set()
    queue = [root_message_id]
    seen: set = set()
    while queue:
        pid = queue.pop(0)
        for child_id in children_by_parent.get(pid, []):
            if child_id in seen:
                continue
            seen.add(child_id)
            recipients.add(author_by_id.get(child_id))
            queue.append(child_id)
    if root_author is not None:
        recipients.add(root_author)
    recipients.discard(author.id)
    recipients.discard(None)
    recipients -= _muted_user_ids(session, event_id)
    created: list[Notification] = []
    for rid in recipients:
        created.append(
            _insert_message_notification(
                session,
                recipient_id=rid,
                actor_id=author.id,
                kind=EVENT_MESSAGE_REPLY,
                event_id=event_id,
                subject_key=str(reply_message_id),
                # "root" signals the copy "replied to your message" for the
                # original poster; category is unused in reply rendering.
                context=("root" if rid == root_author else category),
                description=snippet,
            )
        )
    return created


def notify_message_reported(
    session: Session,
    reporter: User,
    event_id: str,
    message_id,
    *,
    reason: str | None = None,
) -> int:
    """Notify the site admin that ``reporter`` flagged a message (in-app only).

    Not wired into the email/push feature buckets, so it stays an in-app
    moderation signal. Caller owns the transaction.
    """
    recipients = [aid for aid in _admin_user_ids(session) if aid != reporter.id]
    for rid in recipients:
        _insert_message_notification(
            session,
            recipient_id=rid,
            actor_id=reporter.id,
            kind=EVENT_MESSAGE_REPORTED,
            event_id=event_id,
            subject_key=str(message_id),
            context=(reason[:200] if reason else None),
            description=None,
        )
    return len(recipients)
