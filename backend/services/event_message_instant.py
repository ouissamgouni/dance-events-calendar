"""Instant (non-batched) delivery of event-message notifications.

When an admin enables *instant* email for the ``event_messages`` feature, a
new board post or reply should reach engaged users right away instead of
waiting for the activity-digest scheduler (``services/activity_email.py``).

Run by the post-request ``deliver`` job (``push_jobs``) for one recipient,
before the generic activity push. It sends a content-aware email + push per
notification and stamps the same idempotency fields the scheduler uses
(``instant_emailed_at`` / ``pushed_at``) so nothing is re-delivered.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlmodel import Session, or_, select

from backend.db.models import CachedEvent, Notification, User
from backend.services.activity_email import _MAX_AGE
from backend.services.app_settings import (
    get_feature_email_instant,
    get_feature_push_enabled,
)
from backend.services.email import (
    event_message_action_phrase,
    send_event_message_instant_email,
)
from backend.services.event_visibility import event_is_user_facing
from backend.services.notification_delivery import record_delivery, tracked_url
from backend.services.push_service import (
    PushTransientError,
    send_push,
    webpush_configured,
)

logger = logging.getLogger(__name__)

FEATURE = "event_messages"
KINDS = ("event_message", "event_message_reply")


def _actor_name(actor: User | None) -> str:
    if actor is None:
        return "Someone"
    return (
        getattr(actor, "display_name", None)
        or (f"@{actor.handle}" if getattr(actor, "handle", None) else None)
        or "Someone"
    )


def deliver_for_recipient(session: Session, recipient_id, source: str = "job") -> dict:
    """Deliver ``recipient_id``'s pending event-message rows when instant is on.

    Rows are claimed with ``FOR UPDATE SKIP LOCKED`` until commit. A transient
    push failure leaves ``pushed_at`` unset and is counted in ``push_retry``.
    Commits. Returns ``{"emails", "pushes", "push_retry"}``.
    """
    stats = {"emails": 0, "pushes": 0, "push_retry": 0}
    if not get_feature_email_instant(FEATURE, session):
        return stats
    recipient = session.get(User, recipient_id)
    if recipient is None or recipient.deleted_at is not None:
        return stats

    now = datetime.now(timezone.utc)
    notifs = session.exec(
        select(Notification)
        .where(Notification.recipient_user_id == recipient_id)
        .where(Notification.kind.in_(KINDS))  # type: ignore[union-attr]
        .where(Notification.created_at >= now - _MAX_AGE)
        .where(
            or_(
                Notification.instant_emailed_at.is_(None),  # type: ignore[union-attr]
                Notification.pushed_at.is_(None),  # type: ignore[union-attr]
            )
        )
        .order_by(Notification.created_at)
        .with_for_update(skip_locked=True, of=Notification)
    ).all()
    if not notifs:
        session.commit()
        return stats

    users = {
        u.id: u
        for u in session.exec(
            select(User).where(User.id.in_({n.actor_user_id for n in notifs}))  # type: ignore[union-attr]
        ).all()
    }
    events = {
        e.event_id: e
        for e in session.exec(
            select(CachedEvent).where(
                CachedEvent.event_id.in_({n.event_id for n in notifs if n.event_id})  # type: ignore[union-attr]
            )
        ).all()
    }
    user_facing = {
        eid: event_is_user_facing(session, event) for eid, event in events.items()
    }
    push_ok = webpush_configured() and get_feature_push_enabled(FEATURE, session)

    for n in notifs:
        event = events.get(n.event_id) if n.event_id else None
        if event is None or not user_facing.get(event.event_id):
            continue
        actor = users.get(n.actor_user_id)

        if (
            recipient.email
            and getattr(recipient, "email_event_messages_enabled", True)
            and n.instant_emailed_at is None
            and send_event_message_instant_email(
                recipient,
                actor,
                event,
                n.kind,
                n.context,
                n.description,
                notification_id=n.id,
            )
        ):
            n.instant_emailed_at = now
            session.add(n)
            record_delivery(session, n.id, "email", now, mode="instant", source=source)
            stats["emails"] += 1

        if (
            push_ok
            and getattr(recipient, "push_event_messages_enabled", True)
            and n.pushed_at is None
        ):
            title = (
                f"{_actor_name(actor)} "
                f"{event_message_action_phrase(n.kind, n.context)} "
                f"{event.title or 'an event'}"
            )
            tag = f"event-messages-{event.event_id}"
            try:
                delivered = send_push(
                    recipient.id,
                    title=title,
                    body=n.description or "",
                    url=tracked_url(f"/event/{event.event_id}#messages", n.id, "push"),
                    tag=tag,
                    topic=tag,
                    raise_on_transient=True,
                )
            except PushTransientError:
                stats["push_retry"] += 1
                continue
            if delivered:
                n.pushed_at = now
                session.add(n)
                record_delivery(session, n.id, "push", now, source=source)
                stats["pushes"] += 1

    session.commit()
    return stats
