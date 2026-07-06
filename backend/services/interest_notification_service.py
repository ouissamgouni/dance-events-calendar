"""Interest-profile match notifications.

Run periodically by the notification dispatch loop. For every enabled
``UserInterestProfile`` (geography + dance-style/reach tags), scans recently
ingested ``CachedEvent`` rows and creates a single in-app ``interest_event``
notification for each (user, event) match.

Matching (PRD section 7, group-aware):
  - >=1 overlap between the event's tags and the profile's dance-style tags.
  - reach: empty profile reach selection = "match any scale"; otherwise
    >=1 overlap between the event's tags and the profile's reach tags.
  - geography: event lat/lng inside the profile's bbox
    (``min_lat``/``min_lng``/``max_lat``/``max_lng``).
  - Events without lat/lng are excluded entirely (can't test geography).

Idempotency: mirrors ``reminder_service`` — ``actor_user_id = recipient``
(self, no external actor), so the existing
``(recipient, kind, actor, event_id)`` unique constraint guarantees at most
one ``interest_event`` notification per user per event even when several of
their profiles match. The matched profile label(s) are comma-joined into
``Notification.context`` for message rendering.

Delivery: this service only creates in-app rows (``emailed_at=None``); email
and push are handled by the existing batched activity digest
(``services/activity_email.py``), which the caller must run afterward and
which recognizes ``interest_event`` as an activity kind.

Scan window: bounded by a ``site_settings`` "last scan" marker (event
``updated_at``) rather than rescanning full history each tick. Since there is
no separate "created_at" column, an edited event can re-enter the window;
this is harmless because it just makes the event a match candidate again —
the unique constraint prevents a duplicate notification.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from sqlmodel import Session, select

from backend.services.app_settings import get_interest_match_notifications_enabled
from backend.db.database import get_engine
from backend.db.models import (
    CachedEvent,
    EventTag,
    Notification,
    SiteSetting,
    Tag,
    TagGroup,
    User,
    UserInterestProfile,
    UserInterestProfileTag,
)

logger = logging.getLogger(__name__)

INTEREST_EVENT = "interest_event"

_LAST_SCAN_KEY = "interest_notification_last_scan"
# Bound the first-ever scan so a fresh deploy doesn't walk the entire event
# history looking for matches (mirrors activity_email's _MAX_AGE rationale).
_INITIAL_LOOKBACK = timedelta(hours=24)


def _utcnow_naive() -> datetime:
    # datetime.utcnow() is deprecated in 3.12+; preserve naive-UTC semantics.
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _geo_match(profile: UserInterestProfile, lat: float, lng: float) -> bool:
    if None in (profile.min_lat, profile.min_lng, profile.max_lat, profile.max_lng):
        return False
    return (
        profile.min_lat <= lat <= profile.max_lat
        and profile.min_lng <= lng <= profile.max_lng
    )


def _get_last_scan(session: Session) -> datetime:
    row = session.get(SiteSetting, _LAST_SCAN_KEY)
    if row and row.value:
        try:
            return datetime.fromisoformat(row.value)
        except ValueError:
            pass
    return _utcnow_naive() - _INITIAL_LOOKBACK


def _set_last_scan(session: Session, when: datetime) -> None:
    row = session.get(SiteSetting, _LAST_SCAN_KEY)
    if row:
        row.value = when.isoformat()
        session.add(row)
    else:
        session.add(SiteSetting(key=_LAST_SCAN_KEY, value=when.isoformat()))


def _candidate_events(
    session: Session, since: datetime, now: datetime
) -> list[CachedEvent]:
    """Recently ingested/updated, visible, future, geolocated events."""
    return session.exec(
        select(CachedEvent)
        .where(CachedEvent.deleted_at.is_(None))  # type: ignore[union-attr]
        .where(CachedEvent.is_hidden == False)  # noqa: E712
        .where(CachedEvent.updated_at > since)
        .where(CachedEvent.updated_at <= now)
        .where(CachedEvent.start > now)
        .where(CachedEvent.latitude.is_not(None))  # type: ignore[union-attr]
        .where(CachedEvent.longitude.is_not(None))  # type: ignore[union-attr]
    ).all()


def _load_event_tag_ids(session: Session, event_ids: list[str]) -> dict[str, set[int]]:
    if not event_ids:
        return {}
    rows = session.exec(
        select(EventTag.event_id, EventTag.tag_id).where(
            EventTag.event_id.in_(event_ids)  # type: ignore[union-attr]
        )
    ).all()
    out: dict[str, set[int]] = {}
    for event_id, tag_id in rows:
        out.setdefault(event_id, set()).add(int(tag_id))
    return out


def _load_active_profiles(session: Session) -> list[tuple[UserInterestProfile, User]]:
    """Enabled profiles for users who aren't deleted.

    Row creation is unconditional at the user level (channel gates live on
    ``User`` and only affect email/push delivery, not in-app rows). We still
    honor the per-profile ``matches_enabled`` opt-out so users can silence
    a specific saved search without deleting it.
    """
    return session.exec(
        select(UserInterestProfile, User)
        .join(User, User.id == UserInterestProfile.user_id)  # type: ignore[arg-type]
        .where(UserInterestProfile.matches_enabled == True)  # noqa: E712
        .where(User.deleted_at.is_(None))  # type: ignore[union-attr]
    ).all()


def _load_profile_tags(
    session: Session, profile_ids: list[int]
) -> dict[int, tuple[set[int], set[int]]]:
    """Bulk (dance_tag_ids, reach_tag_ids) per profile, split by group slug."""
    if not profile_ids:
        return {}
    reach_group_id = session.exec(
        select(TagGroup.id).where(TagGroup.slug == "reach")
    ).first()
    rows = session.exec(
        select(UserInterestProfileTag.profile_id, Tag.id, Tag.group_id)
        .join(Tag, Tag.id == UserInterestProfileTag.tag_id)  # type: ignore[arg-type]
        .where(UserInterestProfileTag.profile_id.in_(profile_ids))  # type: ignore[union-attr]
    ).all()
    out: dict[int, tuple[set[int], set[int]]] = {
        pid: (set(), set()) for pid in profile_ids
    }
    for profile_id, tag_id, group_id in rows:
        dance_ids, reach_ids = out[profile_id]
        if reach_group_id is not None and group_id == reach_group_id:
            reach_ids.add(int(tag_id))
        else:
            dance_ids.add(int(tag_id))
    return out


def _find_matches(
    session: Session, events: list[CachedEvent], user_ids: set | None = None
) -> dict[tuple, list[str]]:
    """Group-aware match of candidate ``events`` against active profiles.

    Returns ``(recipient_user_id, event_id) -> [matched profile labels]``.
    Pure matching — does not touch ``Notification`` rows, so it's safe to
    call from a dry-run preview as well as the real create path.
    """
    if not events:
        return {}

    event_tags = _load_event_tag_ids(session, [e.event_id for e in events])

    profiles_stmt = (
        select(UserInterestProfile, User)
        .join(User, User.id == UserInterestProfile.user_id)  # type: ignore[arg-type]
        .where(UserInterestProfile.matches_enabled == True)  # noqa: E712
        .where(User.deleted_at.is_(None))  # type: ignore[union-attr]
    )
    if user_ids is not None:
        profiles_stmt = profiles_stmt.where(UserInterestProfile.user_id.in_(user_ids))  # type: ignore[union-attr]
    profiles = session.exec(profiles_stmt).all()
    if not profiles:
        return {}

    profile_tags = _load_profile_tags(session, [p.id for p, _ in profiles])

    matches: dict[tuple, list[str]] = {}
    for profile, user in profiles:
        dance_ids, reach_ids = profile_tags.get(profile.id, (set(), set()))
        if not dance_ids:
            continue
        for event in events:
            tags = event_tags.get(event.event_id, set())
            if not (dance_ids & tags):
                continue
            if reach_ids and not (reach_ids & tags):
                continue
            if not _geo_match(profile, event.latitude, event.longitude):
                continue
            key = (user.id, event.event_id)
            matches.setdefault(key, []).append(profile.label)
    return matches


def _existing_notification_pairs(
    session: Session, matches: dict[tuple, list[str]]
) -> set[tuple]:
    """(recipient_user_id, event_id) pairs already delivered as
    ``interest_event`` notifications, restricted to the given ``matches``
    keys (avoids scanning the whole table)."""
    if not matches:
        return set()
    recipient_ids = {uid for uid, _ in matches}
    event_ids = {eid for _, eid in matches}
    return set(
        session.exec(
            select(Notification.recipient_user_id, Notification.event_id)
            .where(Notification.kind == INTEREST_EVENT)
            .where(Notification.recipient_user_id.in_(recipient_ids))  # type: ignore[union-attr]
            .where(Notification.event_id.in_(event_ids))  # type: ignore[union-attr]
        ).all()
    )


def _scan_and_create(
    session: Session,
    since: datetime,
    now: datetime,
    user_ids: set | None = None,
) -> dict:
    """Match candidate events against active profiles and create
    ``interest_event`` notification rows. Shared by ``run_once`` (global
    scan cursor) and ``run_once_for_users`` (admin force-send, scoped to a
    hand-picked set of users over a configurable lookback window).

    Does not touch the ``_LAST_SCAN_KEY`` watermark — callers own that.
    """
    events = _candidate_events(session, since, now)
    if not events:
        return {"candidates": 0, "created": 0}

    matches = _find_matches(session, events, user_ids)

    created = 0
    if matches:
        existing = _existing_notification_pairs(session, matches)
        for (user_id, event_id), labels in matches.items():
            if (user_id, event_id) in existing:
                continue
            context = ", ".join(dict.fromkeys(labels))  # dedupe, preserve order
            session.add(
                Notification(
                    recipient_user_id=user_id,
                    actor_user_id=user_id,  # self: no external actor
                    kind=INTEREST_EVENT,
                    event_id=event_id,
                    context=context[:200],
                )
            )
            created += 1

    return {"candidates": len(events), "created": created}


def run_once() -> dict:
    """Create due ``interest_event`` notifications. Returns a stats dict."""
    if not get_interest_match_notifications_enabled():
        return {"skipped": "interest_notifications_disabled"}

    now = _utcnow_naive()

    with Session(get_engine(), expire_on_commit=False) as session:
        since = _get_last_scan(session)
        logger.debug(
            "Interest notification scan window: since=%s now=%s (%.0fs)",
            since,
            now,
            (now - since).total_seconds(),
        )
        result = _scan_and_create(session, since, now)
        _set_last_scan(session, now)
        session.commit()

    logger.info(
        "Interest notification run: %d candidates, %d created",
        result["candidates"],
        result["created"],
    )
    return result


def run_once_for_users(user_ids: set, lookback_hours: int) -> dict:
    """Admin "force send" override: match candidate events for a specific
    set of users over a custom ``lookback_hours`` window, bypassing both
    the global enable/disable gate and the shared last-scan cursor (the
    global cursor is left untouched so the next automatic tick's window is
    unaffected by this manual run).

    Existing ``(recipient, event)`` notifications are still respected —
    this creates new matches within the window, it does not duplicate or
    resend ones already delivered.
    """
    now = _utcnow_naive()
    since = now - timedelta(hours=lookback_hours)

    with Session(get_engine(), expire_on_commit=False) as session:
        result = _scan_and_create(session, since, now, user_ids=set(user_ids))
        session.commit()

    logger.info(
        "Interest notification FORCE run: users=%d lookback_hours=%d -> "
        "%d candidates, %d created",
        len(user_ids),
        lookback_hours,
        result["candidates"],
        result["created"],
    )
    return result


def preview_matches_for_users(user_ids: set, lookback_hours: int) -> dict:
    """Dry-run version of ``run_once_for_users``: reports, per user, how
    many candidate events would match their interest profile(s) over the
    given lookback window — WITHOUT creating any ``Notification`` rows.

    Powers the admin "force-send" preview so an operator can sanity-check
    that a user actually has matches before committing a send. This is the
    key diagnostic for the common "N candidates, 0 created" confusion: the
    ``candidates`` count from the force-send run is the number of events in
    the lookback window GLOBALLY, not matches for the selected user(s) — a
    user with 0 matches (no profile, no dance tags on their profile, no
    geo/reach overlap) will always show 0 created regardless of how many
    candidate events exist.

    Returns ``{"candidates_scanned": int, "per_user": {user_id_str: {
    "matched_events": int, "new_events": int}}}``. ``matched_events`` is
    the total number of events matching that user's profile(s) in the
    window; ``new_events`` is the subset not already delivered as an
    ``interest_event`` notification (i.e. what a force-send would actually
    create).
    """
    now = _utcnow_naive()
    since = now - timedelta(hours=lookback_hours)

    with Session(get_engine(), expire_on_commit=False) as session:
        events = _candidate_events(session, since, now)
        matches = _find_matches(session, events, set(user_ids))
        existing = _existing_notification_pairs(session, matches)

    per_user: dict[str, dict] = {
        str(uid): {"matched_events": 0, "new_events": 0} for uid in user_ids
    }
    for (user_id, event_id), _labels in matches.items():
        bucket = per_user.setdefault(
            str(user_id), {"matched_events": 0, "new_events": 0}
        )
        bucket["matched_events"] += 1
        if (user_id, event_id) not in existing:
            bucket["new_events"] += 1

    return {"candidates_scanned": len(events), "per_user": per_user}
