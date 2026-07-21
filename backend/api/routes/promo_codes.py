"""User-submitted promo codes attached to events.

Sign-in required. Admin-moderated. Feature-flagged via the
``promo_codes_enabled`` site setting.

See plan in [docs] memory and reference pattern in
[backend/api/routes/suggestions.py](../routes/suggestions.py).
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from slowapi import Limiter
from sqlmodel import Session, col, select

from backend.api.deps import (
    get_current_user_optional,
    require_admin,
    require_promo_codes_enabled_for_event,
    require_user,
)
from backend.api.rate_limit import client_ip
from backend.api.schemas import (
    PromoCodeAdminOut,
    PromoCodeCreate,
    PromoCodeOut,
    PromoCodeReject,
    PromoCodeSubmitter,
    PromoCodeUpdate,
)
from backend.config.loader import get_admin_email
from backend.db.database import get_session
from backend.db.models import (
    CachedEvent,
    EventPromoCode,
    Notification,
    User,
    UserEventAttendance,
    UserSavedEvent,
)
from backend.services.email import (
    send_promo_code_added_email,
    send_promo_code_notification,
)
from backend.services.notification_delivery import record_delivery

logger = logging.getLogger(__name__)

router = APIRouter(tags=["promo-codes"])
limiter = Limiter(key_func=client_ip)

PROMO_CODE_ADDED = "promo_code_added"


# --- helpers ---


def _submitter_payload(user: User) -> PromoCodeSubmitter:
    return PromoCodeSubmitter(
        user_id=user.id,
        handle=user.handle,
        display_name=user.display_name,
        avatar_url=user.avatar_url,
    )


def _to_out(promo: EventPromoCode, submitter: User) -> PromoCodeOut:
    return PromoCodeOut(
        id=promo.id,
        event_id=promo.event_id,
        code=promo.code,
        description=promo.description,
        source_url=promo.source_url,
        expires_at=promo.expires_at,
        status=promo.status,
        submitter=_submitter_payload(submitter),
        created_at=promo.created_at,
        updated_at=promo.updated_at,
    )


def _to_admin_out(
    promo: EventPromoCode, submitter: User, event_title: Optional[str]
) -> PromoCodeAdminOut:
    return PromoCodeAdminOut(
        id=promo.id,
        event_id=promo.event_id,
        code=promo.code,
        description=promo.description,
        source_url=promo.source_url,
        expires_at=promo.expires_at,
        status=promo.status,
        submitter=_submitter_payload(submitter),
        created_at=promo.created_at,
        updated_at=promo.updated_at,
        admin_notes=promo.admin_notes,
        reviewed_at=promo.reviewed_at,
        reviewed_by=promo.reviewed_by,
        event_title=event_title,
    )


def _notify_admin_promo(promo_id: UUID) -> None:
    """Background task: email admin about a new/re-edited promo code."""
    from backend.db.database import get_engine
    from sqlmodel import Session as SyncSession

    admin_email = get_admin_email()
    if not admin_email:
        return
    engine = get_engine()
    with SyncSession(engine) as session:
        promo = session.get(EventPromoCode, promo_id)
        if not promo:
            return
        event = session.get(CachedEvent, promo.event_id)
        submitter = session.get(User, promo.submitter_user_id)
        event_title = event.title if event else promo.event_id
        if submitter is not None:
            label_parts = [
                submitter.display_name or "",
                f"@{submitter.handle}" if submitter.handle else "",
                f"({submitter.email})",
            ]
            submitter_label = " ".join(p for p in label_parts if p).strip()
        else:
            submitter_label = "Unknown user"
        send_promo_code_notification(promo, event_title, submitter_label, admin_email)


def _notify_submitter(session: Session, promo: EventPromoCode, kind: str) -> None:
    """Insert an in-app notification row for the submitter. No commit."""
    notif = Notification(
        recipient_user_id=promo.submitter_user_id,
        actor_user_id=promo.submitter_user_id,
        kind=kind,
        event_id=promo.event_id,
    )
    session.add(notif)


def _fan_out_saved_event_promo_code(
    session: Session, promo: EventPromoCode
) -> list[UUID]:
    """Insert in-app ``promo_code_added`` rows for users who saved this
    event, excluding the submitter and anyone also "Going" to it. No
    commit — caller owns the transaction. Returns newly-notified user ids
    (for the caller to enqueue email/push delivery).
    """
    saved_user_ids = set(
        session.exec(
            select(UserSavedEvent.user_id)
            .where(UserSavedEvent.event_id == promo.event_id)
            .where(col(UserSavedEvent.user_id).is_not(None))
        ).all()
    )
    if not saved_user_ids:
        return []
    going_user_ids = set(
        session.exec(
            select(UserEventAttendance.user_id)
            .where(UserEventAttendance.event_id == promo.event_id)
            .where(col(UserEventAttendance.user_id).is_not(None))
        ).all()
    )
    already_notified = set(
        session.exec(
            select(Notification.recipient_user_id)
            .where(Notification.kind == PROMO_CODE_ADDED)
            .where(Notification.event_id == promo.event_id)
        ).all()
    )
    recipients = (
        saved_user_ids - going_user_ids - already_notified - {promo.submitter_user_id}
    )
    for recipient_id in recipients:
        notif = Notification(
            recipient_user_id=recipient_id,
            actor_user_id=recipient_id,
            kind=PROMO_CODE_ADDED,
            event_id=promo.event_id,
            context=promo.code,
        )
        session.add(notif)
        session.flush()
        record_delivery(session, notif.id, "app")
    return list(recipients)


def _send_promo_code_added_notifications(
    promo_id: UUID, recipient_ids: list[UUID]
) -> None:
    """Background task: email/push the users fanned out to by
    ``_fan_out_saved_event_promo_code``. Own session; stamps
    ``emailed_at``/``pushed_at`` and records deliveries for channels that
    actually send, same durability convention as ``reminder_service.py``.
    """
    from backend.db.database import get_engine
    from backend.services.push_service import send_push
    from sqlmodel import Session as SyncSession

    if not recipient_ids:
        return
    engine = get_engine()
    with SyncSession(engine) as session:
        promo = session.get(EventPromoCode, promo_id)
        if not promo:
            return
        event = session.get(CachedEvent, promo.event_id)
        notifs = session.exec(
            select(Notification)
            .where(Notification.kind == PROMO_CODE_ADDED)
            .where(Notification.event_id == promo.event_id)
            .where(col(Notification.recipient_user_id).in_(recipient_ids))
        ).all()
        notif_by_user = {n.recipient_user_id: n for n in notifs}
        users = session.exec(select(User).where(col(User.id).in_(recipient_ids))).all()
        stamp_now = datetime.utcnow()
        for user in users:
            notif = notif_by_user.get(user.id)
            if notif is None:
                continue
            if user.email_promo_codes_enabled and send_promo_code_added_email(
                user, event, promo
            ):
                notif.emailed_at = stamp_now
                record_delivery(session, notif.id, "email", stamp_now)
            if user.push_promo_codes_enabled:
                delivered = send_push(
                    user.id,
                    title="New promo code",
                    body=f"{(event.title if event else 'An event')} has a new promo code: {promo.code}",
                    url=f"/event/{promo.event_id}",
                    tag=f"promo:{promo.event_id}",
                )
                if delivered:
                    notif.pushed_at = stamp_now
                    record_delivery(session, notif.id, "push", stamp_now)
            session.add(notif)
        session.commit()


# --- Public endpoints ---


@router.get(
    "/api/events/{event_id}/promo-codes",
    response_model=list[PromoCodeOut],
    dependencies=[Depends(require_promo_codes_enabled_for_event)],
)
def list_event_promo_codes(
    event_id: str,
    session: Session = Depends(get_session),
    current_user: User | None = Depends(get_current_user_optional),
):
    """Approved + non-expired codes, plus the viewer's own pending rows."""
    now = datetime.utcnow()
    conditions = [
        (EventPromoCode.status == "approved")
        & (
            (col(EventPromoCode.expires_at).is_(None))
            | (EventPromoCode.expires_at > now)
        )
    ]
    if current_user is not None:
        conditions.append(
            (EventPromoCode.status == "pending")
            & (EventPromoCode.submitter_user_id == current_user.id)
        )
    where_expr = conditions[0]
    for cond in conditions[1:]:
        where_expr = where_expr | cond

    rows = session.exec(
        select(EventPromoCode)
        .where(EventPromoCode.event_id == event_id)
        .where(where_expr)
        .order_by(col(EventPromoCode.created_at).desc())
    ).all()

    if not rows:
        return []

    submitter_ids = {r.submitter_user_id for r in rows}
    users = session.exec(select(User).where(col(User.id).in_(submitter_ids))).all()
    by_id = {u.id: u for u in users}
    return [
        _to_out(r, by_id[r.submitter_user_id])
        for r in rows
        if r.submitter_user_id in by_id
    ]


