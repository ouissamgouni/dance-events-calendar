"""People discovery: "Not interested" dismissals and the Home people-sheet caps."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional
from uuid import UUID

from sqlmodel import Session, col, delete, func, select

from backend.db.models import (
    PeoplePromptForce,
    PeoplePromptImpression,
    SuggestionDismissal,
    User,
)
from backend.services import app_settings

OUTCOME_SHOWN = "shown"
OUTCOME_DISMISSED = "dismissed"
OUTCOME_FOLLOWED = "followed"
FORCE_TTL = timedelta(days=7)


def _as_utc(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _int(key: str, session: Session) -> int:
    return app_settings.get_people_discovery_int(key, session)


def dismissed_user_ids(
    session: Session, user_id: UUID, now: Optional[datetime] = None
) -> set[UUID]:
    """People ``user_id`` marked "Not interested" within the TTL."""
    now = now or datetime.now(timezone.utc)
    cutoff = now - timedelta(days=_int("suggestion_dismissal_ttl_days", session))
    rows = session.exec(
        select(
            SuggestionDismissal.dismissed_user_id, SuggestionDismissal.dismissed_at
        ).where(SuggestionDismissal.user_id == user_id)
    ).all()
    return {target for target, at in rows if _as_utc(at) >= cutoff}


def dismiss(
    session: Session, user_id: UUID, target_id: UUID, now: Optional[datetime] = None
) -> None:
    now = now or datetime.now(timezone.utc)
    row = session.exec(
        select(SuggestionDismissal).where(
            SuggestionDismissal.user_id == user_id,
            SuggestionDismissal.dismissed_user_id == target_id,
        )
    ).first() or SuggestionDismissal(user_id=user_id, dismissed_user_id=target_id)
    row.dismissed_at = now
    session.add(row)


def undismiss(session: Session, user_id: UUID, target_id: UUID) -> None:
    session.exec(
        delete(SuggestionDismissal).where(
            SuggestionDismissal.user_id == user_id,
            SuggestionDismissal.dismissed_user_id == target_id,
        )
    )


def trail_position(session: Session, friend_count: int) -> str:
    return (
        "top"
        if friend_count <= _int("people_trail_top_max_friends", session)
        else "bottom"
    )


def _cooldown_hours(session: Session, friend_count: int) -> Optional[int]:
    """Sheet cadence for this circle size; None = circle big enough, no sheet."""
    if friend_count <= _int("people_prompt_tier1_max_friends", session):
        return _int("people_prompt_tier1_cooldown_hours", session)
    if friend_count <= _int("people_prompt_tier2_max_friends", session):
        return _int("people_prompt_tier2_cooldown_hours", session)
    return None


def active_force(
    session: Session, user_id: UUID, now: Optional[datetime] = None
) -> Optional[PeoplePromptForce]:
    now = now or datetime.now(timezone.utc)
    row = session.exec(
        select(PeoplePromptForce).where(PeoplePromptForce.user_id == user_id)
    ).first()
    if row is None or _as_utc(row.expires_at) <= now:
        return None
    return row


def _cap_reason(
    session: Session, user: User, friend_count: int, now: datetime
) -> Optional[str]:
    cooldown = _cooldown_hours(session, friend_count)
    if cooldown is None:
        return "circle_too_big"
    fatigue = _int("people_prompt_fatigue_dismissals", session)
    pause_days = _int("people_prompt_fatigue_pause_days", session)
    recent = session.exec(
        select(PeoplePromptImpression)
        .where(PeoplePromptImpression.user_id == user.id)
        .order_by(col(PeoplePromptImpression.shown_at).desc())
        .limit(fatigue)
    ).all()
    if not recent:
        return None
    if _as_utc(recent[0].shown_at) > now - timedelta(hours=cooldown):
        return "cooldown"
    ignored = len(recent) == fatigue and all(
        r.outcome != OUTCOME_FOLLOWED for r in recent
    )
    if ignored and _as_utc(recent[0].shown_at) > now - timedelta(days=pause_days):
        return "fatigue"
    return None


def decide(
    session: Session,
    user: User,
    friend_count: int,
    suggestion_count: int,
    now: Optional[datetime] = None,
) -> tuple[bool, bool, str]:
    """Return ``(show, forced, reason)`` for the Home people sheet."""
    now = now or datetime.now(timezone.utc)
    if not app_settings.get_people_prompt_enabled(session):
        return False, False, "disabled"
    if suggestion_count == 0:
        return False, False, "no_suggestions"
    if active_force(session, user.id, now) is not None:
        return True, True, "forced"
    if suggestion_count < _int("people_prompt_min_suggestions", session):
        return False, False, "too_few_suggestions"
    reason = _cap_reason(session, user, friend_count, now)
    return reason is None, False, reason or "ok"


def should_show(
    session: Session,
    user: User,
    friend_count: int,
    suggestion_count: int,
    now: Optional[datetime] = None,
) -> tuple[bool, bool]:
    """Return ``(show, forced)`` for the Home people sheet."""
    show, forced, _ = decide(session, user, friend_count, suggestion_count, now)
    return show, forced


def record_impression(
    session: Session,
    user: User,
    outcome: str,
    followed_count: int = 0,
    now: Optional[datetime] = None,
) -> None:
    """Log a showing (consuming any force) or close the latest one."""
    now = now or datetime.now(timezone.utc)
    if outcome == OUTCOME_SHOWN:
        force = active_force(session, user.id, now)
        session.add(
            PeoplePromptImpression(
                user_id=user.id,
                shown_at=now,
                outcome=OUTCOME_SHOWN,
                forced=force is not None,
            )
        )
        if force is not None:
            session.delete(force)
        return
    latest = session.exec(
        select(PeoplePromptImpression)
        .where(PeoplePromptImpression.user_id == user.id)
        .order_by(col(PeoplePromptImpression.shown_at).desc())
    ).first()
    if latest is not None and latest.outcome == OUTCOME_SHOWN:
        latest.outcome = outcome
        latest.followed_count = followed_count
        session.add(latest)


def force_prompt(
    session: Session,
    user_id: UUID,
    forced_by: Optional[str],
    now: Optional[datetime] = None,
) -> None:
    now = now or datetime.now(timezone.utc)
    row = session.exec(
        select(PeoplePromptForce).where(PeoplePromptForce.user_id == user_id)
    ).first() or PeoplePromptForce(user_id=user_id, expires_at=now)
    row.forced_by = forced_by
    row.created_at = now
    row.expires_at = now + FORCE_TTL
    session.add(row)


def prompt_stats(session: Session, since: datetime) -> dict:
    rows = session.exec(
        select(
            PeoplePromptImpression.outcome,
            PeoplePromptImpression.forced,
            func.count(),
            func.coalesce(func.sum(PeoplePromptImpression.followed_count), 0),
        )
        .where(PeoplePromptImpression.shown_at >= since)
        .group_by(PeoplePromptImpression.outcome, PeoplePromptImpression.forced)
    ).all()
    stats = {"shown": 0, "dismissed": 0, "followed": 0, "follows": 0, "forced_shown": 0}
    for outcome, forced, count, follows in rows:
        stats["shown"] += count
        if outcome == OUTCOME_DISMISSED:
            stats["dismissed"] += count
        elif outcome == OUTCOME_FOLLOWED:
            stats["followed"] += count
        stats["follows"] += int(follows or 0)
        if forced:
            stats["forced_shown"] += count
    return stats
