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
from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from sqlmodel import Session, col, select

from backend.api.deps import require_admin, require_flag, require_user
from backend.api.schemas import (
    OrganizerClaimAdminOut,
    OrganizerClaimCreate,
    OrganizerClaimDecideRequest,
    OrganizerClaimEventOut,
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
from backend.services.email import send_organizer_claim_notification

logger = logging.getLogger(__name__)

router = APIRouter(tags=["organizer-claims"])


# --- helpers ---


def _has_social(user: User) -> bool:
    return bool((user.instagram_url or "").strip()) or bool(
        (user.facebook_url or "").strip()
    )


def _load_events_for_claim(
    session: Session, claim_id: UUID
) -> list[OrganizerClaimEventOut]:
    rows = session.exec(
        select(OrganizerClaimEvent).where(OrganizerClaimEvent.claim_id == claim_id)
    ).all()
    if not rows:
        return []
    event_ids = {r.event_id for r in rows}
    events = {
        e.event_id: e
        for e in session.exec(
            select(CachedEvent).where(col(CachedEvent.event_id).in_(event_ids))
        ).all()
    }
    return [
        OrganizerClaimEventOut(
            event_id=r.event_id,
            event_title=events[r.event_id].title if r.event_id in events else None,
            event_start=events[r.event_id].start if r.event_id in events else None,
            decision=r.decision,
        )
        for r in rows
    ]


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
        events=_load_events_for_claim(session, claim.id),
        user_handle=user.handle if user else None,
        user_display_name=user.display_name if user else None,
        user_email=user.email if user else None,
        user_avatar_url=user.avatar_url if user else None,
        user_bio=user.bio if user else None,
        user_instagram_url=user.instagram_url if user else None,
        user_facebook_url=user.facebook_url if user else None,
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

    Two flavours:

    - ``kind="badge"``: account-level verified-organizer request.
      Requires bio + ≥1 social link. Rejected if the user is already
      verified or has a pending badge claim. ``event_ids`` must be empty.
    - ``kind="events"``: per-event organizer attribution. Requires the
      user to be already verified and 1..20 events. Each event must
      exist and not be soft-deleted; pre-existing organizer attribution
      to a different user is allowed at submission time but enforced
      again at admin-decide via the overwrite guard.
    """
    kind = (body.kind or "badge").lower()
    if kind not in ("badge", "events"):
        raise HTTPException(status_code=422, detail="kind must be 'badge' or 'events'")

    event_ids = list({eid for eid in body.event_ids if eid})

    if kind == "badge":
        if user.is_verified_organizer:
            raise HTTPException(
                status_code=409,
                detail="You are already a verified organizer",
            )
        if event_ids:
            raise HTTPException(
                status_code=422,
                detail="Badge claims cannot include events; submit an 'events' claim after approval",
            )
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
        existing = session.exec(
            select(CachedEvent).where(col(CachedEvent.event_id).in_(event_ids))
        ).all()
        if len(existing) != len(event_ids):
            raise HTTPException(
                status_code=404,
                detail="One or more events not found",
            )

    # Block multiple in-flight claims of the same kind.
    pending = session.exec(
        select(OrganizerClaim)
        .where(OrganizerClaim.user_id == user.id)
        .where(OrganizerClaim.kind == kind)
        .where(OrganizerClaim.status == "pending")
    ).first()
    if pending is not None:
        raise HTTPException(
            status_code=409,
            detail=f"You already have a pending {kind} claim",
        )

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

    background_tasks.add_task(_notify_admin_claim, claim.id)
    return _to_out(session, claim)


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

    For ``kind="events"`` claims, also marks the submitter as Going
    (public visibility) on each approved event so the organizer's own
    calendar reflects what they organize. ``grant_badge`` in the
    request body is ignored for events claims; per-event decisions are
    ignored for badge claims.
    """
    claim = session.get(OrganizerClaim, claim_id)
    if not claim:
        raise HTTPException(status_code=404, detail="Claim not found")

    user = session.get(User, claim.user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="Claimant not found")

    is_events_claim = claim.kind == "events"
    is_badge_claim = claim.kind == "badge"

    approved_ids = set(body.approved_event_ids) if is_events_claim else set()
    rejected_ids = set(body.rejected_event_ids) if is_events_claim else set()
    overlap = approved_ids & rejected_ids
    if overlap:
        raise HTTPException(
            status_code=422,
            detail="An event cannot be both approved and rejected",
        )

    line_items = session.exec(
        select(OrganizerClaimEvent).where(OrganizerClaimEvent.claim_id == claim.id)
    ).all()
    claim_event_ids = {li.event_id for li in line_items}
    if is_events_claim:
        unknown = (approved_ids | rejected_ids) - claim_event_ids
        if unknown:
            raise HTTPException(
                status_code=422,
                detail=f"Events not part of this claim: {sorted(unknown)}",
            )

    # Apply per-event decisions (events claims only).
    auto_going_event_ids: list[str] = []
    if is_events_claim:
        for li in line_items:
            if li.event_id in approved_ids:
                li.decision = "approved"
                ev = session.get(CachedEvent, li.event_id)
                if ev is not None:
                    if (
                        ev.organizer_user_id
                        and ev.organizer_user_id != user.id
                        and not body.overwrite
                    ):
                        raise HTTPException(
                            status_code=409,
                            detail=(
                                f"Event {li.event_id} already has an organizer; "
                                "pass overwrite=true to reassign"
                            ),
                        )
                    ev.organizer_user_id = user.id
                    session.add(ev)
                    auto_going_event_ids.append(li.event_id)
                session.add(li)
            elif li.event_id in rejected_ids:
                li.decision = "rejected"
                session.add(li)

    # Account badge (badge claims only). ``grant_badge`` in the body is
    # ignored on events claims; the kind is the source of truth.
    grant_badge_now = is_badge_claim and body.grant_badge
    if grant_badge_now:
        user.is_verified_organizer = True
        session.add(user)

    # Validate the admin sent a complete decision and roll up status.
    if is_events_claim:
        if not approved_ids and not rejected_ids:
            raise HTTPException(status_code=422, detail="No decision specified")
        decisions = {li.decision for li in line_items}
        if "pending" in decisions:
            raise HTTPException(
                status_code=422,
                detail="Every event in the claim must be approved or rejected",
            )
        granted_something = bool(approved_ids)
    else:  # badge claim
        if not body.grant_badge and not body.admin_notes:
            # An explicit reject still needs a signal; require either
            # grant_badge=true (approve) or grant_badge=false + notes
            # (reject) — but to stay backwards-compatible with admins
            # that simply send grant_badge=false, accept that as reject.
            pass
        granted_something = body.grant_badge

    claim.status = "approved" if granted_something else "rejected"
    claim.admin_notes = body.admin_notes
    claim.reviewed_at = datetime.utcnow()
    claim.reviewed_by = admin.get("email")
    claim.updated_at = datetime.utcnow()
    session.add(claim)

    # Auto-going for the organizer on each approved event. Public
    # audience so the organizer's profile calendar / share page show
    # the event. ``fan_out=False`` keeps approvals silent — admins
    # shouldn't notify the organizer's followers in bulk.
    if auto_going_event_ids:
        from backend.services.engagement import set_event_engagement

        for eid in auto_going_event_ids:
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
                    "Failed to auto-mark organizer going for claim=%s event=%s",
                    claim.id,
                    eid,
                )

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
        )
    )

    session.commit()
    session.refresh(claim)
    return _to_admin_out(session, claim, user)
