"""User-submitted organizer claims.

Sign-in required. Admin-moderated. Feature-flagged via the
``organizer_claims_enabled`` site setting. Submission requires a
non-empty bio and at least one social link (instagram or facebook) on
the submitter's profile — enforced server-side so the UI can't bypass.

Approving an event sets ``cached_events.organizer_user_id``. Granting
the badge flips ``users.is_verified_organizer``. Both happen atomically
in :func:`admin_decide_claim`.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from uuid import UUID, uuid4

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from sqlmodel import Session, col, func, select

from backend.api.deps import require_admin, require_flag, require_user
from backend.api.schemas import (
    AdminEventOrganizerOut,
    AdminEventOrganizerUpdate,
    AdminUserOrganizerOut,
    AdminUserOrganizerUpdate,
    EventOrganizerMini,
    OrganizedEventOut,
    OrganizerClaimAdminOut,
    OrganizerClaimCreate,
    OrganizerClaimDecideRequest,
    OrganizerClaimEventOut,
    OrganizerClaimEventsAdd,
    OrganizerClaimOut,
)
from backend.config.loader import get_admin_email
from backend.db.database import get_session
from backend.db.models import (
    CachedEvent,
    Notification,
    OrganizerClaim,
    OrganizerClaimEvent,
    User,
)
from backend.services import event_revisions
from backend.services.email import send_organizer_claim_notification
from backend.services.event_visibility import apply_event_visibility
from backend.services.notifications import ORGANIZER_ASSIGNED, notify_submitter
from backend.services.user_avatars import resolve_user_avatar

logger = logging.getLogger(__name__)

router = APIRouter(tags=["organizer-claims"])


# --- helpers ---


def _has_social(user: User) -> bool:
    return bool((user.instagram_url or "").strip()) or bool(
        (user.facebook_url or "").strip()
    )


MAX_CLAIM_EVENTS = 20


def _require_profile_ready(user: User) -> None:
    if not (user.bio or "").strip():
        raise HTTPException(
            status_code=422,
            detail="A profile bio is required before submitting an organizer claim",
        )
    if not _has_social(user):
        raise HTTPException(
            status_code=422,
            detail="At least one social link (Instagram or Facebook) is required",
        )


def _check_claimable_events(session: Session, user: User, event_ids: list[str]) -> None:
    statement = select(CachedEvent).where(col(CachedEvent.event_id).in_(event_ids))
    statement = apply_event_visibility(statement, session)
    existing = session.exec(statement).all()
    if len(existing) != len(event_ids):
        raise HTTPException(status_code=404, detail="One or more events not found")
    for ev in existing:
        if ev.owner_user_id == user.id:
            raise HTTPException(
                status_code=409, detail=f"You added “{ev.title}” yourself"
            )
        if ev.organizer_user_id == user.id:
            raise HTTPException(
                status_code=409, detail=f"You already organize “{ev.title}”"
            )
        if ev.organizer_user_id is not None:
            raise HTTPException(
                status_code=409,
                detail=f"“{ev.title}” already has an organizer",
            )


def _pending_claim(session: Session, user: User, kind: str) -> OrganizerClaim | None:
    return session.exec(
        select(OrganizerClaim)
        .where(OrganizerClaim.user_id == user.id)
        .where(OrganizerClaim.kind == kind)
        .where(OrganizerClaim.status == "pending")
    ).first()


def _create_claim(
    session: Session, user: User, kind: str, event_ids: list[str]
) -> OrganizerClaim:
    claim = OrganizerClaim(
        user_id=user.id,
        kind=kind,
        grant_badge=(kind == "badge"),
        status="pending",
    )
    session.add(claim)
    session.flush()
    for eid in event_ids:
        session.add(
            OrganizerClaimEvent(claim_id=claim.id, event_id=eid, decision="pending")
        )
    session.commit()
    session.refresh(claim)
    return claim


def attribute_event(
    session: Session, user: User, event: CachedEvent, *, overwrite: bool
) -> None:
    if event.organizer_user_id and event.organizer_user_id != user.id and not overwrite:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Event {event.event_id} already has an organizer; "
                "pass overwrite=true to reassign"
            ),
        )
    event.organizer_user_id = user.id
    session.add(event)


def mark_organizer_going(session: Session, user: User, event_ids: list[str]) -> None:
    """Public, silent Going so the organizer's profile calendar shows their events."""
    from backend.services.engagement import set_event_engagement

    for eid in event_ids:
        try:
            set_event_engagement(
                session,
                target_user=user,
                event_id=eid,
                kind="going",
                action="add",
                audience="public",
                fan_out=False,
            )
        except Exception:
            logger.exception(
                "Failed to auto-mark organizer going user=%s event=%s", user.id, eid
            )


