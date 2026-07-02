"""Batched activity digest emails.

Run periodically by the notification dispatch loop. Collects recent in-app
notifications that have not yet been emailed, groups them per recipient, and
sends a single digest email (so a burst of follows/RSVPs becomes one email,
not ten). Each emailed notification is stamped with ``emailed_at`` to keep
delivery idempotent across loop ticks.

Only friend/event *activity* kinds are emailed here. ``event_reminder`` rows
are emailed inline by ``reminder_service`` and are never selected.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from html import escape

from sqlmodel import Session, select

from backend.config.loader import get_activity_email_enabled
from backend.db.database import get_engine
from backend.db.models import CachedEvent, Notification, User
from backend.services.email import send_activity_digest_email
from backend.services.push_service import send_push

logger = logging.getLogger(__name__)

# Kinds eligible for digest emails (subset of all notification kinds).
ACTIVITY_KINDS = (
    "subscription_going",
    "subscription_suggested",
    "new_follower",
    "new_friend",
    "follow_request",
    "follow_request_approved",
)

# Wait this long after a notification is created before emailing, so a burst
# of related rows lands in one digest rather than several.
_BATCH_DELAY = timedelta(minutes=2)
# Don't email notifications older than this (avoids dumping a large backlog
# on first deploy or after downtime).
_MAX_AGE = timedelta(hours=24)


def _render_line(kind: str, actor: User | None, event: CachedEvent | None) -> str:
    """Return an escaped HTML snippet describing one notification."""
    if actor is None:
        who = "Someone"
    else:
        who = escape(
            actor.display_name or (f"@{actor.handle}" if actor.handle else "Someone")
        )
    title = escape(event.title) if event and event.title else "an event"
    if kind == "subscription_going":
        return f"<strong>{who}</strong> is going to {title}"
    if kind == "subscription_suggested":
        return f"<strong>{who}</strong>'s suggested event {title} was approved"
    if kind == "new_follower":
        return f"<strong>{who}</strong> started following you"
    if kind == "new_friend":
        return f"You and <strong>{who}</strong> are now friends"
    if kind == "follow_request":
        return f"<strong>{who}</strong> requested to follow you"
    if kind == "follow_request_approved":
        return f"<strong>{who}</strong> approved your follow request"
    return f"New activity from <strong>{who}</strong>"


def _render_plain(kind: str, actor: User | None, event: CachedEvent | None) -> str:
    """Return a plain-text snippet describing one notification (for push)."""
    who = (
        actor.display_name or (f"@{actor.handle}" if actor.handle else "Someone")
        if actor is not None
        else "Someone"
    )
    title = event.title if event and event.title else "an event"
    if kind == "subscription_going":
        return f"{who} is going to {title}"
    if kind == "subscription_suggested":
        return f"{who}'s suggested event {title} was approved"
    if kind == "new_follower":
        return f"{who} started following you"
    if kind == "new_friend":
        return f"You and {who} are now friends"
    if kind == "follow_request":
        return f"{who} requested to follow you"
    if kind == "follow_request_approved":
        return f"{who} approved your follow request"
    return f"New activity from {who}"


def run_once() -> dict:
    """Send pending activity digests. Returns a stats dict for logging."""
    if not get_activity_email_enabled():
        return {"skipped": "activity_email_disabled"}

    now = datetime.utcnow()
    cutoff_recent = now - _BATCH_DELAY
    cutoff_old = now - _MAX_AGE

    with Session(get_engine()) as session:
        pending = session.exec(
            select(Notification)
            .where(Notification.emailed_at.is_(None))  # type: ignore[union-attr]
            .where(Notification.kind.in_(ACTIVITY_KINDS))  # type: ignore[union-attr]
            .where(Notification.created_at <= cutoff_recent)
            .where(Notification.created_at >= cutoff_old)
            .order_by(Notification.recipient_user_id, Notification.created_at)
        ).all()
        if not pending:
            return {"digests": 0}

        # Hydrate actors + events in bulk.
        actor_ids = {n.actor_user_id for n in pending}
        recipient_ids = {n.recipient_user_id for n in pending}
        event_ids = {n.event_id for n in pending if n.event_id}
        users = {
            u.id: u
            for u in session.exec(
                select(User).where(User.id.in_(actor_ids | recipient_ids))  # type: ignore[union-attr]
            ).all()
        }
        events = {
            e.event_id: e
            for e in session.exec(
                select(CachedEvent).where(CachedEvent.event_id.in_(event_ids))  # type: ignore[union-attr]
            ).all()
            if event_ids
        }

        # Group per recipient, honoring per-user opt-out + soft delete.
        by_recipient: dict = {}
        for n in pending:
            recipient = users.get(n.recipient_user_id)
            if not recipient or recipient.deleted_at is not None:
                continue
            if not recipient.activity_email_enabled:
                continue
            by_recipient.setdefault(recipient.id, []).append(n)

        digests = 0
        stamped = 0
        for recipient_id, notifs in by_recipient.items():
            recipient = users[recipient_id]
            lines = [
                _render_line(
                    n.kind,
                    users.get(n.actor_user_id),
                    events.get(n.event_id) if n.event_id else None,
                )
                for n in notifs
            ]
            send_activity_digest_email(recipient, lines)
            digests += 1

        # Web-push is gated by a separate toggle (``push_enabled``), so group
        # independently of the email opt-out above. One digest push per
        # recipient. No-ops when web-push is unconfigured.
        pushed = 0
        push_groups: dict = {}
        for n in pending:
            recipient = users.get(n.recipient_user_id)
            if not recipient or recipient.deleted_at is not None:
                continue
            if not recipient.push_enabled:
                continue
            push_groups.setdefault(recipient.id, []).append(n)
        for recipient_id, notifs in push_groups.items():
            first = _render_plain(
                notifs[0].kind,
                users.get(notifs[0].actor_user_id),
                events.get(notifs[0].event_id) if notifs[0].event_id else None,
            )
            extra = len(notifs) - 1
            body = first if extra <= 0 else f"{first} and {extra} more"
            pushed += send_push(
                recipient_id,
                title="Movida",
                body=body,
                url="/notifications",
                tag="activity-digest",
            )

        # Stamp every selected notification (including opted-out recipients)
        # so they are not re-scanned on the next tick.
        for n in pending:
            n.emailed_at = now
            stamped += 1
        session.commit()

    logger.info(
        "Activity digest run: %d emails, %d pushes, %d notifications stamped",
        digests,
        pushed,
        stamped,
    )
    return {"digests": digests, "pushed": pushed, "stamped": stamped}
