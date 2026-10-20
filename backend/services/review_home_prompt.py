"""Home review prompt: pick which attended event to ask about, under frequency caps."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlmodel import Session, col, delete, select

from backend.db.models import (
    CachedEvent,
    EventRating,
    ReviewPromptForce,
    ReviewPromptImpression,
    User,
    UserEventAttendance,
)
from backend.services import app_settings
from backend.services.passport import attended_events

OUTCOME_SHOWN = "shown"
OUTCOME_DISMISSED = "dismissed"
OUTCOME_REVIEWED = "reviewed"
FORCE_TTL = timedelta(days=7)


def _as_utc(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def unreviewed_attended_events(
    session: Session, user: User, since: datetime
) -> list[CachedEvent]:
    """Attended events started since ``since`` with no this_edition review, newest first."""
    events = [e for e in attended_events(session, user.id) if _as_utc(e.start) >= since]
    if not events:
        return []
    rated = set(
        session.exec(
            select(EventRating.event_id)
            .where(EventRating.user_id == user.id)
            .where(EventRating.scope == "this_edition")
            .where(col(EventRating.event_id).in_([e.event_id for e in events]))
        ).all()
    )
    return [e for e in events if e.event_id not in rated]


def _active_forces(session: Session, user: User, now: datetime) -> dict[str, datetime]:
    return {
        f.event_id: _as_utc(f.created_at)
        for f in session.exec(
            select(ReviewPromptForce).where(
                ReviewPromptForce.user_id == user.id,
                ReviewPromptForce.expires_at > now,
            )
        ).all()
    }


def _impression_times(
    session: Session, user: User, event_ids: list[str]
) -> dict[str, list[datetime]]:
    times: dict[str, list[datetime]] = {}
    if not event_ids:
        return times
    for event_id, shown_at in session.exec(
        select(ReviewPromptImpression.event_id, ReviewPromptImpression.shown_at).where(
            ReviewPromptImpression.user_id == user.id,
            col(ReviewPromptImpression.event_id).in_(event_ids),
        )
    ).all():
        times.setdefault(event_id, []).append(_as_utc(shown_at))
    return times


def _capped(session: Session, user: User, now: datetime) -> bool:
    """Cooldown since the last prompt, or the fatigue pause after repeated ignores."""
    cooldown = app_settings.get_review_home_prompt_int(
        "review_home_prompt_cooldown_hours", session
    )
    fatigue = app_settings.get_review_home_prompt_int(
        "review_home_prompt_fatigue_dismissals", session
    )
    pause_days = app_settings.get_review_home_prompt_int(
        "review_home_prompt_fatigue_pause_days", session
    )
    recent = session.exec(
        select(ReviewPromptImpression)
        .where(ReviewPromptImpression.user_id == user.id)
        .order_by(col(ReviewPromptImpression.shown_at).desc())
        .limit(fatigue)
    ).all()
    if not recent:
        return False
    if _as_utc(recent[0].shown_at) > now - timedelta(hours=cooldown):
        return True
    ignored = len(recent) == fatigue and all(
        r.outcome != OUTCOME_REVIEWED for r in recent
    )
    return ignored and _as_utc(recent[0].shown_at) > now - timedelta(days=pause_days)


def pick_prompt_event(
    session: Session, user: User, now: Optional[datetime] = None
) -> tuple[Optional[CachedEvent], bool]:
    """Return ``(event, forced)`` for the Home prompt, or ``(None, False)``."""
    now = now or datetime.now(timezone.utc)
    if not app_settings.get_review_home_prompt_enabled(session):
        return None, False
    max_age = app_settings.get_review_home_prompt_int(
        "review_home_prompt_max_event_age_days", session
    )
    max_impressions = app_settings.get_review_home_prompt_int(
        "review_home_prompt_max_impressions_per_event", session
    )
    delay = timedelta(hours=app_settings.get_review_prompt_delay_hours(session))
    forces = _active_forces(session, user, now)
    window_days = max(max_age, app_settings.get_for_you_review_window_days(session))
    candidates = [
        e
        for e in unreviewed_attended_events(
            session, user, now - timedelta(days=window_days)
        )
        if _as_utc(e.end) <= now - delay
    ]
    candidates.sort(key=lambda e: _as_utc(e.end), reverse=True)
    shown = _impression_times(session, user, [e.event_id for e in candidates])

    # A force re-arms the per-event cap from the moment it was set.
    for event in candidates:
        forced_at = forces.get(event.event_id)
        if forced_at is None:
            continue
        since_force = [t for t in shown.get(event.event_id, []) if t >= forced_at]
        if len(since_force) < max_impressions:
            return event, True
    if _capped(session, user, now):
        return None, False
    cutoff = now - timedelta(days=max_age)
    for event in candidates:
        if _as_utc(event.end) < cutoff:
            break
        if len(shown.get(event.event_id, [])) < max_impressions:
            return event, False
    return None, False


def record_impression(
    session: Session,
    user: User,
    event_id: str,
    outcome: str,
    now: Optional[datetime] = None,
) -> bool:
    """Log a showing or mark the latest one dismissed. False if the user never attended."""
    now = now or datetime.now(timezone.utc)
    attended = session.exec(
        select(UserEventAttendance.id).where(
            UserEventAttendance.user_id == user.id,
            UserEventAttendance.event_id == event_id,
        )
    ).first()
    if attended is None:
        return False
    if outcome == OUTCOME_SHOWN:
        session.add(
            ReviewPromptImpression(
                user_id=user.id,
                event_id=event_id,
                shown_at=now,
                outcome=OUTCOME_SHOWN,
                forced=event_id in _active_forces(session, user, now),
            )
        )
        return True
    latest = _latest_impression(session, user.id, event_id)
    if latest is not None and latest.outcome == OUTCOME_SHOWN:
        latest.outcome = outcome
        session.add(latest)
    return True


def _latest_impression(
    session: Session, user_id, event_id: str
) -> Optional[ReviewPromptImpression]:
    return session.exec(
        select(ReviewPromptImpression)
        .where(
            ReviewPromptImpression.user_id == user_id,
            ReviewPromptImpression.event_id == event_id,
        )
        .order_by(col(ReviewPromptImpression.shown_at).desc())
    ).first()


def mark_reviewed(session: Session, user_id, event_id: str) -> None:
    """A review landed (from any surface): close the prompt loop for this event."""
    latest = _latest_impression(session, user_id, event_id)
    if latest is not None and latest.outcome != OUTCOME_REVIEWED:
        latest.outcome = OUTCOME_REVIEWED
        session.add(latest)
    session.exec(
        delete(ReviewPromptForce).where(
            ReviewPromptForce.user_id == user_id,
            ReviewPromptForce.event_id == event_id,
        )
    )


def force_prompt(
    session: Session,
    user_id,
    event_id: str,
    forced_by: Optional[str],
    now: Optional[datetime] = None,
) -> None:
    now = now or datetime.now(timezone.utc)
    existing = session.exec(
        select(ReviewPromptForce).where(
            ReviewPromptForce.user_id == user_id,
            ReviewPromptForce.event_id == event_id,
        )
    ).first()
    row = existing or ReviewPromptForce(
        user_id=user_id, event_id=event_id, expires_at=now
    )
    row.forced_by = forced_by
    row.created_at = now
    row.expires_at = now + FORCE_TTL
    session.add(row)
