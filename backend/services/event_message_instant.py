"""Instant (non-batched) delivery of event-message notifications.

When an admin enables *instant* email for the ``event_messages`` feature, a
new board post or reply should reach engaged users right away instead of
waiting for the activity-digest scheduler (``services/activity_email.py``).

This module is called from the message-create route immediately after the
in-app notifications are fanned out. It sends a content-aware email + push per
recipient and stamps the same idempotency fields the scheduler uses
(``instant_emailed_at`` / ``pushed_at``) so the scheduler never re-delivers
them. Everything here is best-effort — the caller wraps it so a delivery
failure can never break posting.
"""

from __future__ import annotations

import logging
from datetime import datetime

from sqlmodel import Session, select

from backend.db.models import CachedEvent, Notification, User
from backend.services.app_settings import get_feature_email_instant
from backend.services.email import (
    event_message_action_phrase,
    send_event_message_instant_email,
)
from backend.services.notification_delivery import record_delivery
from backend.services.push_service import send_push, webpush_configured

logger = logging.getLogger(__name__)

FEATURE = "event_messages"


def _actor_name(actor: User | None) -> str:
    if actor is None:
        return "Someone"
    return (
        getattr(actor, "display_name", None)
        or (f"@{actor.handle}" if getattr(actor, "handle", None) else None)
        or "Someone"
    )


def dispatch_event_message_instant(
    session: Session,
    notifs: list[Notification],
    *,
    actor: User,
    event: CachedEvent | None,
) -> dict:
    """Deliver ``notifs`` instantly when the admin instant toggle is on.

    Sends an email (when the recipient's per-user email flag allows) and a
    push (when configured and the recipient's push flag allows), stamping
    ``instant_emailed_at`` / ``pushed_at`` on success so the digest scheduler
    skips them. Returns ``{"emails": int, "pushes": int}``. Commits.
    """
    if not notifs or event is None:
        return {"emails": 0, "pushes": 0}
    if not get_feature_email_instant(FEATURE, session):
        return {"emails": 0, "pushes": 0}

    now = datetime.utcnow()
    recipient_ids = {n.recipient_user_id for n in notifs if n.recipient_user_id}
    recipients = {
        u.id: u
        for u in session.exec(select(User).where(User.id.in_(recipient_ids))).all()
    }
    push_ok = webpush_configured()
    event_url = f"/event/{event.event_id}#messages"
    event_title = event.title or "an event"

    emails = 0
    pushes = 0
    for n in notifs:
        recipient = recipients.get(n.recipient_user_id)
        if recipient is None or recipient.deleted_at is not None:
            continue

        if (
            recipient.email
            and getattr(recipient, "email_event_messages_enabled", True)
            and n.instant_emailed_at is None
            and send_event_message_instant_email(
                recipient, actor, event, n.kind, n.context, n.description
            )
        ):
            n.instant_emailed_at = now
            session.add(n)
            record_delivery(session, n.id, "email", now)
            emails += 1

        if (
            push_ok
            and getattr(recipient, "push_event_messages_enabled", True)
            and n.pushed_at is None
        ):
            title = (
                f"{_actor_name(actor)} "
                f"{event_message_action_phrase(n.kind, n.context)} {event_title}"
            )
            if send_push(
                recipient.id,
                title=title,
                body=n.description or "",
                url=event_url,
                tag=f"event-messages-{event.event_id}",
            ):
                n.pushed_at = now
                session.add(n)
                record_delivery(session, n.id, "push", now)
                pushes += 1

    session.commit()
    return {"emails": emails, "pushes": pushes}
