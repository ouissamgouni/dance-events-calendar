"""Ticket and memories nudges for events the user is Going to.

``event_ticket_prompt``: ~24h after marking Going to a ticket-likely event
that is still more than ``ticket_prompt_min_lead_hours`` away (closer events
get a ticket line in the 24h reminder instead).

``event_memories_prompt``: the morning after the event (user-local
``memories_prompt_local_hour``) when the user has not added a memory yet.

Both use ``actor_user_id = recipient`` so the notification unique constraint
keeps one row per user/event; email/push are stamped independently so a
channel switched on later is caught up on the next tick (same as
``review_prompt_service``).
"""

from __future__ import annotations

import logging
from datetime import datetime, time, timedelta, timezone
from typing import Callable, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlmodel import Session, col, select, update

from backend.db.database import get_engine
from backend.db.models import (
    CachedEvent,
    EventUserAsset,
    Notification,
    PushSubscription,
    User,
    UserEventAttendance,
)
from backend.services import event_assets
from backend.services.app_settings import (
    get_feature_email_instant,
    get_feature_push_enabled,
)
from backend.services.email import (
    send_event_memories_prompt_email,
    send_event_ticket_prompt_email,
)
from backend.services.event_visibility import apply_event_visibility
from backend.services.notification_delivery import record_delivery, tracked_url
from backend.services.push_service import send_push

logger = logging.getLogger(__name__)

EVENT_TICKET_PROMPT = "event_ticket_prompt"
EVENT_MEMORIES_PROMPT = "event_memories_prompt"
_FEATURE_BY_KIND = {
    EVENT_TICKET_PROMPT: "ticket_prompt",
    EVENT_MEMORIES_PROMPT: "memories_prompt",
}

TICKET_LOOKBACK_HOURS = 72
MEMORIES_MIN_HOURS_AFTER_END = 6
MEMORIES_LOOKBACK_HOURS = 72

Due = list[tuple[User, CachedEvent, Optional[Notification]]]


def _naive_utc(value: datetime) -> datetime:
    return (
        value.astimezone(timezone.utc).replace(tzinfo=None) if value.tzinfo else value
    )


def _user_tz(user: User) -> ZoneInfo:
    try:
        return ZoneInfo(user.timezone or "UTC")
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")


def ticket_prompt_push_copy(event_title: Optional[str]) -> tuple[str, str]:
    return (
        "Got your ticket? Keep it handy here",
        f"Keep your ticket for {event_title or 'the event'} one tap away at the door.",
    )


def memories_prompt_push_copy(event_title: Optional[str]) -> tuple[str, str]:
    return (
        "Relive the moment",
        f"Share your best shots from {event_title or 'the event'} and keep the memories alive.",
    )


def memories_prompt_due_at(
    event_end: datetime, user: User, local_hour: int
) -> datetime:
    """``local_hour`` on the day after the event ended, in the user's timezone."""
    tz = _user_tz(user)
    end = event_end if event_end.tzinfo else event_end.replace(tzinfo=timezone.utc)
    next_day = end.astimezone(tz).date() + timedelta(days=1)
    return datetime.combine(next_day, time(hour=local_hour), tzinfo=tz)


def _asset_pairs(session: Session, user_ids, event_ids, kinds) -> set[tuple]:
    return set(
        session.exec(
            select(EventUserAsset.user_id, EventUserAsset.event_id)
            .where(col(EventUserAsset.user_id).in_(user_ids))
            .where(col(EventUserAsset.event_id).in_(event_ids))
            .where(col(EventUserAsset.kind).in_(kinds))
        ).all()
    )


