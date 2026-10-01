"""Helper for recording actual notification delivery events.

See ``backend.db.models.NotificationDelivery`` for the rationale: a row is
only inserted here when a channel genuinely delivered, as opposed to
``Notification.emailed_at``/``pushed_at`` which are internal bookkeeping
stamps set regardless of per-user channel preference.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlmodel import Session

from backend.db.models import NotificationDelivery


def record_delivery(
    session: Session,
    notification_id: int,
    channel: str,
    when: Optional[datetime] = None,
) -> None:
    """Insert a delivery-log row. Caller owns the transaction (no commit)."""
    session.add(
        NotificationDelivery(
            notification_id=notification_id,
            channel=channel,
            delivered_at=when or datetime.now(timezone.utc),
        )
    )


def tracked_url(url: str, notification_id: Optional[int], channel: str) -> str:
    """Append ``via``/``nid`` so the app can report the open/click
    (``POST /api/notifications/{id}/opened``). Keeps any ``#fragment`` last."""
    if notification_id is None:
        return url
    path, sep, fragment = url.partition("#")
    joiner = "&" if "?" in path else "?"
    out = f"{path}{joiner}via={channel}&nid={notification_id}"
    return f"{out}#{fragment}" if sep else out
