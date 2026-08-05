"""Post-event "how was it?" review-prompt generation (Event Quality Layer P3).

Run periodically by the notification dispatch loop, alongside
``reminder_service``. For every registered user who RSVP'd "Going" to an
event that ended at least ``review_prompt_delay_hours`` ago (and hasn't
already submitted a rating for it), this creates a single in-app
``event_review_prompt`` notification and (when the user opted in) sends a
nudge email/push linking back to the event so they can rate their
experience.

Idempotency: an ``event_review_prompt`` row uses ``actor_user_id =
recipient`` (there is no real actor), so the existing
``(recipient, kind, actor, event_id)`` unique constraint guarantees at most
one in-app prompt per user per event without any schema change.

Channel backfill: the in-app row is created at most once, but email/push
are tracked independently via ``emailed_at``/``pushed_at`` on that same
row. If a user's in-app prompt was created while their email or push
toggle was off, turning the toggle on later still lets the *next* tick
send that channel for the still-unrated event — we never re-email/re-push
a channel that already fired, and we never touch events the user has
since rated.

Bounded lookback: only events that ended within the configured
``review_prompt_lookback_hours`` (in addition to the configured delay) are
scanned each tick, so the query stays cheap regardless of how far back the
events table goes. Combined with the dedupe check above, running this on
every dispatch tick is safe and never double-sends.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Optional
from datetime import datetime, timedelta
from uuid import UUID

from sqlmodel import Session, select

from backend.services.app_settings import (
    get_review_prompt_delay_hours,
    get_review_prompt_enabled,
    get_review_prompt_lookback_hours,
)
from backend.db.database import get_engine
from backend.db.models import (
    CachedEvent,
    EventRating,
    Notification,
    User,
    UserEventAttendance,
    UserFollow,
)
from backend.services.email import send_event_review_prompt_email
from backend.services.notification_delivery import record_delivery
from backend.services.push_service import send_push

logger = logging.getLogger(__name__)

EVENT_REVIEW_PROMPT = "event_review_prompt"

# How many friend names to spell out before collapsing the rest into "+N
# others" in the social-proof line ("Laura, Marc +3 others").
_MAX_PROOF_NAMES = 2


@dataclass
class FriendProof:
    """Social proof that people the recipient follows have already reviewed an
    event: up to ``_MAX_PROOF_NAMES`` spelled-out names plus a count of any
    remaining reviewers folded into "+N others"."""

    names: list[str]
    others: int


def _display_name(user: User) -> str:
    # First name only for a friendly social-proof line ("Carol, Dan …").
    full = user.display_name or user.handle or (user.email or "").split("@", 1)[0]
    return full.split(" ", 1)[0] if full else full


def friend_review_proof(
    session: Session, recipient_id: UUID, event_id: str
) -> Optional[FriendProof]:
    """Return social proof for a recipient's review prompt, or ``None``.

    A "friend" here is anyone the recipient follows (a one-directional
    approved follow). Non-anonymous reviews contribute a spelled-out name;
    anonymous reviews by followed users can't be attributed to a name but
    still count toward the "+N others" tail. Any non-rejected rating counts.
    Returns ``None`` when no followed user has a nameable review (we never
    render "shared their experience" with zero names).
    """
    followed_ids = set(
        session.exec(
            select(UserFollow.followee_id)
            .where(UserFollow.follower_id == recipient_id)
            .where(UserFollow.status == "approved")
        ).all()
    )
    if not followed_ids:
        return None
    rows = session.exec(
        select(EventRating, User)
        .join(User, User.id == EventRating.user_id)  # type: ignore[arg-type]
        .where(EventRating.event_id == event_id)
        .where(EventRating.user_id.in_(followed_ids))  # type: ignore[union-attr]
        .where(EventRating.status != "rejected")
    ).all()
    if not rows:
        return None
    named: list[str] = []
    anon = 0
    for rating, user in rows:
        if rating.is_anonymous:
            anon += 1
        else:
            named.append(_display_name(user))
    if not named:
        return None
    # Deterministic ordering so the phrase (and the stored in-app snapshot)
    # is stable across ticks and easy to assert in tests.
    named.sort(key=str.casefold)
    shown = named[:_MAX_PROOF_NAMES]
    others = (len(named) - len(shown)) + anon
    return FriendProof(names=shown, others=others)


def proof_phrase(proof: FriendProof) -> str:
    """ "Laura" | "Laura and Marc" | "Laura, Marc +3 others"."""
    names = proof.names
    if proof.others > 0:
        noun = "other" if proof.others == 1 else "others"
        return f"{', '.join(names)} +{proof.others} {noun}"
    if len(names) == 1:
        return names[0]
    if len(names) == 2:
        return f"{names[0]} and {names[1]}"
    return ", ".join(names)


def review_prompt_push_copy(
    event_title: Optional[str], phrase: Optional[str]
) -> tuple[str, str]:
    """Return (title, body) for the review-prompt web push."""
    title = event_title or "the event"
    if phrase:
        return (
            f"{phrase} shared their experience",
            f"Share yours at {title}.",
        )
    return ("How was it?", f"Rate your experience at {title}.")


def _due_pairs(session: Session, now: datetime, delay_hours: int, lookback_hours: int):
    """Return (user, event, existing_notif) triples due a review prompt.

    ``existing_notif`` is the already-created ``Notification`` row for this
    (user, event) pair, or ``None`` if the in-app prompt still needs to be
    created. A pair with an existing notification is only included if a
    channel (email or push) is now enabled but hasn't fired for it yet
    (``emailed_at``/``pushed_at`` still ``None``) \u2014 this lets a later toggle
    flip catch up on a still-unrated event without re-creating the in-app
    row or re-sending a channel that already went out.
    """
    window_start = now - timedelta(hours=delay_hours + lookback_hours)
    window_end = now - timedelta(hours=delay_hours)
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
        .where(CachedEvent.end > window_start)
        .where(CachedEvent.end <= window_end)
    ).all()
    if not rows:
        return []

    pairs = [(u, e) for (u, e) in rows]
    user_ids = {u.id for u, _ in pairs}
    event_ids = {e.event_id for _, e in pairs}

    existing_notifs = {
        (n.recipient_user_id, n.event_id): n
        for n in session.exec(
            select(Notification)
            .where(Notification.kind == EVENT_REVIEW_PROMPT)
            .where(Notification.recipient_user_id.in_(user_ids))  # type: ignore[union-attr]
            .where(Notification.event_id.in_(event_ids))  # type: ignore[union-attr]
        ).all()
    }
    already_rated = set(
        session.exec(
            select(EventRating.user_id, EventRating.event_id)
            .where(EventRating.user_id.in_(user_ids))  # type: ignore[union-attr]
            .where(EventRating.event_id.in_(event_ids))  # type: ignore[union-attr]
        ).all()
    )

    due: list[tuple[User, CachedEvent, Optional[Notification]]] = []
    for u, e in pairs:
        if (u.id, e.event_id) in already_rated:
            continue
        existing = existing_notifs.get((u.id, e.event_id))
        if existing is None:
            due.append((u, e, None))
            continue
        needs_email = u.email_review_prompt_enabled and existing.emailed_at is None
        needs_push = u.push_review_prompt_enabled and existing.pushed_at is None
        if needs_email or needs_push:
            due.append((u, e, existing))
    return due


def run_once() -> dict:
    """Generate due review prompts. Returns a small stats dict for logging."""
    if not get_review_prompt_enabled():
        return {"skipped": "review_prompt_disabled"}

    delay_hours = get_review_prompt_delay_hours()
    lookback_hours = get_review_prompt_lookback_hours()
    now = datetime.utcnow()
    to_email: list[tuple] = []
    to_push: list[tuple] = []
    notif_ids: dict[tuple, int] = {}

    with Session(get_engine(), expire_on_commit=False) as session:
        due = _due_pairs(session, now, delay_hours, lookback_hours)
        if not due:
            return {"prompts": 0}
        created = 0
        for user, event, existing in due:
            proof = friend_review_proof(session, user.id, event.event_id)
            context = proof_phrase(proof) if proof else None
            if existing is None:
                notif = Notification(
                    recipient_user_id=user.id,
                    actor_user_id=user.id,  # self: no external actor
                    kind=EVENT_REVIEW_PROMPT,
                    event_id=event.event_id,
                    context=context,
                )
                session.add(notif)
                session.flush()
                notif_id = notif.id
                record_delivery(session, notif_id, "app")
                created += 1
            else:
                notif_id = existing.id
                # Refresh the in-app snapshot if a friend has since reviewed.
                if context and existing.context != context:
                    existing.context = context
                    session.add(existing)
            notif_ids[(user.id, event.event_id)] = notif_id
            if user.email_review_prompt_enabled and (
                existing is None or existing.emailed_at is None
            ):
                to_email.append((user, event, context))
            if user.push_review_prompt_enabled and (
                existing is None or existing.pushed_at is None
            ):
                to_push.append((user.id, event.title, event.event_id, context))
        session.commit()

    emailed = 0
    emailed_ids: list[int] = []
    for user, event, phrase in to_email:
        if send_event_review_prompt_email(user, event, friend_proof=phrase):
            emailed += 1
            nid = notif_ids.get((user.id, event.event_id))
            if nid is not None:
                emailed_ids.append(nid)

    pushed = 0
    pushed_ids: list[int] = []
    for user_id, title, event_id, phrase in to_push:
        push_title, push_body = review_prompt_push_copy(title, phrase)
        delivered = send_push(
            user_id,
            title=push_title,
            body=push_body,
            url=f"/event/{event_id}?rate=1#community",
            tag=f"review-prompt:{event_id}",
        )
        pushed += delivered
        if delivered:
            nid = notif_ids.get((user_id, event_id))
            if nid is not None:
                pushed_ids.append(nid)

    if emailed_ids or pushed_ids:
        from sqlmodel import col, update

        with Session(get_engine()) as session:
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
            session.commit()

    logger.info(
        "Review prompt run: %d created, %d emailed, %d pushed",
        created,
        emailed,
        pushed,
    )
    if created == 0 and emailed == 0 and pushed == 0:
        # Nothing actually happened this tick (e.g. the only "due" pairs
        # were push retries for users with no subscription) — report the
        # same minimal shape as the "nothing due" early return above.
        return {"prompts": 0}
    return {"prompts": created, "emailed": emailed, "pushed": pushed}