def _with_existing(
    session: Session,
    kind: str,
    pairs: list[tuple[User, CachedEvent]],
    email_flag: str,
    push_flag: str,
) -> Due:
    """Attach existing notification rows; drop pairs with nothing left to send."""
    if not pairs:
        return []
    feature = _FEATURE_BY_KIND[kind]
    email_on = get_feature_email_instant(feature, session)
    push_on = get_feature_push_enabled(feature, session)
    existing = {
        (n.recipient_user_id, n.event_id): n
        for n in session.exec(
            select(Notification)
            .where(Notification.kind == kind)
            .where(col(Notification.recipient_user_id).in_({u.id for u, _ in pairs}))
            .where(col(Notification.event_id).in_({e.event_id for _, e in pairs}))
        ).all()
    }
    due: Due = []
    for user, event in pairs:
        notif = existing.get((user.id, event.event_id))
        if notif is None:
            due.append((user, event, None))
        elif (email_on and getattr(user, email_flag) and notif.emailed_at is None) or (
            push_on and getattr(user, push_flag) and notif.pushed_at is None
        ):
            due.append((user, event, notif))
    return due


def _going_pairs(session: Session, statement) -> list[tuple[User, CachedEvent]]:
    statement = (
        statement.where(col(UserEventAttendance.user_id).is_not(None))
        .where(col(User.deleted_at).is_(None))
        .where(col(CachedEvent.deleted_at).is_(None))
        .where(CachedEvent.is_hidden == False)  # noqa: E712
    )
    return [
        (u, e)
        for u, e in session.exec(apply_event_visibility(statement, session)).all()
    ]


def ticket_due(session: Session, now: datetime) -> Due:
    delay = event_assets.int_setting(session, "ticket_prompt_delay_hours")
    lead = event_assets.int_setting(session, "ticket_prompt_min_lead_hours")
    min_hours = event_assets.ticket_min_hours(session)
    since_end = _naive_utc(now - timedelta(hours=delay))
    statement = (
        select(User, CachedEvent)
        .join(UserEventAttendance, UserEventAttendance.user_id == User.id)
        .join(CachedEvent, CachedEvent.event_id == UserEventAttendance.event_id)
        .where(col(UserEventAttendance.created_by_admin_user_id).is_(None))
        .where(col(UserEventAttendance.ticket_not_needed_at).is_(None))
        .where(UserEventAttendance.attending_since <= since_end)
        .where(
            UserEventAttendance.attending_since
            > since_end - timedelta(hours=TICKET_LOOKBACK_HOURS)
        )
        .where(CachedEvent.start > _naive_utc(now + timedelta(hours=lead)))
    )
    pairs = [
        (u, e)
        for u, e in _going_pairs(session, statement)
        if event_assets.ticket_likely(e, min_hours)[0]
    ]
    if not pairs:
        return []
    has_ticket = _asset_pairs(
        session,
        {u.id for u, _ in pairs},
        {e.event_id for _, e in pairs},
        event_assets.TICKET_KINDS,
    )
    pairs = [(u, e) for u, e in pairs if (u.id, e.event_id) not in has_ticket]
    return _with_existing(
        session,
        EVENT_TICKET_PROMPT,
        pairs,
        "email_ticket_prompt_enabled",
        "push_ticket_prompt_enabled",
    )


def memories_due(session: Session, now: datetime) -> Due:
    local_hour = event_assets.int_setting(session, "memories_prompt_local_hour")
    statement = (
        select(User, CachedEvent)
        .join(UserEventAttendance, UserEventAttendance.user_id == User.id)
        .join(CachedEvent, CachedEvent.event_id == UserEventAttendance.event_id)
        .where(
            CachedEvent.end
            <= _naive_utc(now - timedelta(hours=MEMORIES_MIN_HOURS_AFTER_END))
        )
        .where(
            CachedEvent.end > _naive_utc(now - timedelta(hours=MEMORIES_LOOKBACK_HOURS))
        )
    )
    pairs = [
        (u, e)
        for u, e in _going_pairs(session, statement)
        if now >= memories_prompt_due_at(e.end, u, local_hour)
        and event_assets.can_add_memory_now(session, e, now)
    ]
    if not pairs:
        return []
    has_memory = _asset_pairs(
        session,
        {u.id for u, _ in pairs},
        {e.event_id for _, e in pairs},
        (event_assets.KIND_MEMORY,),
    )
    pairs = [(u, e) for u, e in pairs if (u.id, e.event_id) not in has_memory]
    return _with_existing(
        session,
        EVENT_MEMORIES_PROMPT,
        pairs,
        "email_memories_prompt_enabled",
        "push_memories_prompt_enabled",
    )


