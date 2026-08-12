"""Instant (non-batched) email for request-triggered activity notifications.

When an admin sets a feature's email mode to *instant*, the matching activity
(a follow, a new friend, a follow request/approval, a Going, a review, an
approved suggestion) should email right away instead of waiting for the
activity-digest scheduler tick, which only runs every
``notification_interval_minutes``.

The request route calls :func:`dispatch_activity_instant` immediately after
fanning out the in-app notifications. We look up the freshly created,
not-yet-instant-emailed rows for this ``(kind[, actor][, event])`` and, per
recipient, render them with the SAME helper the digest uses
(``activity_email._render_line``) so instant and digest copy stay identical.
Each delivered row is stamped ``instant_emailed_at`` so the scheduler never
re-emails it.

EMAIL ONLY — push is intentionally not sent here. Push is delivered by the
dispatch tick regardless of the email instant/digest toggle, so a feature's
push timing never depends on whether its email is instant or batched. In-app
delivery is likewise untouched (it already happens synchronously at fan-out).
Everything here is best-effort: a delivery failure never breaks the action.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable
from datetime import datetime

from sqlmodel import Session, select

from backend.db.models import (
    CachedEvent,
    Notification,
    User,
    UserEventAttendance,
)
from backend.services import activity_email
from backend.services.app_settings import get_feature_email_instant
from backend.services.email import send_activity_digest_email
from backend.services.notification_delivery import record_delivery

logger = logging.getLogger(__name__)

# Request-triggered kinds this module can deliver instantly. ``interest_event``
# is scan-only (no request trigger) and ``milestone_unlocked`` /
# ``event_message`` have their own dedicated instant services, so all three are
# intentionally absent.
INSTANT_KINDS = frozenset(
    {
        "subscription_going",
        "subscription_review",
        "subscription_suggested",
        "new_follower",
        "new_friend",
        "follow_request",
        "follow_request_approved",
    }
)


def dispatch_activity_instant(
    session: Session,
    *,
    kind: str,
    actor: User | None = None,
    event_id: str | None = None,
    recipient_ids: Iterable[int] | None = None,
) -> dict:
    """Instantly email the pending notifications for one activity ``kind``.

    Scoping:
      - Event-based kinds (going / review / suggested) pass ``actor`` and
        ``event_id``; every subscriber row for that ``(actor, kind, event)``
        is a candidate.
      - Event-less social kinds (follower / friend / request / approved) pass
        ``recipient_ids``; rows are matched by recipient (not actor, so the
        bidirectional ``new_friend`` pair is handled).

    No-ops unless the feature's email mode is *instant*. Renders each row with
    the digest's ``_render_line`` and sends one per-feature email per
    recipient, stamping ``instant_emailed_at`` on delivery. Commits. Returns
    ``{"emails": int}``.
    """
    feature = activity_email.FEATURE_BY_KIND.get(kind)
    if kind not in INSTANT_KINDS or feature is None:
        return {"emails": 0}
    if recipient_ids is None and actor is None:
        return {"emails": 0}
    if not get_feature_email_instant(feature, session):
        return {"emails": 0}

    stmt = (
        select(Notification)
        .where(Notification.kind == kind)
        .where(Notification.instant_emailed_at.is_(None))  # type: ignore[union-attr]
    )
    if recipient_ids is not None:
        ids = list(recipient_ids)
        if not ids:
            return {"emails": 0}
        stmt = stmt.where(Notification.recipient_user_id.in_(ids))  # type: ignore[union-attr]
    else:
        stmt = stmt.where(Notification.actor_user_id == actor.id)  # type: ignore[union-attr]
    if event_id is not None:
        stmt = stmt.where(Notification.event_id == event_id)
    else:
        stmt = stmt.where(Notification.event_id.is_(None))  # type: ignore[union-attr]

    rows = session.exec(stmt).all()
    if not rows:
        return {"emails": 0}

    now = datetime.utcnow()
    recipient_id_set = {n.recipient_user_id for n in rows}
    actor_id_set = {n.actor_user_id for n in rows}
    users = {
        u.id: u
        for u in session.exec(
            select(User).where(User.id.in_(recipient_id_set | actor_id_set))  # type: ignore[union-attr]
        ).all()
    }
    event_ids = {n.event_id for n in rows if n.event_id}
    events = (
        {
            e.event_id: e
            for e in session.exec(
                select(CachedEvent).where(CachedEvent.event_id.in_(event_ids))  # type: ignore[union-attr]
            ).all()
        }
        if event_ids
        else {}
    )

    # "You and X are going to ..." co-attendance, only for going rows.
    going_pairs: set[tuple] = set()
    going_event_ids = {
        n.event_id for n in rows if n.kind == "subscription_going" and n.event_id
    }
    if going_event_ids:
        for row in session.exec(
            select(UserEventAttendance.user_id, UserEventAttendance.event_id)
            .where(UserEventAttendance.user_id.in_(recipient_id_set))  # type: ignore[union-attr]
            .where(UserEventAttendance.event_id.in_(going_event_ids))  # type: ignore[union-attr]
        ).all():
            going_pairs.add((row[0], row[1]))

    email_flag = activity_email.CHANNEL_FLAG[("email", feature)]
    by_recipient: dict[int, list[Notification]] = {}
    for n in rows:
        recipient = users.get(n.recipient_user_id)
        if recipient is None or recipient.deleted_at is not None:
            continue
        by_recipient.setdefault(n.recipient_user_id, []).append(n)

    # Late import to avoid a circular dependency with routes.social.
    from backend.api.routes.social import get_people_suggestions_for_email

    emails = 0
    for recipient_id, notifs in by_recipient.items():
        recipient = users[recipient_id]
        if not recipient.email or not getattr(recipient, email_flag, True):
            continue
        lines = [
            activity_email._render_line(
                n.kind,
                users.get(n.actor_user_id),
                events.get(n.event_id) if n.event_id else None,
                n.context,
                also_going=(
                    n.kind == "subscription_going"
                    and (n.recipient_user_id, n.event_id) in going_pairs
                ),
                subject_key=n.subject_key,
                description=n.description,
            )
            for n in notifs
        ]
        suggestions = None
        if feature == "social_activity":
            suggestions = [
                {
                    "handle": item.handle,
                    "display_name": item.display_name,
                    "avatar_url": item.avatar_url,
                    "mutual_friend_count": item.mutual_friend_count,
                    "followers_count": item.followers_count,
                }
                for item in get_people_suggestions_for_email(
                    session, recipient, limit=5
                )
            ]
        if send_activity_digest_email(
            recipient, lines, feature=feature, suggestions=suggestions
        ):
            for n in notifs:
                n.instant_emailed_at = now
                session.add(n)
                record_delivery(session, n.id, "email", now)
                emails += 1

    session.commit()
    return {"emails": emails}
