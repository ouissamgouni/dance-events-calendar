"""Dance Passport milestone-unlock notification generation (Phase C).

Run periodically by the notification dispatch loop, alongside
``reminder_service`` and ``review_prompt_service``. For every user who has
attended at least one event, this ensures their unlocked milestones are
persisted (via the shared ``passport.evaluate_and_persist``) and then, for
any unlocked milestone that doesn't yet have a notification, creates a
single in-app ``milestone_unlocked`` notification and (when the user opted
in) sends a celebratory email/push linking to their passport.

Idempotency: a ``milestone_unlocked`` row uses ``actor_user_id =
recipient`` (there is no external actor) and carries no ``event_id``, so the
milestone key is stored in ``subject_key`` and the extended
``(recipient, kind, actor, event_id, subject_key)`` unique constraint
guarantees at most one in-app notification per user per milestone.

Decoupling insert from notify: whether a ``UserMilestone`` row was inserted
lazily by the passport GET or here by the scheduler, this service notifies
for it exactly once (the notification's existence is the dedupe). This keeps
the passport GET's lazy-unlock behaviour intact while making the scheduler
the reliable source of notifications.

Channel backfill: the in-app row is created at most once, but email/push are
tracked independently via ``emailed_at``/``pushed_at`` on that same row, so a
later toggle flip catches up on a still-un-notified channel without
re-creating the in-app row or re-sending a channel that already fired.
"""

from __future__ import annotations

import logging
from datetime import datetime

from sqlmodel import Session, select

from backend.services import passport
from backend.services.app_settings import get_milestone_notifications_enabled
from backend.db.database import get_engine
from backend.db.models import (
    Notification,
    User,
    UserEventAttendance,
    UserMilestone,
)
from backend.services.email import send_milestones_unlocked_email
from backend.services.notification_delivery import record_delivery
from backend.services.notifications import fan_out_milestone
from backend.services.push_service import send_push

logger = logging.getLogger(__name__)

MILESTONE_UNLOCKED = "milestone_unlocked"


def _candidate_user_ids(session: Session) -> list:
    """Users who have attended at least one event (only they can unlock)."""
    return list(
        session.exec(
            select(UserEventAttendance.user_id)
            .where(UserEventAttendance.user_id.is_not(None))  # type: ignore[union-attr]
            .distinct()
        ).all()
    )


def run_once() -> dict:
    """Notify users of newly-unlocked milestones. Returns a stats dict."""
    if not get_milestone_notifications_enabled():
        return {"skipped": "milestone_notifications_disabled"}

    to_email: list[tuple] = []
    to_push: list[tuple] = []
    notif_ids: dict[tuple, int] = {}
    created = 0

    with Session(get_engine(), expire_on_commit=False) as session:
        for user_id in _candidate_user_ids(session):
            user = session.get(User, user_id)
            if user is None or user.deleted_at is not None:
                continue
            created += _create_milestone_notifications(
                session, user, to_email, to_push, notif_ids
            )
        session.commit()

    emailed, pushed = _dispatch_channels(to_email, to_push, notif_ids)

    logger.info(
        "Milestone notification run: %d created, %d emailed, %d pushed",
        created,
        emailed,
        pushed,
    )
    return {"milestones": created, "emailed": emailed, "pushed": pushed}


def notify_milestones_for_user(session, user) -> dict:
    """Immediate, in-request variant of :func:`run_once` for a single user.

    Runs on the caller's ``session`` (so it participates in the request's
    transaction/DB) and dispatches email/push inline. Called right after a user
    logs an attendance so a freshly-unlocked milestone fires its in-app
    notification, email and push straight away — like a new-follower notice —
    rather than waiting for the next scheduler pass, which remains a safety net.
    """
    if not get_milestone_notifications_enabled(session):
        return {"skipped": "milestone_notifications_disabled"}

    to_email: list[tuple] = []
    to_push: list[tuple] = []
    notif_ids: dict[tuple, int] = {}

    created = _create_milestone_notifications(
        session, user, to_email, to_push, notif_ids
    )
    session.commit()

    emailed, pushed = _dispatch_channels(to_email, to_push, notif_ids, session=session)
    return {"milestones": created, "emailed": emailed, "pushed": pushed}