def _deliver(
    kind: str,
    find_due: Callable[[Session, datetime], Due],
    *,
    email_flag: str,
    push_flag: str,
    send_email: Callable[..., bool],
    push_copy: Callable[[Optional[str]], tuple[str, str]],
    path: str,
    tag: str,
) -> dict:
    now = datetime.now(timezone.utc)
    to_email: list[tuple[User, CachedEvent, int]] = []
    to_push: list[tuple[User, CachedEvent, int]] = []
    created = 0
    with Session(get_engine(), expire_on_commit=False) as session:
        due = find_due(session, now)
        if not due:
            return {"prompts": 0}
        email_on = get_feature_email_instant(_FEATURE_BY_KIND[kind], session)
        push_on = get_feature_push_enabled(_FEATURE_BY_KIND[kind], session)
        for user, event, existing in due:
            if existing is None:
                notif = Notification(
                    recipient_user_id=user.id,
                    actor_user_id=user.id,
                    kind=kind,
                    event_id=event.event_id,
                )
                session.add(notif)
                session.flush()
                record_delivery(session, notif.id, "app")
                created += 1
            else:
                notif = existing
            if email_on and getattr(user, email_flag) and notif.emailed_at is None:
                to_email.append((user, event, notif.id))
            if push_on and getattr(user, push_flag) and notif.pushed_at is None:
                to_push.append((user, event, notif.id))
        session.commit()

    emailed_ids = [
        nid
        for user, event, nid in to_email
        if send_email(user, event, notification_id=nid)
    ]
    pushed_ids = []
    for user, event, nid in to_push:
        title, body = push_copy(event.title)
        if send_push(
            user.id,
            title=title,
            body=body,
            url=tracked_url(f"/event/{event.event_id}/{path}", nid, "push"),
            tag=f"{tag}:{event.event_id}",
        ):
            pushed_ids.append(nid)

    if emailed_ids or pushed_ids:
        with Session(get_engine()) as session:
            stamp = datetime.now(timezone.utc)
            for ids, column, channel in (
                (emailed_ids, "emailed_at", "email"),
                (pushed_ids, "pushed_at", "push"),
            ):
                if not ids:
                    continue
                session.exec(
                    update(Notification)
                    .where(col(Notification.id).in_(ids))
                    .values({column: stamp})
                )
                for nid in ids:
                    record_delivery(session, nid, channel, stamp)
            session.commit()

    logger.info(
        "%s run: %d created, %d emailed, %d pushed",
        kind,
        created,
        len(emailed_ids),
        len(pushed_ids),
    )
    return {"prompts": created, "emailed": len(emailed_ids), "pushed": len(pushed_ids)}


def _gate(setting: str, feature_enabled: Callable[[Session], bool]) -> Optional[dict]:
    with Session(get_engine()) as session:
        if not feature_enabled(session):
            return {"skipped": "feature_disabled"}
        if not event_assets.bool_setting(session, setting):
            return {"skipped": f"{setting.removesuffix('_enabled')}_disabled"}
    return None


def _specs() -> dict[str, dict]:
    # Built per call so tests can monkeypatch the module-level senders.
    return {
        "ticket": {
            "kind": EVENT_TICKET_PROMPT,
            "email_flag": "email_ticket_prompt_enabled",
            "push_flag": "push_ticket_prompt_enabled",
            "send_email": send_event_ticket_prompt_email,
            "push_copy": ticket_prompt_push_copy,
            "path": "ticket",
            "tag": "ticket-prompt",
        },
        "memories": {
            "kind": EVENT_MEMORIES_PROMPT,
            "email_flag": "email_memories_prompt_enabled",
            "push_flag": "push_memories_prompt_enabled",
            "send_email": send_event_memories_prompt_email,
            "push_copy": memories_prompt_push_copy,
            "path": "memories",
            "tag": "memories-prompt",
        },
    }


