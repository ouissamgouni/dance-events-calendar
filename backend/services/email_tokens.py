"""Signed, stateless tokens for one-click email unsubscribe links.

A token encodes ``{user_id, category}`` and is HMAC-signed with the app's
``SESSION_SECRET`` so the unsubscribe endpoint can flip a preference without
requiring the user to be logged in (Gmail/Yahoo bulk-sender + GDPR/CAN-SPAM
expectation: every marketing-adjacent email carries a working opt-out).

Tokens are intentionally long-lived (no expiry): an unsubscribe link in an
old email must keep working. Categories map to a boolean User column:

* ``reminder``  -> ``reminder_email_enabled``
* ``activity``  -> ``activity_email_enabled``
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
from typing import Optional

from backend.config.loader import get_session_secret

# Allowed unsubscribe categories -> the User column they toggle off.
UNSUBSCRIBE_CATEGORIES = {
    "reminder": "reminder_email_enabled",
    "activity": "activity_email_enabled",
}


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def _sign(payload: bytes) -> str:
    digest = hmac.new(
        get_session_secret().encode("utf-8"), payload, hashlib.sha256
    ).digest()
    return _b64url_encode(digest)


def make_unsubscribe_token(user_id: str, category: str) -> str:
    """Return a signed ``<payload>.<sig>`` token for the given category."""
    if category not in UNSUBSCRIBE_CATEGORIES:
        raise ValueError(f"Unknown unsubscribe category: {category}")
    payload = json.dumps(
        {"u": str(user_id), "c": category}, separators=(",", ":")
    ).encode("utf-8")
    body = _b64url_encode(payload)
    return f"{body}.{_sign(payload)}"


def verify_unsubscribe_token(token: str) -> Optional[tuple[str, str]]:
    """Return ``(user_id, category)`` if the token is valid, else ``None``."""
    try:
        body, sig = token.split(".", 1)
        payload = _b64url_decode(body)
    except (ValueError, Exception):  # noqa: BLE001 - malformed token => invalid
        return None
    expected = _sign(payload)
    if not hmac.compare_digest(expected, sig):
        return None
    try:
        data = json.loads(payload.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    user_id = data.get("u")
    category = data.get("c")
    if not user_id or category not in UNSUBSCRIBE_CATEGORIES:
        return None
    return user_id, category