def _create_milestone_notifications(session, user, to_email, to_push, notif_ids) -> int:
    """Persist ``user``'s unlocked milestones and create any missing in-app
    ``milestone_unlocked`` rows. Appends per-channel work (respecting the
    user's email/push gates) to ``to_email``/``to_push`` and records the
    notification ids in ``notif_ids``. Returns the count of in-app rows created.

    Channel backfill: for a milestone whose in-app row already exists, a
    still-un-sent email/push (``emailed_at``/``pushed_at`` null) that the user
    has since opted into is queued too — so flipping a channel toggle on after
    the in-app notice already fired still catches that channel up.
    """
    passport.evaluate_and_persist(session, user)
    unlocked_keys = list(
        session.exec(
            select(UserMilestone.milestone_key).where(UserMilestone.user_id == user.id)
        ).all()
    )
    if not unlocked_keys:
        return 0
    existing = {
        n.subject_key: n
        for n in session.exec(
            select(Notification)
            .where(Notification.recipient_user_id == user.id)
            .where(Notification.kind == MILESTONE_UNLOCKED)
        ).all()
    }
    created = 0
    for key in unlocked_keys:
        milestone = passport.MILESTONES_BY_KEY.get(key)
        if milestone is None:
            continue
        notif = existing.get(key)
        if notif is None:
            notif = Notification(
                recipient_user_id=user.id,
                actor_user_id=user.id,  # self: no external actor
                kind=MILESTONE_UNLOCKED,
                subject_key=key,
                context=milestone.name,
            )
            session.add(notif)
            session.flush()
            record_delivery(session, notif.id, "app")
            created += 1
            # A freshly-unlocked milestone also fans out to the user's
            # subscribers as a "friend milestone" activity notification,
            # gated by the actor's passport visibility (private → no fan-out).
            fan_out_milestone(
                session,
                user,
                key,
                audience=getattr(user, "passport_visibility", "friends"),
                context=milestone.name,
            )
        notif_ids[(user.id, key)] = notif.id
        if user.email_milestone_unlocked_enabled and notif.emailed_at is None:
            to_email.append((user, milestone))
        if user.push_milestone_unlocked_enabled and notif.pushed_at is None:
            to_push.append((user.id, key, milestone))
    return created


def _dispatch_channels(to_email, to_push, notif_ids, session=None) -> tuple[int, int]:
    """Send queued milestone emails/pushes and stamp their delivery, mirroring
    the in-app dedupe: each channel is tracked independently on the shared row.

    When ``session`` is provided (immediate in-request path) the delivery stamps
    are written on it; otherwise (scheduler path) a fresh engine session is
    opened so the main pass isn't held open during slow SMTP/webpush I/O.
    """
    # Combine all milestones a user unlocked this pass into one email.
    by_user: dict = {}
    for user, milestone in to_email:
        by_user.setdefault(user.id, (user, []))[1].append(milestone)

    emailed = 0
    emailed_ids: list[int] = []
    for user, milestones in by_user.values():
        if send_milestones_unlocked_email(user, milestones):
            emailed += len(milestones)
            for milestone in milestones:
                nid = notif_ids.get((user.id, milestone.key))
                if nid is not None:
                    emailed_ids.append(nid)

    pushed = 0
    pushed_ids: list[int] = []
    for user_id, key, milestone in to_push:
        delivered = send_push(
            user_id,
            title="Milestone unlocked!",
            body=f"{milestone.icon} {milestone.name} — {milestone.description}",
            url="/mine/passport",
            tag=f"milestone:{key}",
        )
        pushed += delivered
        if delivered:
            nid = notif_ids.get((user_id, key))
            if nid is not None:
                pushed_ids.append(nid)

    if emailed_ids or pushed_ids:
        if session is not None:
            _stamp_deliveries(session, emailed_ids, pushed_ids)
            session.commit()
        else:
            with Session(get_engine()) as fresh:
                _stamp_deliveries(fresh, emailed_ids, pushed_ids)
                fresh.commit()

    return emailed, pushed


def _stamp_deliveries(session, emailed_ids, pushed_ids) -> None:
    """Stamp ``emailed_at``/``pushed_at`` and log per-channel delivery rows."""
    from sqlmodel import col, update

    stamp_now = datetime.utcnow()
    if emailed_ids:
        session.exec(
            update(Notification)
            .where(col(Notification.id).in_(emailed_ids))
            .values(emailed_at=stamp_now)
        )
        for nid in emailed_ids:
            record_delivery(session, nid, "email", stamp_now)
    if pushed_ids:
        session.exec(
            update(Notification)
            .where(col(Notification.id).in_(pushed_ids))
            .values(pushed_at=stamp_now)
        )
        for nid in pushed_ids:
            record_delivery(session, nid, "push", stamp_now)
