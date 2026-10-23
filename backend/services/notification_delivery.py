"""Helper for recording actual notification delivery events.

See ``backend.db.models.NotificationDelivery`` for the rationale: a row is
only inserted here when a channel genuinely delivered, as opposed to
``Notification.emailed_at``/``pushed_at`` which are internal bookkeeping
stamps set regardless of per-user channel preference.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional
from uuid import uuid4

from sqlmodel import Session

from backend.db.models import NotificationDelivery


def new_batch_id() -> str:
    return uuid4().hex


def record_delivery(
    session: Session,
    notification_id: int,
    channel: str,
    when: Optional[datetime] = None,
    *,
    mode: Optional[str] = None,
    source: Optional[str] = None,
    batch_id: Optional[str] = None,
    rendered: Optional[bool] = None,
) -> None:
    """Insert a delivery-log row. Caller owns the transaction (no commit).

    Pass a shared ``batch_id`` when several notifications go out in one
    email/push; otherwise each call is its own send."""
    session.add(
        NotificationDelivery(
            notification_id=notification_id,
            channel=channel,
            mode=mode,
            source=source,
            delivered_at=when or datetime.now(timezone.utc),
            batch_id=batch_id or (None if channel == "app" else new_batch_id()),
            rendered=rendered,
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
    if channel == "email":
        from backend.services.email_tokens import make_notification_token

        # Signed so the click counts even when the reader isn't signed in.
        out += f"&t={make_notification_token(notification_id, 'c')}"
    return f"{out}#{fragment}" if sep else out


def email_open_pixel_html(notification_id: Optional[int]) -> str:
    from backend.config.loader import (
        get_email_open_tracking_enabled,
        get_public_api_url,
    )
    from backend.services.email_tokens import make_notification_token

    if notification_id is None or not get_email_open_tracking_enabled():
        return ""
    token = make_notification_token(notification_id, "o")
    return (
        f'<img src="{get_public_api_url()}/api/notifications/email-open/{token}.gif" '
        'width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px">'
    )