def _load_events_for_claim(
    session: Session, claim_id: UUID, *, admin: bool = False
) -> list[OrganizerClaimEventOut]:
    rows = session.exec(
        select(OrganizerClaimEvent).where(OrganizerClaimEvent.claim_id == claim_id)
    ).all()
    if not rows:
        return []
    event_ids = {r.event_id for r in rows}
    statement = select(CachedEvent).where(col(CachedEvent.event_id).in_(event_ids))
    if not admin:
        statement = apply_event_visibility(statement, session)
    events = {e.event_id: e for e in session.exec(statement).all()}
    organizer_handles: dict[UUID, str | None] = {}
    competing: dict[str, int] = {}
    if admin:
        organizer_ids = {
            e.organizer_user_id for e in events.values() if e.organizer_user_id
        }
        if organizer_ids:
            organizer_handles = {
                u.id: u.handle
                for u in session.exec(
                    select(User).where(col(User.id).in_(organizer_ids))
                ).all()
            }
        competing = dict(
            session.exec(
                select(OrganizerClaimEvent.event_id, func.count())
                .join(OrganizerClaim, OrganizerClaim.id == OrganizerClaimEvent.claim_id)
                .where(col(OrganizerClaimEvent.event_id).in_(event_ids))
                .where(OrganizerClaimEvent.claim_id != claim_id)
                .where(OrganizerClaim.status == "pending")
                .group_by(OrganizerClaimEvent.event_id)
            ).all()
        )
    out = []
    for r in rows:
        ev = events.get(r.event_id)
        if ev is None:
            continue
        out.append(
            OrganizerClaimEventOut(
                event_id=r.event_id,
                event_title=ev.title,
                event_start=ev.start,
                decision=r.decision,
                current_organizer_handle=(
                    organizer_handles.get(ev.organizer_user_id)
                    if ev.organizer_user_id
                    else None
                ),
                competing_pending_claims=competing.get(r.event_id, 0),
            )
        )
    return out


def _to_out(session: Session, claim: OrganizerClaim) -> OrganizerClaimOut:
    return OrganizerClaimOut(
        id=claim.id,
        user_id=claim.user_id,
        kind=claim.kind,
        status=claim.status,
        admin_notes=claim.admin_notes,
        reviewed_at=claim.reviewed_at,
        reviewed_by=claim.reviewed_by,
        created_at=claim.created_at,
        events=_load_events_for_claim(session, claim.id),
    )


def _to_admin_out(
    session: Session, claim: OrganizerClaim, user: User | None
) -> OrganizerClaimAdminOut:
    return OrganizerClaimAdminOut(
        id=claim.id,
        user_id=claim.user_id,
        kind=claim.kind,
        status=claim.status,
        admin_notes=claim.admin_notes,
        reviewed_at=claim.reviewed_at,
        reviewed_by=claim.reviewed_by,
        created_at=claim.created_at,
        events=_load_events_for_claim(session, claim.id, admin=True),
        user_handle=user.handle if user else None,
        user_display_name=user.display_name if user else None,
        user_email=user.email if user else None,
        user_avatar_url=resolve_user_avatar(user) if user else None,
        user_bio=user.bio if user else None,
        user_instagram_url=user.instagram_url if user else None,
        user_facebook_url=user.facebook_url if user else None,
        user_created_at=user.created_at if user else None,
        user_is_verified_organizer=bool(user and user.is_verified_organizer),
        user_organized_count=(
            session.exec(
                select(func.count())
                .select_from(CachedEvent)
                .where(CachedEvent.organizer_user_id == user.id)
                .where(CachedEvent.deleted_at.is_(None))  # type: ignore[union-attr]
            ).one()
            if user
            else 0
        ),
    )


