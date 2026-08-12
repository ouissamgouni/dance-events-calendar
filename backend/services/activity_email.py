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
    get_feature_email_instant,
    get_feature_email_digest,
    get_digest_v2_enabled,
    get_digest_per_kind_cap,
    get_digest_max_items,
)
from backend.config.loader import get_public_app_url
from backend.db.database import get_engine
from backend.db.models import (
    CachedEvent,
    Notification,
    User,
    UserEventAttendance,
)
from backend.services.email import (
    event_message_action_phrase,
    send_activity_digest_email,
    send_activity_digest_v2_email,
)
from backend.services.notification_delivery import record_delivery
from backend.services.push_service import send_push

logger = logging.getLogger(__name__)

# Kinds eligible for digest emails (subset of all notification kinds).
ACTIVITY_KINDS = (
    "subscription_going",
    "subscription_suggested",
    "subscription_review",
    "subscription_milestone",
    "new_follower",
    "new_friend",
    "follow_request",
    "follow_request_approved",
    "interest_event",
    "milestone_unlocked",
    "event_message",
    "event_message_reply",
)

# One-to-one map from notification kind → feature bucket. Every kind in
# ``ACTIVITY_KINDS`` must appear here so it is either delivered or
# explicitly dropped.
FEATURE_BY_KIND: dict[str, str] = {
    "subscription_going": "friends_going",
    "subscription_suggested": "suggested_events",
    "subscription_review": "friend_reviews",
    "subscription_milestone": "friend_milestones",
    "new_follower": "social_activity",
    "new_friend": "social_activity",
    "follow_request": "social_activity",
    "follow_request_approved": "social_activity",
    "interest_event": "interest_matches",
    "milestone_unlocked": "milestone_unlocked",
    "event_message": "event_messages",
    "event_message_reply": "event_messages",
}

# Per-(channel, feature) User attribute that must be True for delivery.
CHANNEL_FLAG: dict[tuple[str, str], str] = {
    ("email", "social_activity"): "email_social_activity_enabled",
    ("email", "friends_going"): "email_friends_going_enabled",
    ("email", "friend_reviews"): "email_friend_reviews_enabled",
    ("email", "friend_milestones"): "email_friend_milestones_enabled",
    ("email", "interest_matches"): "email_interest_matches_enabled",
    ("email", "milestone_unlocked"): "email_milestone_unlocked_enabled",
    ("email", "event_messages"): "email_event_messages_enabled",
    ("email", "suggested_events"): "email_suggested_events_enabled",
    ("push", "social_activity"): "push_social_activity_enabled",
    ("push", "friends_going"): "push_friends_going_enabled",
    ("push", "friend_reviews"): "push_friend_reviews_enabled",
    ("push", "friend_milestones"): "push_friend_milestones_enabled",
    ("push", "interest_matches"): "push_interest_matches_enabled",
    ("push", "milestone_unlocked"): "push_milestone_unlocked_enabled",
    ("push", "event_messages"): "push_event_messages_enabled",
    ("push", "suggested_events"): "push_suggested_events_enabled",
}

# Features whose instant email + push are owned by a dedicated service
# (milestone_notification_service sends the rich immediate milestone email
# and all milestone push). activity_email only provides their DIGEST email,
# so it must skip these in the instant-email and push paths to avoid
# double-sending.
_DIGEST_ONLY_FEATURES = frozenset({"milestone_unlocked"})

# Kinds whose event is inherently in the past (reviews) are exempt from the
# digest past-event guard, mirroring ``skip_past_guard`` in notifications.py.
# Event-less kinds (milestones, follows) are exempt automatically since they
# resolve to no event.
_PAST_GUARD_EXEMPT_KINDS = frozenset({"subscription_review"})

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


def _message_action(kind: str, category: str | None) -> str:
    """Verb phrase for an event-message notification line.

    ``category`` (stored in the notification ``context``) shapes the copy for
    top-level posts; replies use a fixed phrase. Delegates to the shared
    builder in ``services.email`` so the digest line and the instant email
    subject stay in sync.
    """
    return event_message_action_phrase(kind, category)


