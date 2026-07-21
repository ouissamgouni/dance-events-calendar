"""Batched activity digest emails.

Run periodically by the notification dispatch loop. Collects recent in-app
notifications that have not yet been emailed, groups them per recipient
**and per feature bucket** (social activity vs interest matches), and sends
a single digest per (recipient, feature). Each emailed notification is
stamped with ``emailed_at`` to keep delivery idempotent across loop ticks.

Only friend/event *activity* kinds are emailed here. ``event_reminder`` rows
are emailed inline by ``reminder_service`` and are never selected.

Per Phase G, delivery channels (email/push) are gated per feature via
independent flags on ``User``; if a user has social=off but interest=on,
they receive an interest digest but no social digest.

Cadence: digests fire on a fixed weekly schedule (default twice a week —
Tuesday + Friday at 09:00), interpreted in each recipient's own timezone.
Ticks outside the scheduled slot for a given user leave that user's
pending notifications untouched so they roll up into the next slot. Pass
``force=True`` to bypass the schedule (used by the admin trigger CLI).
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from html import escape
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlmodel import Session, or_, select

from backend.services.app_settings import (
    get_activity_digest_schedule,
    get_activity_digest_email_enabled,
    get_interest_match_max_events_per_email,
)
from backend.config.loader import get_public_app_url
from backend.db.database import get_engine
from backend.db.models import CachedEvent, Notification, User
from backend.services.email import send_activity_digest_email
from backend.services.notification_delivery import record_delivery
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
    "interest_event",
)

# One-to-one map from notification kind → feature bucket. Every kind in
# ``ACTIVITY_KINDS`` must appear here so it is either delivered or
# explicitly dropped.
FEATURE_BY_KIND: dict[str, str] = {
    "subscription_going": "social_activity",
    "subscription_suggested": "social_activity",
    "new_follower": "social_activity",
    "new_friend": "social_activity",
    "follow_request": "social_activity",
    "follow_request_approved": "social_activity",
    "interest_event": "interest_matches",
}

# Per-(channel, feature) User attribute that must be True for delivery.
CHANNEL_FLAG: dict[tuple[str, str], str] = {
    ("email", "social_activity"): "email_social_activity_enabled",
    ("email", "interest_matches"): "email_interest_matches_enabled",
    ("push", "social_activity"): "push_social_activity_enabled",
    ("push", "interest_matches"): "push_interest_matches_enabled",
}

# Don't email notifications older than this window. With a twice-a-week
# cadence the maximum realistic gap is ~3.5 days; 14 days is a safe cap
# that handles longer schedules and one missed slot without dumping
# ancient rows after downtime.
_MAX_AGE = timedelta(days=14)

# Full weekday name → Python weekday int (Monday=0).
_WEEKDAY_MAP = {
    "mon": 0,
    "tue": 1,
    "wed": 2,
    "thu": 3,
    "fri": 4,
    "sat": 5,
    "sun": 6,
}
_DEFAULT_SCHEDULE = ({1, 4}, 9, 0)  # tue+fri @ 09:00 local


def _parse_schedule(spec: str) -> tuple[set[int], int, int]:
    """Return ``(weekdays, hour, minute)`` for a schedule spec string.

    Format: ``"tue,fri @ 09:00"`` — comma-separated 3-letter day tokens,
    then ``@``, then ``HH:MM`` (24h). Falls back to Tuesday+Friday 09:00
    on any parse error so a malformed admin value doesn't stall delivery.
    """
    try:
        days_part, time_part = [p.strip() for p in spec.split("@", 1)]
        weekdays = {
            _WEEKDAY_MAP[d.strip().lower()] for d in days_part.split(",") if d.strip()
        }
        if not weekdays:
            raise ValueError("empty weekdays")
        hour_s, minute_s = time_part.split(":", 1)
        hour = int(hour_s.strip())
        minute = int(minute_s.strip())
        if not (0 <= hour <= 23) or not (0 <= minute <= 59):
            raise ValueError("out-of-range time")
        return weekdays, hour, minute
    except (KeyError, ValueError, AttributeError):
        logger.warning(
            "Invalid activity_digest_schedule %r; falling back to default", spec
        )
        return _DEFAULT_SCHEDULE


def _user_local_tz(user: User) -> ZoneInfo:
    """Best-effort ``ZoneInfo`` for the user; UTC on unknown/missing name."""
    tz_name = (user.timezone or "UTC").strip() or "UTC"
    try:
        return ZoneInfo(tz_name)
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")


def _slot_status(
    user: User,
    now_utc: datetime,
    weekdays: set[int],
    hour: int,
    minute: int,
) -> str:
    """Return why ``user`` is or isn't in their digest slot right now.

    One of ``"in_slot"``, ``"wrong_weekday"``, ``"before_scheduled_time"``,
    ``"already_sent_today"``. Split out from ``_is_user_in_slot`` so callers
    that need to *explain* a skip (debug logs, the admin trigger CLI's
    diagnostic breakdown) don't have to re-derive the three gates by hand.
    """
    tz = _user_local_tz(user)
    now_local = now_utc.astimezone(tz)
    if now_local.weekday() not in weekdays:
        return "wrong_weekday"
    if (now_local.hour, now_local.minute) < (hour, minute):
        return "before_scheduled_time"
    last = user.last_digest_sent_at
    if last is not None:
        if last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)
        if last.astimezone(tz).date() == now_local.date():
            return "already_sent_today"
    return "in_slot"


def _is_user_in_slot(
    user: User,
    now_utc: datetime,
    weekdays: set[int],
    hour: int,
    minute: int,
) -> bool:
    """True when ``now`` is at or past today's scheduled slot in user TZ
    and we have not already sent within this local calendar day."""
    return _slot_status(user, now_utc, weekdays, hour, minute) == "in_slot"


def _render_line(
    kind: str,
    actor: User | None,
    event: CachedEvent | None,
    context: str | None = None,
) -> str:
    """Return an escaped HTML snippet describing one notification.

    Actor names and event titles are wrapped in ``<a>`` links pointing at
    the frontend profile (``/u/<handle>``) and event detail
    (``/event/<event_id>``) pages so recipients can click through directly
    from the email. Falls back to unlinked text when the actor has no
    handle or when no event row is joined.
    """
    app = get_public_app_url().rstrip("/")
    if actor is None:
        who_text = "Someone"
    else:
        who_text = escape(
            actor.display_name or (f"@{actor.handle}" if actor.handle else "Someone")
        )
    if actor is not None and actor.handle:
        who = (
            f'<a href="{app}/u/{escape(actor.handle)}" '
            f'style="color:#1d4ed8;text-decoration:underline">{who_text}</a>'
        )
    else:
        who = who_text
    if event and event.title:
        title_text = escape(event.title)
        if event.event_id:
            title = (
                f'<a href="{app}/event/{escape(str(event.event_id))}" '
                f'style="color:#1d4ed8;text-decoration:underline">{title_text}</a>'
            )
        else:
            title = title_text
    else:
        title = "an event"
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
    if kind == "interest_event":
        label = escape(context) if context else "your saved search"
        return f"{title} matched your <strong>{label}</strong> alert"
    return f"New activity from <strong>{who}</strong>"


def _render_plain(
    kind: str,
    actor: User | None,
    event: CachedEvent | None,
    context: str | None = None,
) -> str:
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
    if kind == "interest_event":
        label = context or "your saved search"
        return f"{title} matched your {label} alert"
    if kind == "event_reminder":
        # actor_user_id == recipient for this kind (no real actor, see
        # reminder_service.py), so "who" is meaningless here.
        return f"Reminder: {title} is coming up"
    return f"New activity from {who}"


def _push_tag_for(feature: str) -> str:
    return f"{feature.replace('_', '-')}-digest"


def run_once(
    force: bool = False,
    user_ids: set | None = None,
    kinds: tuple[str, ...] | None = None,
    max_notifications_per_user: int | None = None,
    resend: bool = False,
) -> dict:
    """Send pending activity digest emails and push notifications.

    Email and push are gated independently:
      - Email stays batched on the weekly per-user activity-digest
        schedule (``force=True`` bypasses that schedule window — used
        by the admin ``trigger-notifications`` CLI and "force send"
        endpoints so operators can flush queued digests on demand).
      - Push has no schedule: any notification not yet pushed is a
        candidate on every call (i.e. every dispatch tick), independent
        of ``force`` and of the email cadence. This keeps push feeling
        real-time instead of waiting for the (much slower) email
        schedule — see ``pushed_at`` on ``Notification``.

    ``user_ids`` restricts the pending-notification query to a specific
    set of recipients; ``kinds`` restricts it to a subset of
    ``ACTIVITY_KINDS`` (e.g. just ``("interest_event",)``). Both are used
    by the admin "force send" endpoints (send digest now / force interest
    match) to act on a hand-picked set of users without disturbing
    everyone else's pending backlog.

    ``max_notifications_per_user`` caps how many notifications per
    recipient are included in THIS run, applied independently per channel
    (the most recent N are kept for each of email/push). By default this
    cap only looks at PENDING rows (``emailed_at``/``pushed_at`` still
    ``None``) — older overflow rows are left unstamped/pending for a
    future run. Used by the admin "send now" control to bound the load
    of a single manual digest when a user has a large backlog, instead
    of a time-based lookback window.

    ``resend`` widens the candidate pool for the cap above from
    "pending only" to ALL matching activity (including notifications
    already emailed/pushed), and re-sends/re-stamps whichever rows the
    cap keeps. Used by the admin "send now" control's "Resend" checkbox
    to force a re-delivery of recent activity a user already received —
    e.g. after fixing an email template, or for a manual re-notify.
    """
    if not get_activity_digest_email_enabled():
        return {"skipped": "activity_email_disabled"}

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    now_utc = now.replace(tzinfo=timezone.utc)
    cutoff_old = now - _MAX_AGE
    weekdays, sched_hour, sched_minute = _parse_schedule(get_activity_digest_schedule())
    max_events_per_interest_email = get_interest_match_max_events_per_email()

    with Session(get_engine()) as session:
        stmt = (
            select(Notification)
            .where(Notification.kind.in_(kinds or ACTIVITY_KINDS))  # type: ignore[union-attr]
            .where(Notification.created_at >= cutoff_old)
            .order_by(Notification.recipient_user_id, Notification.created_at)
        )
        if not resend:
            stmt = stmt.where(
                or_(
                    Notification.emailed_at.is_(None),  # type: ignore[union-attr]
                    Notification.pushed_at.is_(None),  # type: ignore[union-attr]
                )
            )
        if user_ids is not None:
            stmt = stmt.where(Notification.recipient_user_id.in_(user_ids))  # type: ignore[union-attr]
        pending = session.exec(stmt).all()
        if not pending:
            logger.debug(
                "Activity digest run: no matching notifications (user_ids=%s kinds=%s resend=%s)",
                user_ids,
                kinds,
                resend,
            )
            return {"digests": 0, "pushed": 0}

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

        # Split into per-channel candidate lists (chronological order —
        # the query is already ordered this way). A row can be pending on
        # one channel and already handled on the other (e.g. pushed
        # immediately last tick, still waiting on the weekly email slot).
        skipped_off_schedule = 0
        skip_reason_counts: dict[str, int] = {}
        email_by_recipient: dict = {}
        push_by_recipient: dict = {}
        for n in pending:
            recipient = users.get(n.recipient_user_id)
            if not recipient or recipient.deleted_at is not None:
                continue
            if resend or n.emailed_at is None:
                in_slot = force
                if not force:
                    status = _slot_status(
                        recipient, now_utc, weekdays, sched_hour, sched_minute
                    )
                    in_slot = status == "in_slot"
                    if not in_slot:
                        skipped_off_schedule += 1
                        skip_reason_counts[status] = (
                            skip_reason_counts.get(status, 0) + 1
                        )
                        logger.debug(
                            "Activity digest: recipient=%s skipped (%s) tz=%s schedule=%r",
                            recipient.id,
                            status,
                            recipient.timezone,
                            get_activity_digest_schedule(),
                        )
                if in_slot:
                    email_by_recipient.setdefault(recipient.id, []).append(n)
            # Push has no schedule slot — any not-yet-pushed row (or ANY
            # row at all when ``resend=True``) is a candidate on every
            # call, regardless of ``force``.
            if resend or n.pushed_at is None:
                push_by_recipient.setdefault(recipient.id, []).append(n)

        # Cap the number of notifications included per recipient in THIS
        # run, independently per channel. Keep the most recent N (lists
        # are chronological, so this is a tail slice); the rest stay
        # unstamped and roll into a future run rather than being dropped.
        capped_recipient_ids: set = set()

        def _apply_cap(by_recipient: dict) -> list[Notification]:
            included: list[Notification] = []
            for recipient_id, notifs in by_recipient.items():
                if (
                    max_notifications_per_user is not None
                    and len(notifs) > max_notifications_per_user
                ):
                    capped_recipient_ids.add(recipient_id)
                    included.extend(notifs[-max_notifications_per_user:])
                else:
                    included.extend(notifs)
            return included

        included_for_email = _apply_cap(email_by_recipient)
        included_for_push = _apply_cap(push_by_recipient)

        email_groups: dict[tuple, list[Notification]] = {}
        push_groups: dict[tuple, list[Notification]] = {}
        email_recipients: set = set()
        push_recipients: set = set()
        for n in included_for_email:
            recipient = users[n.recipient_user_id]
            feature = FEATURE_BY_KIND.get(n.kind)
            if feature is None:
                continue
            email_recipients.add(recipient.id)
            if getattr(recipient, CHANNEL_FLAG[("email", feature)], True):
                email_groups.setdefault((recipient.id, feature), []).append(n)
        for n in included_for_push:
            recipient = users[n.recipient_user_id]
            feature = FEATURE_BY_KIND.get(n.kind)
            if feature is None:
                continue
            push_recipients.add(recipient.id)
            if getattr(recipient, CHANNEL_FLAG[("push", feature)], True):
                push_groups.setdefault((recipient.id, feature), []).append(n)

        digests = 0
        # Late import to avoid circular dependency with backend.api.routes.social.
        from backend.api.routes.social import get_people_suggestions_for_email

        for (recipient_id, feature), notifs in email_groups.items():
            recipient = users[recipient_id]
            discover_more_count = 0
            email_notifs = notifs
            if (
                feature == "interest_matches"
                and len(notifs) > max_events_per_interest_email
            ):
                discover_more_count = len(notifs) - max_events_per_interest_email
                email_notifs = notifs[:max_events_per_interest_email]
            lines = [
                _render_line(
                    n.kind,
                    users.get(n.actor_user_id),
                    events.get(n.event_id) if n.event_id else None,
                    n.context,
                )
                for n in email_notifs
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
            ok = send_activity_digest_email(
                recipient,
                lines,
                feature=feature,
                discover_more_count=discover_more_count,
                suggestions=suggestions,
            )
            digests += 1
            if ok:
                for n in notifs:
                    record_delivery(session, n.id, "email", now)

        pushed = 0
        for (recipient_id, feature), notifs in push_groups.items():
            first = _render_plain(
                notifs[0].kind,
                users.get(notifs[0].actor_user_id),
                events.get(notifs[0].event_id) if notifs[0].event_id else None,
                notifs[0].context,
            )
            extra = len(notifs) - 1
            body = first if extra <= 0 else f"{first} and {extra} more"
            title = "New match on Movida" if feature == "interest_matches" else "Movida"
            delivered = send_push(
                recipient_id,
                title=title,
                body=body,
                url="/notifications",
                tag=_push_tag_for(feature),
            )
            pushed += delivered
            if delivered:
                for n in notifs:
                    record_delivery(session, n.id, "push", now)

        # Stamp emailed_at on every notification considered for email this
        # run (whether emailed, or suppressed by the recipient's email
        # flag — either way the recipient was in-slot/forced and under
        # the cap, so the weekly slot is "spent" for this row). Stamp
        # pushed_at independently on every notification considered for
        # push this run — push has no slot to spend, so this just tracks
        # "already attempted" idempotency across ticks. Rows excluded by
        # the email schedule gate or a per-channel cap stay unstamped on
        # that channel and roll into a future run.
        stamped = 0
        for n in included_for_email:
            n.emailed_at = now
            stamped += 1
        for n in included_for_push:
            n.pushed_at = now
            stamped += 1
        for rid in email_recipients:
            user = users.get(rid)
            if user is not None:
                user.last_digest_sent_at = now
                session.add(user)
        session.commit()

    logger.info(
        "Activity digest run: %d emails, %d pushes, %d stamped, %d off-schedule "
        "(wrong_weekday=%d before_scheduled_time=%d already_sent_today=%d), %d recipient(s) capped",
        digests,
        pushed,
        stamped,
        skipped_off_schedule,
        skip_reason_counts.get("wrong_weekday", 0),
        skip_reason_counts.get("before_scheduled_time", 0),
        skip_reason_counts.get("already_sent_today", 0),
        len(capped_recipient_ids),
    )
    return {
        "digests": digests,
        "pushed": pushed,
        "stamped": stamped,
        "skipped_off_schedule": skipped_off_schedule,
        "skip_reasons": skip_reason_counts,
        "delivered_recipients": [
            str(rid) for rid in (email_recipients | push_recipients)
        ],
        "capped_recipients": len(capped_recipient_ids),
    }