def _notify_admin_claim(claim_id: UUID) -> None:
    """Background task: email admin about a new organizer claim."""
    from backend.db.database import get_engine
    from sqlmodel import Session as SyncSession

    admin_email = get_admin_email()
    if not admin_email:
        return
    engine = get_engine()
    with SyncSession(engine) as session:
        claim = session.get(OrganizerClaim, claim_id)
        if not claim:
            return
        user = session.get(User, claim.user_id)
        event_count = len(
            session.exec(
                select(OrganizerClaimEvent).where(
                    OrganizerClaimEvent.claim_id == claim_id
                )
            ).all()
        )
        if user is not None:
            parts = [
                user.display_name or "",
                f"@{user.handle}" if user.handle else "",
                f"({user.email})",
            ]
            label = " ".join(p for p in parts if p).strip()
        else:
            label = "Unknown user"
        send_organizer_claim_notification(claim, label, event_count, admin_email)


# --- User endpoints ---


@router.post(
    "/api/me/organizer-claims",
    response_model=OrganizerClaimOut,
    status_code=201,
    dependencies=[Depends(require_flag("organizer_claims_enabled"))],
)
def submit_organizer_claim(
    body: OrganizerClaimCreate,
    background_tasks: BackgroundTasks,
    session: Session = Depends(get_session),
    user: User = Depends(require_user),
):
    """Open a new organizer claim.

    - ``kind="badge"``: verified-organizer request, optionally with up to
      20 events decided in the same review. Requires bio + ≥1 social link.
      Rejected if the user is already verified or has a pending badge claim.
    - ``kind="events"``: per-event organizer attribution for already
      verified users. Requires 1..20 events.

    Events must be visible, not added by the claimant, and not attributed
    to an organizer yet.
    """
    kind = (body.kind or "badge").lower()
    if kind not in ("badge", "events"):
        raise HTTPException(status_code=422, detail="kind must be 'badge' or 'events'")

    event_ids = list(dict.fromkeys(eid for eid in body.event_ids if eid))

    if kind == "badge":
        if user.is_verified_organizer:
            raise HTTPException(
                status_code=409,
                detail="You are already a verified organizer",
            )
        _require_profile_ready(user)
    else:  # kind == "events"
        if not user.is_verified_organizer:
            raise HTTPException(
                status_code=409,
                detail="Only verified organizers can submit event claims",
            )
        if not event_ids:
            raise HTTPException(
                status_code=422,
                detail="At least one event is required for an events claim",
            )
    if event_ids:
        _check_claimable_events(session, user, event_ids)

    if _pending_claim(session, user, kind) is not None:
        raise HTTPException(
            status_code=409,
            detail=f"You already have a pending {kind} claim",
        )

    claim = _create_claim(session, user, kind, event_ids)
    background_tasks.add_task(_notify_admin_claim, claim.id)
    return _to_out(session, claim)


@router.post(
    "/api/me/organizer-claims/events",
    response_model=OrganizerClaimOut,
    dependencies=[Depends(require_flag("organizer_claims_enabled"))],
)
def add_events_to_my_claim(
    body: OrganizerClaimEventsAdd,
    background_tasks: BackgroundTasks,
    session: Session = Depends(get_session),
    user: User = Depends(require_user),
):
    """Claim events: append to the open request, or open one if none is pending."""
    event_ids = list(dict.fromkeys(eid for eid in body.event_ids if eid))
    if not event_ids:
        raise HTTPException(status_code=422, detail="At least one event is required")
    _check_claimable_events(session, user, event_ids)
    kind = "events" if user.is_verified_organizer else "badge"
    claim = _pending_claim(session, user, kind)
    if claim is None:
        if kind == "badge":
            _require_profile_ready(user)
        claim = _create_claim(session, user, kind, event_ids)
        background_tasks.add_task(_notify_admin_claim, claim.id)
        return _to_out(session, claim)

    existing = set(
        session.exec(
            select(OrganizerClaimEvent.event_id).where(
                OrganizerClaimEvent.claim_id == claim.id
            )
        ).all()
    )
    new_ids = [eid for eid in event_ids if eid not in existing]
    if len(existing) + len(new_ids) > MAX_CLAIM_EVENTS:
        raise HTTPException(
            status_code=422,
            detail=f"A request can include at most {MAX_CLAIM_EVENTS} events",
        )
    for eid in new_ids:
        session.add(
            OrganizerClaimEvent(claim_id=claim.id, event_id=eid, decision="pending")
        )
    claim.updated_at = datetime.now(timezone.utc)
    session.add(claim)
    session.commit()
    session.refresh(claim)
    return _to_out(session, claim)


