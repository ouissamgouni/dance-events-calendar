"""Web Push delivery via VAPID + pywebpush.

Sends encrypted push messages to a user's registered browser endpoints. Used
by the notification dispatch workers (reminders + activity digests) after
they've filtered on the appropriate per-user, per-feature push flag
(``push_event_reminders_enabled`` / ``push_social_activity_enabled`` /
``push_interest_matches_enabled``) and confirmed at least one live
subscription.

Resilience:
  * No-ops (returns 0) when web-push is disabled or VAPID keys are unset, so
    callers can invoke it unconditionally.
  * Per-endpoint failures are logged, never raised.
  * Endpoints the push service reports as gone (HTTP 404/410) are pruned so we
    stop retrying dead browsers.
"""

from __future__ import annotations

import json
import logging
from uuid import UUID

from sqlmodel import Session, delete, select

from backend.config.loader import get_vapid_config
from backend.services.app_settings import get_web_push_enabled
from backend.db.database import get_engine
from backend.db.models import PushSubscription

logger = logging.getLogger(__name__)


def webpush_configured() -> bool:
    """True when web-push is enabled and a VAPID keypair is available."""
    if not get_web_push_enabled():
        return False
    cfg = get_vapid_config()
    return bool(cfg.get("private_key") and cfg.get("public_key"))


def send_push(
    user_id: UUID,
    title: str,
    body: str,
    url: str = "/",
    tag: str | None = None,
) -> int:
    """Push to every browser registered by ``user_id``. Returns delivery count."""
    if not webpush_configured():
        return 0
    try:
        from pywebpush import WebPushException, webpush
    except ImportError:
        logger.warning("pywebpush not installed; skipping push delivery")
        return 0

    cfg = get_vapid_config()
    payload = json.dumps({"title": title, "body": body, "url": url, "tag": tag})
    delivered = 0
    stale: list[int] = []

    with Session(get_engine()) as session:
        subs = session.exec(
            select(PushSubscription).where(PushSubscription.user_id == user_id)
        ).all()
        for sub in subs:
            try:
                webpush(
                    subscription_info={
                        "endpoint": sub.endpoint,
                        "keys": {"p256dh": sub.p256dh, "auth": sub.auth},
                    },
                    data=payload,
                    vapid_private_key=cfg["private_key"],
                    vapid_claims={"sub": cfg["subject"]},
                    timeout=10,
                    ttl=86400,
                )
                delivered += 1
            except WebPushException as exc:
                status = getattr(getattr(exc, "response", None), "status_code", None)
                if status in (404, 410):
                    stale.append(sub.id)  # endpoint gone — prune below
                else:
                    logger.warning("Push failed (status=%s): %s", status, exc)
                    logger.exception("FULL PUSH ERROR")
            except Exception as exc:  # noqa: BLE001 — never let push break a worker
                logger.warning("Push error: %s", exc)

        if stale:
            session.exec(
                delete(PushSubscription).where(
                    PushSubscription.id.in_(stale)  # type: ignore[union-attr]
                )
            )
            session.commit()
    logger.info("Push delivered count: %s", delivered)
    return delivered