def _render_line(
    kind: str,
    actor: User | None,
    event: CachedEvent | None,
    context: str | None = None,
    also_going: bool = False,
    subject_key: str | None = None,
    description: str | None = None,
) -> str:
    """Return an escaped HTML snippet describing one notification.

    Actor names and event titles are wrapped in ``<a>`` links pointing at
    the frontend profile (``/u/<handle>``) and event detail
    (``/event/<event_id>``) pages so recipients can click through directly
    from the email. Falls back to unlinked text when the actor has no
    handle or when no event row is joined.
    """
    app = get_public_app_url().rstrip("/")
    # Anonymous reviews still fan out to followers but the reviewer's
    # identity is masked to "Someone" (never linked).
    anon = kind == "subscription_review" and context == "anon"
    if actor is None or anon:
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
    if anon:
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
        if also_going:
            return f"You and <strong>{who}</strong> are going to {title}"
        return f"<strong>{who}</strong> is going to {title}"
    if kind == "subscription_review":
        return f"<strong>{who}</strong> shared their experience of {title}"
    if kind == "subscription_milestone":
        if context:
            return (
                f"<strong>{who}</strong> reached a milestone: "
                f"<strong>{escape(context)}</strong>"
            )
        return f"<strong>{who}</strong> reached a new milestone"
    if kind == "subscription_suggested":
        return f"<strong>{who}</strong> suggested the event {title}"
    if kind == "milestone_unlocked":
        name_text = escape(context) if context else "a new achievement"
        name = (
            f'<a href="{app}/mine/passport" '
            f'style="color:#1d4ed8;text-decoration:underline">'
            f"<strong>{name_text}</strong></a>"
        )
        if description:
            return f"\U0001f389 You unlocked {name} \u2014 {escape(description)}"
        return f"\U0001f389 You unlocked {name}"
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
    if kind in ("event_message", "event_message_reply"):
        action = _message_action(kind, context)
        line = f"<strong>{who}</strong> {action} {title}"
        if description:
            line += f": “{escape(description)}”"
        return line
    return f"New activity from <strong>{who}</strong>"


