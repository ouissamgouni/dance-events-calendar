"""Engagement primitive: set Saved / Going state for an authenticated user.

This module exists to back the admin-curation features (bulk on-demand
write + per-calendar pipeline rules). Both operate exclusively on
authenticated, admin-managed target users — so this primitive
deliberately does *not* implement the anon-cookie / device_id back-compat
dance that the self-serve routes in
[backend/api/routes/tracking.py](backend/api/routes/tracking.py) need.

Self-serve tracking continues to own its handlers unchanged: refactoring
them to share this primitive carries fan-out / dedupe risk that is out of
scope. Future unification can land once the curation feature is shipped
and proven.

Properties:
- Idempotent: re-running ``set_event_engagement(... add)`` for the same
  target/event is a no-op and returns ``changed=False``.
- Single source of truth for the (device_id, event_id) dedupe key when
  writing on behalf of a user — uses ``str(target_user.id)`` so curator
  rows never collide with the user's own device-keyed rows.
- Audit-aware: every write stamps ``created_by_admin_user_id`` so the
  UI can render a "Curated" transparency pill on those entries.
- Notification-aware: ``going`` writes that end up in a shared tier
  (``public`` / ``friends``) trigger ``fan_out_going``; removing a
  shared row triggers ``withdraw_going``. Curation should typically be
  silent (``fan_out=False``) to avoid surprising the target's followers.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Optional
from uuid import UUID

from sqlmodel import Session, select

from backend.db.models import (
    User,
    UserEventAttendance,
    UserSavedEvent,
)
from backend.services.notifications import fan_out_going, withdraw_going

EngagementKind = Literal["save", "going"]
EngagementAction = Literal["add", "remove"]
Audience = Literal["public", "friends", "private"]


@dataclass
class EngagementResult:
    """Outcome of one ``set_event_engagement`` call.

    Attributes:
        changed: True when the call mutated the row set (inserted on
            ``add``, deleted on ``remove``, or updated the audience on a
            pre-existing row).
        created: True only when a new row was inserted.
        deleted: True only when one or more rows were removed.
        fan_out_count: Number of notifications dispatched (0 unless
            ``fan_out`` was True and the row ended up in a shared tier).
    """

    changed: bool
    created: bool = False
    deleted: bool = False
    fan_out_count: int = 0


def _curator_device_key(target_user: User) -> str:
    """Stable dedupe key for curator-written rows on an authed target.

    Using ``str(user.id)`` keeps curator rows separate from the user's
    own device-keyed rows (which use their localStorage device_id or
    anon cookie) — so a curator add followed by the user's own add
    don't dedupe-collapse into one ambiguous row.
    """
    return f"admin:{target_user.id}"


def set_event_engagement(
    session: Session,
    *,
    target_user: User,
    event_id: str,
    kind: EngagementKind,
    action: EngagementAction,
    audience: Optional[Audience] = None,
    fan_out: bool = False,
    created_by_admin_user_id: Optional[UUID] = None,
) -> EngagementResult:
    """Add/remove a Saved or Going entry on behalf of ``target_user``.

    Args:
        session: open DB session — caller owns the transaction and must
            commit (this lets callers batch many writes inside a single
            commit for the bulk route).
        target_user: the authenticated user whose Saved/Going list is
            being mutated. Must be loaded with a real ``id``.
        event_id: CachedEvent.id (string).
        kind: ``save`` or ``going``.
        action: ``add`` or ``remove``.
        audience: per-row audience tier. Ignored for ``remove``. When
            None on ``add``, falls back to the target's profile default
            (``share_attendance_default_audience`` for Going,
            same default for Saved).
        fan_out: when True and the resulting Going row is in a shared
            tier (``public`` | ``friends``), dispatch ``fan_out_going``.
            Curation passes True by default to trigger notifications the
            same way UI RSVPs do.
        created_by_admin_user_id: admin user id to stamp on the new row
            for audit + the "Curated" transparency pill. None for
            self-serve callers.

    Returns:
        EngagementResult describing what changed.

    Caller responsibilities:
        - Verify ``target_user.is_admin_managed`` (or self) before
          calling — this primitive does *not* enforce the ownership gate.
        - Commit the session.
    """
    if action == "remove":
        return _remove(session, target_user, event_id, kind, fan_out=fan_out)
    return _add(
        session,
        target_user,
        event_id,
        kind,
        audience=audience,
        fan_out=fan_out,
        created_by_admin_user_id=created_by_admin_user_id,
    )


def _resolve_audience(target_user: User, audience: Optional[str]) -> str:
    if audience is not None:
        return audience
    # Mirror the self-serve handlers' fallback chain: explicit per-row
    # audience > user's share_attendance_default_audience > "friends"
    # (GDPR privacy-by-default).
    return target_user.share_attendance_default_audience or "friends"


def _add(
    session: Session,
    target_user: User,
    event_id: str,
    kind: EngagementKind,
    *,
    audience: Optional[Audience],
    fan_out: bool,
    created_by_admin_user_id: Optional[UUID],
) -> EngagementResult:
    device_key = _curator_device_key(target_user)
    resolved_audience = _resolve_audience(target_user, audience)

    if kind == "save":
        existing = session.exec(
            select(UserSavedEvent).where(
                UserSavedEvent.user_id == target_user.id,
                UserSavedEvent.event_id == event_id,
            )
        ).first()
        if existing is not None:
            # Audience update is the only meaningful mutation on an
            # already-saved event; curator may re-run a rule with a
            # different audience tier and we honour that.
            if existing.audience != resolved_audience:
                existing.audience = resolved_audience
                session.add(existing)
                return EngagementResult(changed=True)
            return EngagementResult(changed=False)
        session.add(
            UserSavedEvent(
                device_id=device_key,
                event_id=event_id,
                user_id=target_user.id,
                audience=resolved_audience,
                created_by_admin_user_id=created_by_admin_user_id,
            )
        )
        return EngagementResult(changed=True, created=True)

    # kind == "going"
    existing_going = session.exec(
        select(UserEventAttendance).where(
            UserEventAttendance.user_id == target_user.id,
            UserEventAttendance.event_id == event_id,
        )
    ).first()
    fan_out_count = 0
    if existing_going is not None:
        if existing_going.share_audience != resolved_audience:
            was_shared = existing_going.share_audience in ("public", "friends")
            existing_going.share_audience = resolved_audience
            existing_going.share_publicly = resolved_audience == "public"
            session.add(existing_going)
            now_shared = resolved_audience in ("public", "friends")
            if (
                fan_out
                and now_shared
                and (
                    not was_shared or resolved_audience != existing_going.share_audience
                )
            ):
                fan_out_count = fan_out_going(
                    session, target_user, event_id, audience=resolved_audience
                )
            elif was_shared and not now_shared:
                withdraw_going(session, target_user, event_id)
            return EngagementResult(changed=True, fan_out_count=fan_out_count)
        return EngagementResult(changed=False)

    session.add(
        UserEventAttendance(
            device_id=device_key,
            event_id=event_id,
            user_id=target_user.id,
            share_publicly=resolved_audience == "public",
            share_audience=resolved_audience,
            created_by_admin_user_id=created_by_admin_user_id,
        )
    )
    if fan_out and resolved_audience in ("public", "friends"):
        fan_out_count = fan_out_going(
            session, target_user, event_id, audience=resolved_audience
        )
    return EngagementResult(changed=True, created=True, fan_out_count=fan_out_count)


def _remove(
    session: Session,
    target_user: User,
    event_id: str,
    kind: EngagementKind,
    *,
    fan_out: bool,
) -> EngagementResult:
    """Sweep every row owned by ``target_user`` for ``event_id``.

    Curator-written rows and the user's own device-keyed rows both live
    under the same ``user_id`` so this clears the engagement entirely.
    If callers ever want to "uncurate but keep the user's own row",
    that's a future scope (filter by ``created_by_admin_user_id``).
    """
    if kind == "save":
        rows = session.exec(
            select(UserSavedEvent).where(
                UserSavedEvent.user_id == target_user.id,
                UserSavedEvent.event_id == event_id,
            )
        ).all()
        for row in rows:
            session.delete(row)
        return EngagementResult(changed=bool(rows), deleted=bool(rows))

    rows_g = session.exec(
        select(UserEventAttendance).where(
            UserEventAttendance.user_id == target_user.id,
            UserEventAttendance.event_id == event_id,
        )
    ).all()
    was_shared = any(r.share_audience in ("public", "friends") for r in rows_g)
    for row in rows_g:
        session.delete(row)
    if rows_g and was_shared and fan_out:
        # Mirror tracking.py: revoke the fan-out so the row doesn't
        # linger in subscribers' feeds.
        withdraw_going(session, target_user, event_id)
    return EngagementResult(changed=bool(rows_g), deleted=bool(rows_g))