@router.post(
    "/api/events/{event_id}/promo-codes",
    response_model=PromoCodeOut,
    status_code=201,
    dependencies=[Depends(require_promo_codes_enabled_for_event)],
)
def submit_promo_code(
    event_id: str,
    body: PromoCodeCreate,
    background_tasks: BackgroundTasks,
    session: Session = Depends(get_session),
    user: User = Depends(require_user),
):
    """Authenticated submission of a new promo code (admin-moderated)."""
    event = session.get(CachedEvent, event_id)
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    # Reject duplicate non-rejected codes for the same event (matches the
    # partial unique index; check up-front for a friendlier error than 500).
    code_norm = body.code.strip()
    if not code_norm:
        raise HTTPException(status_code=422, detail="Code cannot be empty")

    existing = session.exec(
        select(EventPromoCode)
        .where(EventPromoCode.event_id == event_id)
        .where(EventPromoCode.status != "rejected")
    ).all()
    for row in existing:
        if row.code.lower() == code_norm.lower():
            raise HTTPException(
                status_code=409,
                detail="A promo code with this value already exists for this event",
            )

    promo = EventPromoCode(
        event_id=event_id,
        code=code_norm,
        description=body.description,
        source_url=body.source_url,
        expires_at=body.expires_at,
        submitter_user_id=user.id,
        status="pending",
    )
    session.add(promo)
    session.commit()
    session.refresh(promo)

    background_tasks.add_task(_notify_admin_promo, promo.id)
    return _to_out(promo, user)


