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

from datetime import datetime, timezone
from typing import TYPE_CHECKING
from uuid import UUID

from sqlmodel import Session, col, func, or_, select

from backend.api.deps import can_view, is_mutual_follow
from backend.db.models import (
    CachedEvent,
    CalendarSubscription,
    EventMessage,
    EventRating,
    Notification,
    User,
    UserEventAttendance,
    UserEventMute,
    UserSavedEvent,
    UserPlanSession,
)
from backend.services.notification_delivery import record_delivery
from backend.services.event_visibility import eligible_event_ids

SUBSCRIPTION_GOING = "subscription_going"
# A followee saved (marked interested in) an event; fanned out to their
# subscribers. Same 3-tier audience gating as ``subscription_going``.
SUBSCRIPTION_SAVED = "subscription_saved"
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
PLANNED_SESSION_CHANGED = "planned_session_changed"


def withdraw_review_notifications(
    session: Session, actor_user_id: UUID, event_id: str
) -> int:
    rows = session.exec(
        select(Notification)
        .where(Notification.kind == SUBSCRIPTION_REVIEW)
        .where(Notification.actor_user_id == actor_user_id)
        .where(Notification.event_id == event_id)
    ).all()
    for row in rows:
        row.context = "anon"
        session.add(row)
    return len(rows)


def filter_privacy_safe_notifications(
    session: Session, rows: list[Notification]
) -> list[Notification]:
    """Remove actor-linked activity that could identify an anonymous reviewer."""
    if not rows:
        return []

    sensitive_rows = [
        row for row in rows if row.kind in {SUBSCRIPTION_REVIEW, SUBSCRIPTION_MILESTONE}
    ]
    if not sensitive_rows:
        return rows

    actor_ids = {row.actor_user_id for row in sensitive_rows}
    deleted_actor_ids = set(
        session.exec(
            select(User.id)
            .where(col(User.id).in_(actor_ids))
            .where(User.deleted_at.is_not(None))  # type: ignore[union-attr]
        ).all()
    )

    review_rows = [
        row
        for row in sensitive_rows
        if row.kind == SUBSCRIPTION_REVIEW and row.event_id is not None
    ]
    anonymous_review_pairs: set[tuple[UUID, str]] = set()
    if review_rows:
        review_actor_ids = {row.actor_user_id for row in review_rows}
        review_event_ids = {row.event_id for row in review_rows if row.event_id}
        anonymous_review_pairs = set(
            session.exec(
                select(EventRating.user_id, EventRating.event_id)
                .where(col(EventRating.user_id).in_(review_actor_ids))
                .where(col(EventRating.event_id).in_(review_event_ids))
                .where(col(EventRating.is_anonymous).is_(True))
            ).all()
        )

    from backend.services import passport

    review_milestones = {
        key: milestone
        for key, milestone in passport.MILESTONES_BY_KEY.items()
        if milestone.category == "reviews"
    }
    milestone_actor_ids = {
        row.actor_user_id
        for row in sensitive_rows
        if row.kind == SUBSCRIPTION_MILESTONE and row.subject_key in review_milestones
    }
    public_review_counts = passport.public_review_counts(session, milestone_actor_ids)

    safe: list[Notification] = []
    for row in rows:
        if row.kind == SUBSCRIPTION_REVIEW:
            if row.context == "anon" or row.actor_user_id in deleted_actor_ids:
                continue
            if (row.actor_user_id, row.event_id) in anonymous_review_pairs:
                continue
        elif row.kind == SUBSCRIPTION_MILESTONE:
            milestone = review_milestones.get(row.subject_key)
            if milestone is not None and (
                row.actor_user_id in deleted_actor_ids
                or public_review_counts.get(row.actor_user_id, 0) < milestone.threshold
            ):
                continue
        safe.append(row)
    return safe


def notification_is_privacy_safe(session: Session, notification: Notification) -> bool:
    return bool(filter_privacy_safe_notifications(session, [notification]))