@router.delete(
    "/api/me/organizer-claims/{claim_id}/events/{event_id}",
    status_code=204,
    dependencies=[Depends(require_flag("organizer_claims_enabled"))],
)
def remove_event_from_my_claim(
    claim_id: UUID,
    event_id: str,
    session: Session = Depends(get_session),
    user: User = Depends(require_user),
):
    claim = session.get(OrganizerClaim, claim_id)
    if not claim or claim.user_id != user.id:
        raise HTTPException(status_code=404, detail="Claim not found")
    if claim.status != "pending":
        raise HTTPException(
            status_code=400, detail="Only pending claims can be changed"
        )
    line = session.exec(
        select(OrganizerClaimEvent)
        .where(OrganizerClaimEvent.claim_id == claim.id)
        .where(OrganizerClaimEvent.event_id == event_id)
    ).first()
    if line is None:
        raise HTTPException(status_code=404, detail="Event not in this claim")
    session.delete(line)
    session.flush()
    remaining = session.exec(
        select(func.count()).where(OrganizerClaimEvent.claim_id == claim.id)
    ).one()
    # An events claim without events has nothing left to review.
    if claim.kind == "events" and remaining == 0:
        session.delete(claim)
    session.commit()


@router.get(
    "/api/me/organizer-claims",
    response_model=list[OrganizerClaimOut],
    dependencies=[Depends(require_flag("organizer_claims_enabled"))],
)
def list_my_organizer_claims(
    kind: str | None = Query(default=None),
    session: Session = Depends(get_session),
    user: User = Depends(require_user),
):
    q = (
        select(OrganizerClaim)
        .where(OrganizerClaim.user_id == user.id)
        .order_by(col(OrganizerClaim.created_at).desc())
    )
    if kind:
        q = q.where(OrganizerClaim.kind == kind)
    rows = session.exec(q).all()
    return [_to_out(session, c) for c in rows]


@router.delete(
    "/api/me/organizer-claims/{claim_id}",
    status_code=204,
    dependencies=[Depends(require_flag("organizer_claims_enabled"))],
)
def cancel_my_organizer_claim(
    claim_id: UUID,
    session: Session = Depends(get_session),
    user: User = Depends(require_user),
):
    claim = session.get(OrganizerClaim, claim_id)
    if not claim or claim.user_id != user.id:
        raise HTTPException(status_code=404, detail="Claim not found")
    if claim.status != "pending":
        raise HTTPException(
            status_code=400, detail="Only pending claims can be cancelled"
        )
    # cascade delete via OrganizerClaimEvent FK (ondelete=CASCADE).
    session.delete(claim)
    session.commit()


# --- Admin endpoints (not behind feature flag) ---


