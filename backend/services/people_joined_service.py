"""'Someone you may know joined': notify people sharing connections with a new member."""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Optional
from uuid import UUID

from sqlmodel import Session, col, or_, select

from backend.api.deps import get_admin_user_id
from backend.db.models import Notification, SuggestionDismissal, User, UserFollow
from backend.services import app_settings
from backend.services.notification_delivery import (
    new_batch_id,
    record_delivery,
    record_unsent,
    tracked_url,
)
from backend.services.timezones import to_event_local

logger = logging.getLogger(__name__)

SUGGESTED_PERSON_JOINED = "suggested_person_joined"
# Older unpushed rows are left in-app only rather than pushed late.
PUSH_MAX_AGE = timedelta(days=2)
PUSH_COOLDOWN = timedelta(hours=24)


def _as_utc(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _int(key: str, session: Session) -> int:
    return app_settings.get_people_discovery_int(key, session)


def joiner_ineligible_reason(
    session: Session, joiner: User, now: datetime, *, forced: bool = False
) -> Optional[str]:
    """Why ``joiner`` must not trigger notifications; privacy gates apply even when forced."""
    if joiner.deleted_at is not None or not joiner.handle:
        return "inactive"
    if joiner.account_visibility == "private":
        return "private"
    if not joiner.show_in_suggestions:
        return "hidden_from_suggestions"
    if forced:
        return None
    if joiner.onboarded_at is None:
        return "not_onboarded"
    window = timedelta(days=_int("people_joined_window_days", session))
    if _as_utc(joiner.created_at) < now - window:
        return "outside_window"
    return None


def _connections(session: Session, user_ids: set[UUID]) -> list[tuple[UUID, UUID]]:
    """Approved follow edges touching ``user_ids`` as (follower, followee)."""
    if not user_ids:
        return []
    return list(
        session.exec(
            select(UserFollow.follower_id, UserFollow.followee_id)
            .where(UserFollow.status == "approved")
            .where(
                or_(
                    col(UserFollow.follower_id).in_(user_ids),
                    col(UserFollow.followee_id).in_(user_ids),
                )
            )
        ).all()
    )


def evaluate(
    session: Session, joiner: User, now: Optional[datetime] = None
) -> list[dict]:
    """Everyone sharing a connection with ``joiner``, ranked, with a skip reason
    (``None`` = would be notified). Curators/organizers count as "hub" connections
    with their own threshold; the admin account never counts.
    """
    now = now or datetime.now(timezone.utc)
    admin_id = get_admin_user_id(session)
    joiner_conn = {
        b if a == joiner.id else a for a, b in _connections(session, {joiner.id})
    } - {admin_id, joiner.id}
    if not joiner_conn:
        return []
    hubs = set(
        session.exec(
            select(User.id)
            .where(col(User.id).in_(joiner_conn))
            .where(
                or_(User.is_admin_managed == True, User.is_verified_organizer == True)
            )  # noqa: E712
        ).all()
    )
    shared: dict[UUID, set[UUID]] = {}
    for a, b in _connections(session, joiner_conn):
        for via, other in ((a, b), (b, a)):
            if via in joiner_conn and other not in (joiner.id, admin_id):
                shared.setdefault(other, set()).add(via)
    if not shared:
        return []

    recipients = {
        u.id: u
        for u in session.exec(select(User).where(col(User.id).in_(list(shared)))).all()
    }
    follows_joiner = set(
        session.exec(
            select(UserFollow.follower_id)
            .where(UserFollow.followee_id == joiner.id)
            .where(col(UserFollow.follower_id).in_(list(shared)))
        ).all()
    )
    ttl = timedelta(days=_int("suggestion_dismissal_ttl_days", session))
    dismissed = {
        uid
        for uid, at in session.exec(
            select(SuggestionDismissal.user_id, SuggestionDismissal.dismissed_at)
            .where(SuggestionDismissal.dismissed_user_id == joiner.id)
            .where(col(SuggestionDismissal.user_id).in_(list(shared)))
        ).all()
        if _as_utc(at) >= now - ttl
    }
    notified = set(
        session.exec(
            select(Notification.recipient_user_id)
            .where(Notification.kind == SUGGESTED_PERSON_JOINED)
            .where(Notification.actor_user_id == joiner.id)
        ).all()
    )
    min_regular = _int("people_joined_min_mutual", session)
    min_hub = _int("people_joined_min_mutual_curators", session)

    rows: list[dict] = []
    for uid, vias in shared.items():
        user = recipients.get(uid)
        if user is None:
            continue
        regular = len(vias - hubs)
        hub = len(vias & hubs)
        if user.deleted_at is not None or user.is_admin_managed:
            reason = "inactive"
        elif uid in follows_joiner or uid in joiner_conn:
            reason = "already_follows"
        elif uid in dismissed:
            reason = "dismissed"
        elif regular < min_regular and regular + hub < min_hub:
            reason = "below_threshold"
        elif uid in notified:
            reason = "already_notified"
        else:
            reason = None
        rows.append({"user": user, "regular": regular, "hub": hub, "reason": reason})
    rows.sort(key=lambda r: (r["reason"] is not None, -r["regular"], -r["hub"]))
    return rows


def _notify(session: Session, joiner: User, row: dict, now: datetime) -> Notification:
    notif = Notification(
        recipient_user_id=row["user"].id,
        actor_user_id=joiner.id,
        kind=SUGGESTED_PERSON_JOINED,
        event_id=None,
        context=str(row["regular"] + row["hub"]),
        created_at=now,
    )
    session.add(notif)
    session.flush()
    record_delivery(session, notif.id, "app", now)
    return notif


def detect(session: Session, now: Optional[datetime] = None) -> int:
    now = now or datetime.now(timezone.utc)
    window = timedelta(days=_int("people_joined_window_days", session))
    cap = _int("people_joined_max_recipients", session)
    joiners = session.exec(
        select(User)
        .where(User.created_at >= now - window)
        .where(User.deleted_at.is_(None))
        .where(User.onboarded_at.is_not(None))
    ).all()
    created = 0
    for joiner in joiners:
        if joiner_ineligible_reason(session, joiner, now):
            continue
        already = session.exec(
            select(Notification.id)
            .where(Notification.kind == SUGGESTED_PERSON_JOINED)
            .where(Notification.actor_user_id == joiner.id)
        ).all()
        budget = cap - len(already)
        if budget <= 0:
            continue
        for row in [r for r in evaluate(session, joiner, now) if r["reason"] is None][
            :budget
        ]:
            _notify(session, joiner, row, now)
            created += 1
    return created


def _in_push_window(session: Session, user: User, now: datetime) -> bool:
    hour = to_event_local(now, user.timezone).hour
    return (
        _int("people_joined_push_start_hour", session)
        <= hour
        < _int("people_joined_push_end_hour", session)
    )


def _push(
    session: Session,
    user: User,
    rows: list[Notification],
    actors: dict[UUID, User],
    now: datetime,
    source: str,
) -> bool:
    from backend.services.push_service import send_push

    first = actors.get(rows[0].actor_user_id)
    name = (first.display_name or f"@{first.handle}") if first else "Someone"
    if len(rows) == 1:
        mutual = int(rows[0].context or 0)
        title = f"{name} joined Movida"
        body = (
            f"You have {mutual} mutual connection{'s' if mutual != 1 else ''}. Say hi!"
        )
        url = tracked_url(
            f"/u/{first.handle}" if first else "/tribe/network", rows[0].id, "push"
        )
    else:
        title = f"{name} and {len(rows) - 1} other{'s' if len(rows) > 2 else ''} you may know joined Movida"
        body = "See who's new in your dance scene."
        url = tracked_url("/tribe/network", rows[0].id, "push")
    delivered = send_push(user.id, title=title, body=body, url=url, tag="people-joined")
    batch_id = new_batch_id()
    for n in rows:
        n.pushed_at = now
        session.add(n)
        if delivered:
            record_delivery(
                session,
                n.id,
                "push",
                now,
                mode="instant",
                source=source,
                batch_id=batch_id,
            )
    if not delivered:
        record_unsent(
            session, [n.id for n in rows], "push", now, mode="instant", source=source
        )
    return bool(delivered)


def push_pending(
    session: Session, now: Optional[datetime] = None, source: str = "tick"
) -> int:
    """At most one batched push per recipient per day, inside their local push window."""
    now = now or datetime.now(timezone.utc)
    pending = session.exec(
        select(Notification)
        .where(Notification.kind == SUGGESTED_PERSON_JOINED)
        .where(Notification.pushed_at.is_(None))
        .where(Notification.created_at >= now - PUSH_MAX_AGE)
        .order_by(col(Notification.created_at))
    ).all()
    by_recipient: dict[UUID, list[Notification]] = {}
    for n in pending:
        by_recipient.setdefault(n.recipient_user_id, []).append(n)
    if not by_recipient:
        return 0
    users = {
        u.id: u
        for u in session.exec(
            select(User).where(col(User.id).in_(list(by_recipient)))
        ).all()
    }
    actor_ids = {n.actor_user_id for n in pending}
    actors = {
        u.id: u
        for u in session.exec(select(User).where(col(User.id).in_(actor_ids))).all()
    }
    pushed = 0
    for uid, rows in by_recipient.items():
        user = users.get(uid)
        if user is None:
            continue
        if not user.push_people_suggestions_enabled:
            for n in rows:
                n.pushed_at = now
                session.add(n)
            continue
        if not _in_push_window(session, user, now):
            continue
        last = session.exec(
            select(Notification.pushed_at)
            .where(Notification.recipient_user_id == uid)
            .where(Notification.kind == SUGGESTED_PERSON_JOINED)
            .where(Notification.pushed_at.is_not(None))
            .order_by(col(Notification.pushed_at).desc())
        ).first()
        if last is not None and _as_utc(last) > now - PUSH_COOLDOWN:
            continue
        if _push(session, user, rows, actors, now, source):
            pushed += 1
    return pushed


def force_send(
    session: Session,
    joiner: User,
    channels: set[str],
    *,
    dry_run: bool,
    now: Optional[datetime] = None,
) -> dict:
    """Admin send-now: ignores the join window, onboarding and recipient cap,
    never the joiner's privacy gates or the recipient's own push opt-out."""
    now = now or datetime.now(timezone.utc)
    blocked = joiner_ineligible_reason(session, joiner, now, forced=True)
    rows = [] if blocked else evaluate(session, joiner, now)
    result = {
        "joiner_warning": blocked or joiner_ineligible_reason(session, joiner, now),
        "candidates": [
            {
                "user_id": str(r["user"].id),
                "handle": r["user"].handle,
                "display_name": r["user"].display_name,
                "regular_mutual": r["regular"],
                "curator_mutual": r["hub"],
                "reason": r["reason"],
                "push_enabled": bool(r["user"].push_people_suggestions_enabled),
            }
            for r in rows
        ],
        "created": 0,
        "pushed": 0,
    }
    if dry_run or blocked or "app" not in channels:
        return result
    for row in rows:
        if row["reason"] is not None:
            continue
        notif = _notify(session, joiner, row, now)
        result["created"] += 1
        if "push" not in channels or not row["user"].push_people_suggestions_enabled:
            notif.pushed_at = now
            session.add(notif)
        elif _push(session, row["user"], [notif], {joiner.id: joiner}, now, "admin"):
            result["pushed"] += 1
    return result


def stats(session: Session, since: datetime) -> dict:
    rows = session.exec(
        select(
            Notification.recipient_user_id,
            Notification.actor_user_id,
            Notification.pushed_at,
        )
        .where(Notification.kind == SUGGESTED_PERSON_JOINED)
        .where(Notification.created_at >= since)
    ).all()
    pairs = {(r, a) for r, a, _ in rows}
    followed = 0
    if pairs:
        follows = set(
            session.exec(
                select(UserFollow.follower_id, UserFollow.followee_id).where(
                    col(UserFollow.follower_id).in_({r for r, _ in pairs})
                )
            ).all()
        )
        followed = len(pairs & follows)
    return {
        "joined_created": len(rows),
        "joined_pushed": sum(1 for *_, p in rows if p is not None),
        "joined_followed": followed,
    }


def run_once(now: Optional[datetime] = None, source: str = "tick") -> dict:
    from backend.db.database import get_engine

    now = now or datetime.now(timezone.utc)
    with Session(get_engine()) as session:
        if not app_settings.get_people_joined_enabled(session):
            return {"created": 0, "pushed": 0}
        created = detect(session, now)
        session.commit()
        pushed = push_pending(session, now, source)
        session.commit()
    return {"created": created, "pushed": pushed}
