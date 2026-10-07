"""Job handlers for request-triggered notification delivery.

Notifications of ``FAST_PUSH_KINDS`` committed by any session enqueue a
debounced per-recipient ``deliver`` job (instant email + push), so requests
never call email/push services. Request handlers that may unlock a passport
milestone enqueue a ``milestones`` job instead of evaluating them inline.
"""

from __future__ import annotations

import logging
from uuid import UUID

from sqlalchemy import event, inspect
from sqlalchemy.orm import Session as OrmSession
from sqlmodel import Session

from backend.config.loader import get_notification_debounce_seconds
from backend.db.database import get_engine
from backend.db.models import Notification, User
from backend.services import activity_email, event_message_instant, job_queue

logger = logging.getLogger(__name__)

DELIVER_JOB = "deliver"
MILESTONES_JOB = "milestones"
_SESSION_INFO_KEY = "deliver_job_recipients"


def deliver_for_recipient(recipient_id: str) -> None:
    rid = UUID(recipient_id)
    # Rich event-message delivery first so the generic pass skips those rows.
    with Session(get_engine(), expire_on_commit=False) as session:
        em_stats = event_message_instant.deliver_for_recipient(session, rid)
    if em_stats["push_retry"]:
        # Retry before the generic pass would push those rows without rich copy.
        logger.info(
            "Deliver job recipient=%s: event-message push failed transiently",
            recipient_id,
        )
        raise job_queue.RetryLater()
    stats = activity_email.deliver_immediate({rid}, source="job")
    logger.info(
        "Deliver job recipient=%s: event_messages(emails=%d pushes=%d) "
        "activity(instant_emails=%d pushes=%d) push_retry=%d",
        recipient_id,
        em_stats["emails"],
        em_stats["pushes"],
        stats.get("instant_emails", 0),
        stats.get("pushed", 0),
        stats.get("push_retry", 0),
    )
    if stats.get("push_retry"):
        raise job_queue.RetryLater()


def check_milestones(user_id: str) -> None:
    from backend.services import milestone_notification_service

    with Session(get_engine(), expire_on_commit=False) as session:
        user = session.get(User, UUID(user_id))
        if user is None or user.deleted_at is not None:
            return
        milestone_notification_service.notify_milestones_for_user(
            session, user, source="job"
        )


def enqueue_milestone_check(user_id) -> None:
    job_queue.enqueue(MILESTONES_JOB, str(user_id))


def _collect_new_notifications(session, flush_context) -> None:
    recipients = None
    for obj in (*session.new, *session.dirty):
        if (
            not isinstance(obj, Notification)
            or obj.kind not in activity_email.FAST_PUSH_KINDS
            or obj.pushed_at is not None
        ):
            continue
        # Dirty rows count only when re-alerted (pushed_at reset), not e.g. read.
        if (
            obj not in session.new
            and not inspect(obj).attrs.pushed_at.history.has_changes()
        ):
            continue
        if recipients is None:
            recipients = session.info.setdefault(_SESSION_INFO_KEY, set())
        recipients.add(obj.recipient_user_id)


def _enqueue_after_commit(session) -> None:
    recipients = session.info.pop(_SESSION_INFO_KEY, ())
    if not recipients:
        return
    delay = get_notification_debounce_seconds()
    for recipient_id in recipients:
        job_queue.enqueue(DELIVER_JOB, str(recipient_id), delay)


def _discard_on_rollback(session) -> None:
    session.info.pop(_SESSION_INFO_KEY, None)


def install(commit_hook: bool = True) -> None:
    """Register job handlers and, optionally, the commit hook (idempotent)."""
    job_queue.register(DELIVER_JOB, deliver_for_recipient)
    job_queue.register(MILESTONES_JOB, check_milestones)
    if not commit_hook:
        return
    for name, fn in (
        ("after_flush", _collect_new_notifications),
        ("after_commit", _enqueue_after_commit),
        ("after_rollback", _discard_on_rollback),
    ):
        if not event.contains(OrmSession, name, fn):
            event.listen(OrmSession, name, fn)