@router.patch(
    "/api/events/{event_id}/promo-codes/{promo_id}",
    response_model=PromoCodeOut,
    dependencies=[Depends(require_promo_codes_enabled_for_event)],
)
def update_promo_code(
    event_id: str,
    promo_id: UUID,
    body: PromoCodeUpdate,
    background_tasks: BackgroundTasks,
    session: Session = Depends(get_session),
    user: User = Depends(require_user),
):
    """Owner or admin edit. Owner edits revert status to pending."""
    promo = session.get(EventPromoCode, promo_id)
    if not promo or promo.event_id != event_id:
        raise HTTPException(status_code=404, detail="Promo code not found")

    admin_email = get_admin_email()
    is_admin = bool(admin_email) and user.email == admin_email
    is_owner = promo.submitter_user_id == user.id
    if not (is_admin or is_owner):
        raise HTTPException(status_code=403, detail="Not allowed")

    data = body.model_dump(exclude_unset=True)
    if "code" in data and data["code"] is not None:
        new_code = data["code"].strip()
        if not new_code:
            raise HTTPException(status_code=422, detail="Code cannot be empty")
        # duplicate check against other non-rejected rows
        rows = session.exec(
            select(EventPromoCode)
            .where(EventPromoCode.event_id == event_id)
            .where(EventPromoCode.status != "rejected")
            .where(EventPromoCode.id != promo.id)
        ).all()
        for row in rows:
            if row.code.lower() == new_code.lower():
                raise HTTPException(
                    status_code=409,
                    detail="A promo code with this value already exists for this event",
                )
        promo.code = new_code
        data.pop("code")

    for field, value in data.items():
        setattr(promo, field, value)

    promo.updated_at = datetime.utcnow()

    re_review = False
    if is_owner and not is_admin and promo.status == "approved":
        promo.status = "pending"
        promo.reviewed_at = None
        promo.reviewed_by = None
        re_review = True

    session.add(promo)
    session.commit()
    session.refresh(promo)

    if re_review:
        background_tasks.add_task(_notify_admin_promo, promo.id)

    submitter = session.get(User, promo.submitter_user_id) or user
    return _to_out(promo, submitter)