@router.get(
    "/api/admin/organizer-claims",
    response_model=list[OrganizerClaimAdminOut],
)
def admin_list_organizer_claims(
    status: str | None = Query(default=None),
    kind: str | None = Query(default=None),
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    q = select(OrganizerClaim).order_by(col(OrganizerClaim.created_at).desc())
    if status:
        q = q.where(OrganizerClaim.status == status)
    if kind:
        q = q.where(OrganizerClaim.kind == kind)
    rows = session.exec(q).all()
    if not rows:
        return []
    user_ids = {r.user_id for r in rows}
    users = {
        u.id: u
        for u in session.exec(select(User).where(col(User.id).in_(user_ids))).all()
    }
    return [_to_admin_out(session, r, users.get(r.user_id)) for r in rows]


@router.get(
    "/api/admin/organizer-claims/{claim_id}",
    response_model=OrganizerClaimAdminOut,
)
def admin_get_organizer_claim(
    claim_id: UUID,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    claim = session.get(OrganizerClaim, claim_id)
    if not claim:
        raise HTTPException(status_code=404, detail="Claim not found")
    user = session.get(User, claim.user_id)
    return _to_admin_out(session, claim, user)


@router.post(
    "/api/admin/organizer-claims/{claim_id}/decide",
    response_model=OrganizerClaimAdminOut,
)
def admin_decide_claim(
    claim_id: UUID,
    body: OrganizerClaimDecideRequest,
    session: Session = Depends(get_session),
    admin: dict = Depends(require_admin),
):
    """Atomic decision: per-event decisions + (badge claims only) badge flip.

    Approved events are attributed to the claimant, who is also marked
    publicly Going on them. ``grant_badge`` is ignored for events claims.
    On badge claims, events are decided only when the badge is granted.
    """
    claim = session.get(OrganizerClaim, claim_id)
    if not claim:
        raise HTTPException(status_code=404, detail="Claim not found")

    user = session.get(User, claim.user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="Claimant not found")

    is_events_claim = claim.kind == "events"
    is_badge_claim = claim.kind == "badge"
    grant_badge_now = is_badge_claim and body.grant_badge

    line_items = session.exec(
        select(OrganizerClaimEvent).where(OrganizerClaimEvent.claim_id == claim.id)
    ).all()
    claim_event_ids = {li.event_id for li in line_items}
    # Events on a badge claim are only decided when the badge is granted;
    # a rejected badge rejects all of them.
    decide_events = bool(line_items) and (is_events_claim or grant_badge_now)

    if decide_events:
        approved_ids = set(body.approved_event_ids)
        rejected_ids = set(body.rejected_event_ids)
    else:
        approved_ids = set()
        rejected_ids = claim_event_ids if is_badge_claim else set()
    if approved_ids & rejected_ids:
        raise HTTPException(
            status_code=422,
            detail="An event cannot be both approved and rejected",
        )
    unknown = (approved_ids | rejected_ids) - claim_event_ids
    if unknown:
        raise HTTPException(
            status_code=422,
            detail=f"Events not part of this claim: {sorted(unknown)}",
        )

    auto_going_event_ids: list[str] = []
    for li in line_items:
        if li.event_id in approved_ids:
            li.decision = "approved"
            ev = session.get(CachedEvent, li.event_id)
            if ev is not None:
                attribute_event(session, user, ev, overwrite=body.overwrite)
                auto_going_event_ids.append(li.event_id)
            session.add(li)
        elif li.event_id in rejected_ids:
            li.decision = "rejected"
            session.add(li)

    if grant_badge_now:
        user.is_verified_organizer = True
        session.add(user)

    if decide_events:
        if is_events_claim and not approved_ids and not rejected_ids:
            raise HTTPException(status_code=422, detail="No decision specified")
        if any(li.decision == "pending" for li in line_items):
            raise HTTPException(
                status_code=422,
                detail="Every event in the claim must be approved or rejected",
            )
    granted_something = bool(approved_ids) if is_events_claim else body.grant_badge

    claim.status = "approved" if granted_something else "rejected"
    claim.admin_notes = body.admin_notes
    claim.reviewed_at = datetime.now(timezone.utc)
    claim.reviewed_by = admin.get("email")
    claim.updated_at = datetime.now(timezone.utc)
    session.add(claim)

    # Silent (no follower fan-out) so bulk approvals don't spam followers.
    if auto_going_event_ids:
        mark_organizer_going(session, user, auto_going_event_ids)

    # In-app notification (free-string kind). A prior decision row may
    # already exist for this user — the ``uq_notif_no_event`` partial
    # unique index (recipient, kind, actor WHERE event_id IS NULL)
    # would otherwise raise IntegrityError on re-decision. Delete the
    # old notification first so the latest decision is what the user
    # sees in their notifications panel.
    existing = session.exec(
        select(Notification)
        .where(Notification.recipient_user_id == claim.user_id)
        .where(Notification.actor_user_id == claim.user_id)
        .where(Notification.kind == "organizer_claim_decided")
        .where(Notification.event_id.is_(None))  # type: ignore[union-attr]
    ).all()
    for n in existing:
        session.delete(n)
    session.flush()
    session.add(
        Notification(
            recipient_user_id=claim.user_id,
            actor_user_id=claim.user_id,
            kind="organizer_claim_decided",
            context=claim.status,
            description=(
                claim.admin_notes[:255]
                if claim.status == "rejected" and claim.admin_notes
                else None
            ),
        )
    )

    session.commit()
    session.refresh(claim)
    return _to_admin_out(session, claim, user)


@router.put(
    "/api/admin/events/{event_id}/organizer",
    response_model=AdminEventOrganizerOut,
)
def admin_set_event_organizer(
    event_id: str,
    body: AdminEventOrganizerUpdate,
    session: Session = Depends(get_session),
    admin: dict = Depends(require_admin),
):
    """Attribute an event to a user (or clear it). Assigning also verifies the user."""
    event = session.get(CachedEvent, event_id)
    if event is None or event.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Event not found")
    if body.user_id is None:
        event.organizer_user_id = None
        session.add(event)
        session.commit()
        return AdminEventOrganizerOut(event_id=event_id, organizer=None)
    user = session.get(User, body.user_id)
    if user is None or user.deleted_at is not None:
        raise HTTPException(status_code=404, detail="User not found")
    newly_assigned = event.organizer_user_id != user.id
    attribute_event(session, user, event, overwrite=True)
    if not user.is_verified_organizer:
        user.is_verified_organizer = True
        session.add(user)
    mark_organizer_going(session, user, [event_id])
    if newly_assigned:
        notify_organizer_assigned(session, user, [event], admin.get("email"))
    session.commit()
    return AdminEventOrganizerOut(
        event_id=event_id,
        organizer=EventOrganizerMini(
            user_id=user.id,
            handle=user.handle,
            display_name=user.display_name,
            avatar_url=resolve_user_avatar(user),
            is_verified_organizer=user.is_verified_organizer,
        ),
    )


def notify_organizer_assigned(
    session: Session,
    user: User,
    events: list[CachedEvent],
    admin_email: str | None,
) -> None:
    """One in-app notice per admin save: the event, an event count, or the badge alone."""
    single = events[0] if len(events) == 1 else None
    notify_submitter(
        session,
        user,
        ORGANIZER_ASSIGNED,
        subject_key=f"organizer:{uuid4().hex}",
        actor=event_revisions.admin_actor(session, admin_email),
        event_id=single.event_id if single else None,
        context=single.title
        if single
        else (f"{len(events)} events" if events else None),
    )


def _organized_events(session: Session, user_id: UUID) -> list[OrganizedEventOut]:
    rows = session.exec(
        select(CachedEvent)
        .where(CachedEvent.organizer_user_id == user_id)
        .where(CachedEvent.deleted_at.is_(None))  # type: ignore[union-attr]
        .order_by(col(CachedEvent.start).desc())
    ).all()
    return [
        OrganizedEventOut(
            event_id=e.event_id, title=e.title, start=e.start, city=e.city
        )
        for e in rows
    ]


@router.put(
    "/api/admin/users/id/{user_id}/organizer",
    response_model=AdminUserOrganizerOut,
)
def admin_update_user_organizer(
    user_id: UUID,
    body: AdminUserOrganizerUpdate,
    session: Session = Depends(get_session),
    admin: dict = Depends(require_admin),
):
    """Apply an admin's staged organizer edits for one user and notify them once."""
    user = session.get(User, user_id)
    if user is None or user.deleted_at is not None:
        raise HTTPException(status_code=404, detail="User not found")
    add_ids = list(dict.fromkeys(body.add_event_ids))
    remove_ids = set(body.remove_event_ids) - set(add_ids)
    to_add = (
        session.exec(
            select(CachedEvent).where(col(CachedEvent.event_id).in_(add_ids))
        ).all()
        if add_ids
        else []
    )
    if len(to_add) != len(add_ids) or any(e.deleted_at is not None for e in to_add):
        raise HTTPException(status_code=404, detail="One or more events not found")
    if remove_ids:
        for event in session.exec(
            select(CachedEvent).where(col(CachedEvent.event_id).in_(remove_ids))
        ).all():
            if event.organizer_user_id == user.id:
                event.organizer_user_id = None
                session.add(event)
    newly = [e for e in to_add if e.organizer_user_id != user.id]
    for event in newly:
        attribute_event(session, user, event, overwrite=True)
    was_verified = user.is_verified_organizer
    user.is_verified_organizer = body.is_verified_organizer or bool(newly)
    session.add(user)
    if newly:
        mark_organizer_going(session, user, [e.event_id for e in newly])
    if newly or (user.is_verified_organizer and not was_verified):
        notify_organizer_assigned(session, user, newly, admin.get("email"))
    session.commit()
    return AdminUserOrganizerOut(
        is_verified_organizer=user.is_verified_organizer,
        events=_organized_events(session, user.id),
    )


@router.get(
    "/api/admin/users/id/{user_id}/organized-events",
    response_model=list[OrganizedEventOut],
)
def admin_list_organized_events(
    user_id: UUID,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    return _organized_events(session, user_id)