def _render_plain(
    kind: str,
    actor: User | None,
    event: CachedEvent | None,
    context: str | None = None,
    also_going: bool = False,
    subject_key: str | None = None,
    description: str | None = None,
) -> str:
    """Return a plain-text snippet describing one notification (for push)."""
    anon = kind == "subscription_review" and context == "anon"
    who = (
        actor.display_name or (f"@{actor.handle}" if actor.handle else "Someone")
        if actor is not None and not anon
        else "Someone"
    )
    title = event.title if event and event.title else "an event"
    if kind == "subscription_going":
        if also_going:
            return f"You and {who} are going to {title}"
        return f"{who} is going to {title}"
    if kind == "subscription_review":
        return f"{who} shared their experience of {title}"
    if kind == "subscription_milestone":
        if context:
            return f"{who} reached a milestone: {context}"
        return f"{who} reached a new milestone"
    if kind == "subscription_suggested":
        return f"{who} suggested the event {title}"
    if kind == "milestone_unlocked":
        name = context or "a new achievement"
        return (
            f"You unlocked {name}"
            if not description
            else f"You unlocked {name} \u2014 {description}"
        )
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
    if kind in ("event_message", "event_message_reply"):
        action = _message_action(kind, context)
        line = f"{who} {action} {title}"
        if description:
            line += f": “{description}”"
        return line
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
        # Per-feature admin routing: which email vehicle(s) each activity
        # feature uses. Computed once per run (not per row).
        feat_instant: dict[str, bool] = {}
        feat_digest: dict[str, bool] = {}
        for feature in set(FEATURE_BY_KIND.values()):
            feat_instant[feature] = get_feature_email_instant(feature, session)
            feat_digest[feature] = get_feature_email_digest(feature, session)
        any_instant = any(feat_instant.values())

        stmt = (
            select(Notification)
            .where(Notification.kind.in_(kinds or ACTIVITY_KINDS))  # type: ignore[union-attr]
            .where(Notification.created_at >= cutoff_old)
            .order_by(Notification.recipient_user_id, Notification.created_at)
        )
        if not resend:
            pending_clauses = [
                Notification.emailed_at.is_(None),  # type: ignore[union-attr]
                Notification.pushed_at.is_(None),  # type: ignore[union-attr]
            ]
            # Only widen the candidate pool to un-instant-emailed rows when
            # at least one feature is actually in instant mode; otherwise
            # already-digested rows would re-select on every tick forever.
            if any_instant:
                pending_clauses.append(
                    Notification.instant_emailed_at.is_(None)  # type: ignore[union-attr]
                )
            stmt = stmt.where(or_(*pending_clauses))
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

        # Past-event guard: resolve which loaded events have already ended so
        # digest email + push grouping can drop notifications about them before
        # rendering (and before the interest discover_more math). Reuses the
        # canonical ``_event_is_past`` definition. Late import mirrors the
        # social-suggestions import below to avoid a circular dependency.
        from backend.services.notifications import _event_is_past

        past_event_ids = {eid for eid in events if _event_is_past(session, eid)}

        def _skip_past(n: Notification) -> bool:
            return (
                n.kind not in _PAST_GUARD_EXEMPT_KINDS
                and n.event_id is not None
                and n.event_id in past_event_ids
            )

        # Recipient co-attendance for "You and X are going to ..." — bulk
        # load which (recipient, event) pairs the recipient is also going
        # to, but only for subscription_going rows.
        going_event_ids = {
            n.event_id for n in pending if n.kind == "subscription_going" and n.event_id
        }
        also_going_pairs: set[tuple] = set()
        if going_event_ids:
            for row in session.exec(
                select(UserEventAttendance.user_id, UserEventAttendance.event_id)
                .where(UserEventAttendance.user_id.in_(recipient_ids))  # type: ignore[union-attr]
                .where(UserEventAttendance.event_id.in_(going_event_ids))  # type: ignore[union-attr]
            ).all():
                also_going_pairs.add((row[0], row[1]))

        def _also_going(n: Notification) -> bool:
            return (
                n.kind == "subscription_going"
                and (n.recipient_user_id, n.event_id) in also_going_pairs
            )

        # the query is already ordered this way). A row can be pending on
        # one channel and already handled on the other (e.g. pushed
        # immediately last tick, still waiting on the weekly email slot).
        skipped_off_schedule = 0
        skip_reason_counts: dict[str, int] = {}
        email_by_recipient: dict = {}
        instant_by_recipient: dict = {}
        push_by_recipient: dict = {}
        for n in pending:
            recipient = users.get(n.recipient_user_id)
            if not recipient or recipient.deleted_at is not None:
                continue
            feature = FEATURE_BY_KIND.get(n.kind)
            # Instant email path: no schedule slot, gated only by the
            # admin per-feature instant toggle (default off) and the
            # ``instant_emailed_at`` idempotency stamp.
            if (
                feature is not None
                and feature not in _DIGEST_ONLY_FEATURES
                and feat_instant.get(feature)
                and (resend or n.instant_emailed_at is None)
            ):
                instant_by_recipient.setdefault(recipient.id, []).append(n)
            # Digest path: skipped entirely when this feature has instant email
            # enabled, so a feature configured for BOTH never emails the same
            # notification twice (instant wins). Digest-only features and
            # instant-disabled features still flow through here.
            instant_owned = (
                feature is not None
                and feature not in _DIGEST_ONLY_FEATURES
                and bool(feat_instant.get(feature))
            )
            if (
                (resend or n.emailed_at is None)
                and feature is not None
                and feat_digest.get(feature, True)
                and not instant_owned
            ):
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
            # call, regardless of ``force``. Digest-only features are
            # skipped: their push is owned by a dedicated service.
            if (resend or n.pushed_at is None) and feature not in _DIGEST_ONLY_FEATURES:
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
        included_for_instant = _apply_cap(instant_by_recipient)
        included_for_push = _apply_cap(push_by_recipient)

        def _group_email(included: list[Notification]) -> tuple[dict, set]:
            groups: dict[tuple, list[Notification]] = {}
            seen: set = set()
            for n in included:
                recipient = users[n.recipient_user_id]
                feature = FEATURE_BY_KIND.get(n.kind)
                if feature is None:
                    continue
                seen.add(recipient.id)
                if getattr(recipient, CHANNEL_FLAG[("email", feature)], True):
                    groups.setdefault((recipient.id, feature), []).append(n)
            return groups, seen

        email_groups, email_recipients = _group_email(included_for_email)
        instant_groups, _instant_recipients = _group_email(included_for_instant)
        push_groups: dict[tuple, list[Notification]] = {}
        push_recipients: set = set()
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

        digest_v2 = get_digest_v2_enabled(session)
        digest_per_kind_cap = get_digest_per_kind_cap(session)
        digest_max_items = get_digest_max_items(session)

        def _card_subline(event: CachedEvent | None) -> str | None:
            if event is None:
                return None
            bits: list[str] = []
            if event.start is not None:
                bits.append(event.start.strftime("%b %-d"))
            if event.city:
                bits.append(event.city)
            elif event.location:
                bits.append(event.location)
            return " · ".join(bits) if bits else None

        def _build_entry(n: Notification) -> dict:
            actor = users.get(n.actor_user_id)
            event = events.get(n.event_id) if n.event_id else None
            anon = n.kind == "subscription_review" and n.context == "anon"
            return {
                "kind": n.kind,
                "primary_html": _render_line(
                    n.kind,
                    actor,
                    event,
                    n.context,
                    also_going=_also_going(n),
                    subject_key=n.subject_key,
                    description=n.description,
                ),
                "avatar_url": (
                    actor.avatar_url if actor is not None and not anon else None
                ),
                "initial": (
                    (actor.display_name or actor.handle or "?")
                    if actor is not None and not anon
                    else None
                ),
                "subline": _card_subline(event),
                "anon": anon,
                "created_at": n.created_at,
            }

        def _send_combined_digests(groups: dict) -> int:
            """Combined v2 digest: one card email per recipient.

            ``groups`` is keyed by ``(recipient_id, feature)`` and already
            gated per feature (digest flag, in-app channel flag, schedule).
            Recipients with the master ``digest_email_enabled`` opt-out off
            are skipped (their rows are still stamped outside so they are
            consumed, not re-queued).
            """
            by_recipient: dict[str, dict[str, list[Notification]]] = {}
            for (recipient_id, feature), notifs in groups.items():
                by_recipient.setdefault(recipient_id, {}).setdefault(
                    feature, []
                ).extend(notifs)
            sent = 0
            for recipient_id, per_feature in by_recipient.items():
                recipient = users[recipient_id]
                if not getattr(recipient, "digest_email_enabled", True):
                    continue
                sections: list[dict] = []
                delivered_ids: list = []
                for feature, notifs in per_feature.items():
                    visible = [n for n in notifs if not _skip_past(n)]
                    if not visible:
                        continue
                    sections.append(
                        {
                            "feature": feature,
                            "entries": [_build_entry(n) for n in visible],
                        }
                    )
                    delivered_ids.extend(n.id for n in visible)
                if not sections:
                    continue
                suggestions = None
                if "social_activity" in per_feature:
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
                ok = send_activity_digest_v2_email(
                    recipient,
                    sections,
                    per_kind_cap=digest_per_kind_cap,
                    max_items=digest_max_items,
                    suggestions=suggestions,
                )
                sent += 1
                if ok:
                    for nid in delivered_ids:
                        record_delivery(session, nid, "email", now)
            return sent

        def _send_email_groups(groups: dict) -> int:
            sent = 0
            for (recipient_id, feature), notifs in groups.items():
                recipient = users[recipient_id]
                visible = [n for n in notifs if not _skip_past(n)]
                if not visible:
                    continue
                discover_more_count = 0
                email_notifs = visible
                if (
                    feature == "interest_matches"
                    and len(visible) > max_events_per_interest_email
                ):
                    discover_more_count = len(visible) - max_events_per_interest_email
                    email_notifs = visible[:max_events_per_interest_email]
                lines = [
                    _render_line(
                        n.kind,
                        users.get(n.actor_user_id),
                        events.get(n.event_id) if n.event_id else None,
                        n.context,
                        also_going=_also_going(n),
                        subject_key=n.subject_key,
                        description=n.description,
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
                sent += 1
                if ok:
                    for n in visible:
                        record_delivery(session, n.id, "email", now)
            return sent

        digests = (
            _send_combined_digests(email_groups)
            if digest_v2
            else _send_email_groups(email_groups)
        )
        instant_emails = _send_email_groups(instant_groups)

        pushed = 0
        for (recipient_id, feature), notifs in push_groups.items():
            visible = [n for n in notifs if not _skip_past(n)]
            if not visible:
                continue
            first = _render_plain(
                visible[0].kind,
                users.get(visible[0].actor_user_id),
                events.get(visible[0].event_id) if visible[0].event_id else None,
                visible[0].context,
                also_going=_also_going(visible[0]),
            )
            extra = len(visible) - 1
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
                for n in visible:
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
        for n in included_for_instant:
            n.instant_emailed_at = now
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
        "instant_emails": instant_emails,
        "pushed": pushed,
        "stamped": stamped,
        "skipped_off_schedule": skipped_off_schedule,
        "skip_reasons": skip_reason_counts,
        "delivered_recipients": [
            str(rid) for rid in (email_recipients | push_recipients)
        ],
        "capped_recipients": len(capped_recipient_ids),
    }