def notify_planned_session_changes(
    session: Session,
    actor: User,
    event_id: str,
    version: int,
    previous: dict,
    current: dict,
) -> list[Notification]:
    previous_sessions = {row["id"]: row for row in previous.get("sessions", [])}
    current_sessions = {row["id"]: row for row in current.get("sessions", [])}
    relevant_fields = {
        "title",
        "instructors",
        "start",
        "end",
        "room_id",
        "venue_id",
        "level_id",
        "activity_type_id",
        "attendee_note",
        "allow_plan",
        "is_cancelled",
    }
    changed_ids = set(previous_sessions) - set(current_sessions)
    changed_ids.update(
        session_id
        for session_id in previous_sessions.keys() & current_sessions.keys()
        if any(
            previous_sessions[session_id].get(field)
            != current_sessions[session_id].get(field)
            for field in relevant_fields
        )
    )
    if not changed_ids:
        return []
    changed_session_ids = [UUID(session_id) for session_id in changed_ids]
    plan_rows = session.exec(
        select(UserPlanSession).where(
            UserPlanSession.event_id == event_id,
            col(UserPlanSession.session_id).in_(changed_session_ids),
        )
    ).all()
    changes_by_user: dict[
        UUID, list[tuple[UserPlanSession, dict, dict | None, list[str]]]
    ] = {}
    for plan in plan_rows:
        session_id = str(plan.session_id)
        before = previous_sessions.get(session_id, plan.last_known_session)
        after = current_sessions.get(session_id)
        changes = []
        if after is None:
            changes.append("was removed from the program")
        else:
            if before.get("start") != after.get("start") or before.get(
                "end"
            ) != after.get("end"):
                changes.append("has a new time")
            if before.get("room_id") != after.get("room_id") or before.get(
                "venue_id"
            ) != after.get("venue_id"):
                changes.append("has a new location")
            if not before.get("is_cancelled") and after.get("is_cancelled"):
                changes.append("was cancelled")
            if any(
                before.get(field) != after.get(field)
                for field in relevant_fields
                - {"start", "end", "room_id", "venue_id", "is_cancelled"}
            ):
                changes.append("has updated details")
        if not changes:
            continue
        changes_by_user.setdefault(plan.user_id, []).append(
            (plan, before, after, changes)
        )
        if after is not None:
            plan.last_known_session = after
            session.add(plan)

    notifications: list[Notification] = []
    for user_id, plan_changes in changes_by_user.items():
        details = [
            f"{before.get('title') or (after or {}).get('title')}: {', '.join(changes)}"
            for _plan, before, after, changes in plan_changes
        ]
        description = (
            f"{details[0]}."
            if len(details) == 1
            else f"{len(details)} sessions in your plan changed: "
            + "; ".join(details)
            + "."
        )
        single_plan = plan_changes[0][0] if len(plan_changes) == 1 else None
        notification = Notification(
            recipient_user_id=user_id,
            actor_user_id=actor.id,
            kind=PLANNED_SESSION_CHANGED,
            event_id=event_id,
            subject_key=f"publication:{version}",
            group_key=str(single_plan.session_id) if single_plan else None,
            context=(
                plan_changes[0][1].get("title")
                or (plan_changes[0][2] or {}).get("title")
                if len(plan_changes) == 1
                else f"{len(plan_changes)} planned sessions"
            ),
            description=description[:255],
        )
        session.add(notification)
        session.flush()
        record_delivery(session, notification.id, "app")
        notifications.append(notification)
    return notifications


def _event_is_past(session: Session, event_id: str) -> bool:
    """True when the event has already ended (end < now, naive UTC).

    Unknown events (no CachedEvent row) are treated as not-past so we
    preserve the existing fan-out behaviour.
    """
    end = session.exec(
        select(CachedEvent.end).where(CachedEvent.event_id == event_id)
    ).first()
    return end is not None and end < datetime.now(timezone.utc)


def _fan_out(
    session: Session,
    actor: User,
    event_id: str | None,
    kind: str,
    *,
    audience: str = "public",
    subject_key: str | None = None,
    group_key: str | None = None,
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
    if event_id is not None and event_id not in eligible_event_ids(session, [event_id]):
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
            group_key=group_key,
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


def fan_out_saved(
    session: Session,
    actor: User,
    event_id: str,
    *,
    audience: str = "public",
) -> int:
    """Notify subscribers that ``actor`` saved ``event_id``.

    ``audience`` is the per-save audience tier (``public`` | ``friends``
    | ``private``). Caller ensures ``UserSavedEvent.audience`` matches.
    """
    return _fan_out(session, actor, event_id, SUBSCRIPTION_SAVED, audience=audience)


def fan_out_review(
    session: Session,
    actor: User,
    event_id: str,
    *,
    anonymous: bool = False,
) -> int:
    """Notify subscribers that ``actor`` reviewed ``event_id``.

    Reviews only exist on past events, so the past-event guard is skipped.
    Anonymous reviews never fan out because even a masked activity row can
    correlate the review with its author through notification metadata.
    """
    if anonymous:
        return 0
    return _fan_out(
        session,
        actor,
        event_id,
        SUBSCRIPTION_REVIEW,
        skip_past_guard=True,
    )


def fan_out_milestone(
    session: Session,
    actor: User,
    subject_key: str,
    *,
    audience: str = "public",
    group_key: str | None = None,
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
        group_key=group_key,
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


def withdraw_saved(
    session: Session,
    actor: User,
    event_id: str,
) -> int:
    """Delete previously fanned-out subscription_saved notifications for
    ``(actor, event_id)``.

    Called when a user unsaves an event so the (now-withdrawn) save does
    not linger in subscribers' feeds. Returns the number of rows removed.
    """
    rows = session.exec(
        select(Notification)
        .where(Notification.kind == SUBSCRIPTION_SAVED)
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
    if event_id not in eligible_event_ids(session, [event_id]):
        return []
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
    if event_id not in eligible_event_ids(session, [event_id]):
        return []
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