PROMPT_KINDS = ("ticket", "memories")


def run_ticket_prompts() -> dict:
    return _gate("ticket_prompt_enabled", event_assets.tickets_enabled) or _deliver(
        find_due=ticket_due, **_specs()["ticket"]
    )


def run_memories_prompts() -> dict:
    return _gate("memories_prompt_enabled", event_assets.memories_enabled) or _deliver(
        find_due=memories_due, **_specs()["memories"]
    )


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def force_ineligible_reason(
    session: Session, prompt: str, event: CachedEvent, now: datetime
) -> Optional[str]:
    """Event-level reason an admin send-now is refused, or None."""
    if prompt == "ticket":
        return None if _aware(event.start) > now else "not_upcoming"
    if _aware(event.end) > now:
        return "not_ended"
    if not event_assets.can_add_memory_now(session, event, now):
        return "window_closed"
    return None


def force_candidates(session: Session, prompt: str, event: CachedEvent) -> list[dict]:
    """Going users of ``event`` with their prompt row, blocker and push device."""
    spec = _specs()[prompt]
    rows = session.exec(
        select(User, UserEventAttendance)
        .join(UserEventAttendance, UserEventAttendance.user_id == User.id)
        .where(UserEventAttendance.event_id == event.event_id)
        .where(col(User.deleted_at).is_(None))
    ).all()
    if not rows:
        return []
    user_ids = {u.id for u, _ in rows}
    notifs = {
        n.recipient_user_id: n
        for n in session.exec(
            select(Notification)
            .where(Notification.kind == spec["kind"])
            .where(Notification.event_id == event.event_id)
            .where(Notification.actor_user_id == Notification.recipient_user_id)
            .where(col(Notification.recipient_user_id).in_(user_ids))
        ).all()
    }
    asset_kinds = (
        event_assets.TICKET_KINDS if prompt == "ticket" else (event_assets.KIND_MEMORY,)
    )
    has_asset = {
        uid for uid, _ in _asset_pairs(session, user_ids, {event.event_id}, asset_kinds)
    }
    with_push = set(
        session.exec(
            select(PushSubscription.user_id)
            .where(col(PushSubscription.user_id).in_(user_ids))
            .distinct()
        ).all()
    )
    out = []
    for user, attendance in rows:
        if user.id in has_asset:
            blocker = "has_ticket" if prompt == "ticket" else "has_memory"
        elif prompt == "ticket" and attendance.ticket_not_needed_at is not None:
            blocker = "ticket_not_needed"
        else:
            blocker = None
        out.append(
            {
                "user": user,
                "notification": notifs.get(user.id),
                "blocker": blocker,
                "email_enabled": bool(getattr(user, spec["email_flag"])),
                "push_enabled": bool(getattr(user, spec["push_flag"])),
                "has_push_subscription": user.id in with_push,
                "curator_marked": attendance.created_by_admin_user_id is not None,
            }
        )
    return out


_BLOCKER_STATUS = {
    "has_ticket": "skipped_has_ticket",
    "ticket_not_needed": "skipped_not_needed",
    "has_memory": "skipped_has_memory",
}


def force_send(
    session: Session,
    prompt: str,
    event: CachedEvent,
    user_ids: list,
    channels: set[str],
    resend: bool,
    now: datetime,
) -> dict:
    """Admin send-now: bypasses timing, site toggles and the ticket-likely rule.

    User opt-outs and blockers (ticket/memory already added, ticket dismissed)
    still apply. Caller commits.
    """
    spec = _specs()[prompt]
    candidates = {c["user"].id: c for c in force_candidates(session, prompt, event)}
    known = {
        u.id: u
        for u in session.exec(select(User).where(col(User.id).in_(user_ids))).all()
    }
    stats = {"in_app_created": 0, "in_app_resurfaced": 0, "emailed": 0, "pushed": 0}
    results: list[dict] = []
    for uid in user_ids:
        user = known.get(uid)
        if user is None or user.deleted_at is not None:
            results.append({"user_id": uid, "email": "", "status": "skipped_not_found"})
            continue
        cand = candidates.get(uid)
        if cand is None:
            status = "skipped_not_attended"
        elif cand["blocker"]:
            status = _BLOCKER_STATUS[cand["blocker"]]
        else:
            status = _force_send_one(
                session, spec, event, cand, channels, resend, now, stats
            )
        results.append({"user_id": uid, "email": user.email, "status": status})
    return {**stats, "results": results}


