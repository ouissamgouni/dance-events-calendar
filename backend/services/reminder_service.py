"""Event reminder generation (in-app + email).

Run periodically by the notification dispatch loop. For every registered
user who is "Going" to an event starting within the configured lead window,
this creates a single in-app ``event_reminder`` notification and (when the
user opted in) sends a reminder email.

Idempotency: an ``event_reminder`` row uses ``actor_user_id = recipient``
(there is no real actor), so the existing
``(recipient, kind, actor, event_id)`` unique constraint guarantees at most
one reminder per user per event without any schema change.

Reminders cover RSVPs only (``user_event_attendances``); saved-but-not-going
events are intentionally excluded for v1.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlmodel import Session, select

from backend.services.app_settings import get_reminder_lead_hours, get_event_reminders_enabled
from backend.db.database import get_engine
from backend.db.models import CachedEvent, Notification, User, UserEventAttendance
from backend.services.email import send_event_reminder_email
from backend.services.push_service import send_push

logger = logging.getLogger(__name__)

EVENT_REMINDER = "event_reminder"


def _format_when(start: datetime, tz_name: str) -> str:
    """Format an event start time in the user's timezone for email copy."""
    try:
        tz = ZoneInfo(tz_name or "UTC")
    except (ZoneInfoNotFoundError, ValueError):
        tz = ZoneInfo("UTC")
    # ``start`` is stored naive UTC; attach UTC then convert.
    aware = start.replace(tzinfo=timezone.utc) if start.tzinfo is None else start
    local = aware.astimezone(tz)
    return local.strftime("%a %d %b at %H:%M")


def _due_pairs(session: Session, now: datetime, lead_hours: int):
    """Return (user, event) pairs that are due a reminder and have none yet."""
    window_end = now + timedelta(hours=lead_hours)
    rows = session.exec(
        select(User, CachedEvent)
        .join(
            UserEventAttendance,
            UserEventAttendance.user_id == User.id,  # type: ignore[arg-type]
        )
        .join(CachedEvent, CachedEvent.event_id == UserEventAttendance.event_id)
        .where(UserEventAttendance.user_id.is_not(None))  # type: ignore[union-attr]
        .where(User.deleted_at.is_(None))  # type: ignore[union-attr]
        .where(CachedEvent.deleted_at.is_(None))  # type: ignore[union-attr]
        .where(CachedEvent.is_hidden == False)  # noqa: E712
        .where(CachedEvent.start > now)
        .where(CachedEvent.start <= window_end)
    ).all()
    if not rows:
        return []

    # Filter out pairs that already have a reminder notification.
    pairs = [(u, e) for (u, e) in rows]
    user_ids = {u.id for u, _ in pairs}
    event_ids = {e.event_id for _, e in pairs}
    existing = set(
        session.exec(
            select(Notification.recipient_user_id, Notification.event_id)
            .where(Notification.kind == EVENT_REMINDER)
            .where(Notification.recipient_user_id.in_(user_ids))  # type: ignore[union-attr]
            .where(Notification.event_id.in_(event_ids))  # type: ignore[union-attr]
        ).all()
    )
    return [(u, e) for (u, e) in pairs if (u.id, e.event_id) not in existing]


def run_once() -> dict:
    """Generate due reminders. Returns a small stats dict for logging."""
    if not get_event_reminders_enabled():
        return {"skipped": "reminders_disabled"}

    lead_hours = get_reminder_lead_hours()
    now = datetime.utcnow()
    to_email: list[tuple] = []
    to_push: list[tuple] = []

    with Session(get_engine(), expire_on_commit=False) as session:
        due = _due_pairs(session, now, lead_hours)
        if not due:
            return {"reminders": 0}
        for user, event in due:
            session.add(
                Notification(
                    recipient_user_id=user.id,
                    actor_user_id=user.id,  # self: no external actor
                    kind=EVENT_REMINDER,
                    event_id=event.event_id,
                )
            )
            if user.email_event_reminders_enabled:
                to_email.append((user, event))
            if user.push_event_reminders_enabled:
                to_push.append((user.id, event.title, event.event_id))
        session.commit()

    # Send emails after commit so the in-app reminder is durable even if
    # SMTP is slow/unavailable. Best-effort; failures are logged, not raised.
    emailed = 0
    for user, event in to_email:
        when_label = _format_when(event.start, user.timezone)
        if send_event_reminder_email(user, event, when_label):
            emailed += 1

    # Web-push is independent of the email opt-out (separate toggle). No-ops
    # when web-push is unconfigured.
    pushed = 0
    for user_id, title, event_id in to_push:
        pushed += send_push(
            user_id,
            title="Event reminder",
            body=f"{title or 'An event'} is coming up.",
            url=f"/event/{event_id}",
            tag=f"reminder:{event_id}",
        )

    logger.info(
        "Reminder run: %d created, %d emailed, %d pushed", len(due), emailed, pushed
    )
    return {"reminders": len(due), "emailed": emailed, "pushed": pushed}
