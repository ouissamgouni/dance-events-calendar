"""Web Push subscription endpoints (Phase 4).

Endpoints (all require an authenticated end-user except the public key fetch):
  - GET  /api/push/vapid-public-key   the app's VAPID public key (for subscribe)
  - POST /api/push/subscribe          register/refresh this browser's endpoint
  - POST /api/push/unsubscribe        drop this browser's endpoint

Subscriptions are keyed by the unique push-service ``endpoint`` URL, so a
re-subscribe upserts (re-binding the endpoint to the current user) rather than
creating duplicate rows. Actual delivery lives in
``backend.services.push_service``.
"""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, delete, select

from backend.api.deps import require_user
from backend.config.loader import get_vapid_config, get_webpush_enabled
from backend.db.database import get_session
from backend.db.models import PushSubscription, User


router = APIRouter(prefix="/api/push", tags=["push"])


class PushKeys(BaseModel):
    p256dh: str
    auth: str


class SubscribeRequest(BaseModel):
    endpoint: str
    keys: PushKeys
    user_agent: Optional[str] = None


class UnsubscribeRequest(BaseModel):
    endpoint: str


@router.get("/vapid-public-key")
def vapid_public_key():
    """Return the VAPID public key clients pass to ``PushManager.subscribe``."""
    cfg = get_vapid_config()
    if not get_webpush_enabled() or not cfg.get("public_key"):
        raise HTTPException(status_code=404, detail="Push not enabled")
    return {"public_key": cfg["public_key"]}


@router.post("/subscribe")
def subscribe(
    payload: SubscribeRequest,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
):
    """Register (or refresh) this browser's push endpoint for the current user."""
    endpoint = payload.endpoint.strip()
    if not endpoint or len(payload.keys.p256dh) > 255 or len(payload.keys.auth) > 255:
        raise HTTPException(status_code=400, detail="Invalid subscription")

    existing = session.exec(
        select(PushSubscription).where(PushSubscription.endpoint == endpoint)
    ).first()
    ua = (payload.user_agent or "").strip()[:400] or None
    if existing is not None:
        existing.user_id = user.id
        existing.p256dh = payload.keys.p256dh
        existing.auth = payload.keys.auth
        existing.user_agent = ua
        session.add(existing)
    else:
        session.add(
            PushSubscription(
                user_id=user.id,
                endpoint=endpoint,
                p256dh=payload.keys.p256dh,
                auth=payload.keys.auth,
                user_agent=ua,
            )
        )
    session.commit()
    return {"status": "ok"}


@router.post("/unsubscribe")
def unsubscribe(
    payload: UnsubscribeRequest,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
):
    """Remove this browser's push endpoint. Idempotent."""
    session.exec(
        delete(PushSubscription)
        .where(PushSubscription.endpoint == payload.endpoint.strip())
        .where(PushSubscription.user_id == user.id)
    )
    session.commit()
    return {"status": "ok"}