@router.delete(
    "/api/events/{event_id}/promo-codes/{promo_id}",
    status_code=204,
    dependencies=[Depends(require_promo_codes_enabled_for_event)],
)
def delete_promo_code(
    event_id: str,
    promo_id: UUID,
    session: Session = Depends(get_session),
    user: User = Depends(require_user),
):
    promo = session.get(EventPromoCode, promo_id)
    if not promo or promo.event_id != event_id:
        raise HTTPException(status_code=404, detail="Promo code not found")

    admin_email = get_admin_email()
    is_admin = bool(admin_email) and user.email == admin_email
    is_owner = promo.submitter_user_id == user.id
    if not (is_admin or is_owner):
        raise HTTPException(status_code=403, detail="Not allowed")

    if is_owner and not is_admin:
        session.delete(promo)
    else:
        promo.status = "rejected"
        promo.admin_notes = (promo.admin_notes or "") + "\n[revoked by admin]"
        promo.reviewed_at = datetime.utcnow()
        promo.reviewed_by = user.email
        session.add(promo)
    session.commit()


# --- Admin endpoints (not behind feature flag — admins must triage backlog) ---


@router.get("/api/admin/promo-codes", response_model=list[PromoCodeAdminOut])
def admin_list_promo_codes(
    status: str | None = Query(default=None),
    event_id: str | None = Query(default=None),
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    q = select(EventPromoCode).order_by(col(EventPromoCode.created_at).desc())
    if status:
        q = q.where(EventPromoCode.status == status)
    if event_id:
        q = q.where(EventPromoCode.event_id == event_id)
    rows = session.exec(q).all()
    if not rows:
        return []
    submitter_ids = {r.submitter_user_id for r in rows}
    event_ids = {r.event_id for r in rows}
    users = {
        u.id: u
        for u in session.exec(select(User).where(col(User.id).in_(submitter_ids))).all()
    }
    events = {
        e.event_id: e
        for e in session.exec(
            select(CachedEvent).where(col(CachedEvent.event_id).in_(event_ids))
        ).all()
    }
    return [
        _to_admin_out(
            r,
            users.get(r.submitter_user_id) or User(id=r.submitter_user_id, email=""),
            events[r.event_id].title if r.event_id in events else None,
        )
        for r in rows
    ]


@router.get("/api/admin/promo-codes/{promo_id}", response_model=PromoCodeAdminOut)
def admin_get_promo_code(
    promo_id: UUID,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    promo = session.get(EventPromoCode, promo_id)
    if not promo:
        raise HTTPException(status_code=404, detail="Promo code not found")
    submitter = session.get(User, promo.submitter_user_id)
    event = session.get(CachedEvent, promo.event_id)
    return _to_admin_out(
        promo,
        submitter or User(id=promo.submitter_user_id, email=""),
        event.title if event else None,
    )


@router.post(
    "/api/admin/promo-codes/{promo_id}/approve",
    response_model=PromoCodeAdminOut,
)
def admin_approve_promo_code(
    promo_id: UUID,
    background_tasks: BackgroundTasks,
    session: Session = Depends(get_session),
    admin: dict = Depends(require_admin),
):
    promo = session.get(EventPromoCode, promo_id)
    if not promo:
        raise HTTPException(status_code=404, detail="Promo code not found")
    if promo.status == "approved":
        raise HTTPException(status_code=400, detail="Already approved")
    promo.status = "approved"
    promo.admin_notes = None
    promo.reviewed_at = datetime.utcnow()
    promo.reviewed_by = admin.get("email")
    promo.updated_at = datetime.utcnow()
    session.add(promo)
    _notify_submitter(session, promo, "promo_code_approved")
    recipient_ids = _fan_out_saved_event_promo_code(session, promo)
    session.commit()
    session.refresh(promo)
    if recipient_ids:
        background_tasks.add_task(
            _send_promo_code_added_notifications, promo.id, recipient_ids
        )
    submitter = session.get(User, promo.submitter_user_id)
    event = session.get(CachedEvent, promo.event_id)
    return _to_admin_out(
        promo,
        submitter or User(id=promo.submitter_user_id, email=""),
        event.title if event else None,
    )


@router.post(
    "/api/admin/promo-codes/{promo_id}/reject",
    response_model=PromoCodeAdminOut,
)
def admin_reject_promo_code(
    promo_id: UUID,
    body: PromoCodeReject,
    session: Session = Depends(get_session),
    admin: dict = Depends(require_admin),
):
    promo = session.get(EventPromoCode, promo_id)
    if not promo:
        raise HTTPException(status_code=404, detail="Promo code not found")
    if promo.status == "rejected":
        raise HTTPException(status_code=400, detail="Already rejected")
    promo.status = "rejected"
    promo.admin_notes = body.admin_notes
    promo.reviewed_at = datetime.utcnow()
    promo.reviewed_by = admin.get("email")
    promo.updated_at = datetime.utcnow()
    session.add(promo)
    _notify_submitter(session, promo, "promo_code_rejected")
    session.commit()
    session.refresh(promo)
    submitter = session.get(User, promo.submitter_user_id)
    event = session.get(CachedEvent, promo.event_id)
    return _to_admin_out(
        promo,
        submitter or User(id=promo.submitter_user_id, email=""),
        event.title if event else None,
    )


@router.patch("/api/admin/promo-codes/{promo_id}", response_model=PromoCodeAdminOut)
def admin_update_promo_code(
    promo_id: UUID,
    body: PromoCodeUpdate,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """Admin edit (e.g. fix typos before approving). Does not change status."""
    promo = session.get(EventPromoCode, promo_id)
    if not promo:
        raise HTTPException(status_code=404, detail="Promo code not found")
    data = body.model_dump(exclude_unset=True)
    if "code" in data and data["code"] is not None:
        new_code = data["code"].strip()
        if not new_code:
            raise HTTPException(status_code=422, detail="Code cannot be empty")
        rows = session.exec(
            select(EventPromoCode)
            .where(EventPromoCode.event_id == promo.event_id)
            .where(EventPromoCode.status != "rejected")
            .where(EventPromoCode.id != promo.id)
        ).all()
        for row in rows:
            if row.code.lower() == new_code.lower():
                raise HTTPException(
                    status_code=409,
                    detail="A promo code with this value already exists for this event",
                )
        promo.code = new_code
        data.pop("code")
    for field, value in data.items():
        setattr(promo, field, value)
    promo.updated_at = datetime.utcnow()
    session.add(promo)
    session.commit()
    session.refresh(promo)
    submitter = session.get(User, promo.submitter_user_id)
    event = session.get(CachedEvent, promo.event_id)
    return _to_admin_out(
        promo,
        submitter or User(id=promo.submitter_user_id, email=""),
        event.title if event else None,
    )