def _force_send_one(session, spec, event, cand, channels, resend, now, stats) -> str:
    user = cand["user"]
    notif = cand["notification"]
    sent = False
    if notif is None:
        notif = Notification(
            recipient_user_id=user.id,
            actor_user_id=user.id,
            kind=spec["kind"],
            event_id=event.event_id,
            # Row still anchors dedupe + email/push tracking when in-app is off.
            read_at=None if "app" in channels else now,
        )
        session.add(notif)
        session.flush()
        if "app" in channels:
            record_delivery(session, notif.id, "app", now, source="admin")
            stats["in_app_created"] += 1
            sent = True
    elif "app" in channels and resend:
        notif.read_at = None
        notif.created_at = now
        record_delivery(session, notif.id, "app", now, source="admin")
        stats["in_app_resurfaced"] += 1
        sent = True

    email_wanted = "email" in channels and (resend or notif.emailed_at is None)
    push_wanted = "push" in channels and (resend or notif.pushed_at is None)
    if email_wanted and cand["email_enabled"]:
        if spec["send_email"](user, event, notification_id=notif.id):
            notif.emailed_at = now
            record_delivery(session, notif.id, "email", now, source="admin")
            stats["emailed"] += 1
            sent = True
    if push_wanted and cand["push_enabled"]:
        title, body = spec["push_copy"](event.title)
        delivered = send_push(
            user.id,
            title=title,
            body=body,
            url=tracked_url(
                f"/event/{event.event_id}/{spec['path']}", notif.id, "push"
            ),
            tag=f"{spec['tag']}:{event.event_id}",
        )
        if delivered:
            notif.pushed_at = now
            record_delivery(session, notif.id, "push", now, source="admin")
            stats["pushed"] += delivered
            sent = True
    session.add(notif)
    if sent:
        return "sent"
    reachable = ("email" in channels and cand["email_enabled"]) or (
        "push" in channels and cand["push_enabled"]
    )
    if "app" not in channels and not reachable:
        return "skipped_disabled"
    return "already_sent"


def ticket_cta_pairs(
    session: Session, pairs: list[tuple[User, CachedEvent]]
) -> set[tuple]:
    """(user_id, event_id) pairs whose reminder should carry the ticket line."""
    if not pairs or not event_assets.tickets_enabled(session):
        return set()
    if not event_assets.bool_setting(session, "ticket_prompt_enabled"):
        return set()
    min_hours = event_assets.ticket_min_hours(session)
    likely = [(u, e) for u, e in pairs if event_assets.ticket_likely(e, min_hours)[0]]
    if not likely:
        return set()
    user_ids = {u.id for u, _ in likely}
    event_ids = {e.event_id for _, e in likely}
    has_ticket = _asset_pairs(session, user_ids, event_ids, event_assets.TICKET_KINDS)
    dismissed = set(
        session.exec(
            select(UserEventAttendance.user_id, UserEventAttendance.event_id)
            .where(col(UserEventAttendance.user_id).in_(user_ids))
            .where(col(UserEventAttendance.event_id).in_(event_ids))
            .where(col(UserEventAttendance.ticket_not_needed_at).is_not(None))
        ).all()
    )
    return {
        (u.id, e.event_id)
        for u, e in likely
        if (u.id, e.event_id) not in has_ticket and (u.id, e.event_id) not in dismissed
    }
