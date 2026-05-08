"""Server-issued anonymous identity cookie.

Why this exists:
The anonymous identity used to be the ``movida_device_id`` UUID stored in
``localStorage`` on the client. That value is trivially reset by clearing
localStorage (devtools, browser settings, "clear site data"), which lets a
single anonymous human inflate ``total_saved`` / ``total_going`` counts by
re-clicking save / going after each clear — a new ``device_id`` ⇒ a new
``UserSavedEvent`` / ``UserEventAttendance`` row, none of them deduped.

We now mint an opaque UUID into an httpOnly cookie (``movida_aid``) on the
first write-side call. The server uses the cookie value (when present) as
the dedupe key for anonymous saves/going, falling back to the payload
``device_id`` for legacy clients / cookie-blocking browsers / tests. The
cookie is httpOnly so it cannot be wiped by ``localStorage.clear()`` or
JS-side code; only a real cookie clear / incognito reset rotates it.

The value is reused as the ``device_id`` column in ``UserSavedEvent`` /
``UserEventAttendance`` so we don't need a schema migration — the column
has always been an opaque per-anon-identity string.
"""

from __future__ import annotations

import os
from uuid import uuid4

from fastapi import Request, Response

ANON_COOKIE_NAME = "movida_aid"
# 2 years — long enough that a "stable enough" identity is preserved across
# browser restarts but short enough that very old abandoned cookies expire.
ANON_COOKIE_MAX_AGE = 60 * 60 * 24 * 365 * 2

_SECURE_ENV_NAMES = {"staging", "production"}


def _is_secure() -> bool:
    """Cookies must be Secure in staging/prod (HTTPS) and may be insecure in dev."""
    return os.getenv("ENV_NAME", "").lower() in _SECURE_ENV_NAMES


def read_anon_id(request: Request) -> str | None:
    """Return the existing anon-id cookie value, or None if not set."""
    return request.cookies.get(ANON_COOKIE_NAME)


def get_or_set_anon_id(request: Request, response: Response) -> str:
    """Return the anon-id cookie value, minting and setting it if absent.

    Idempotent within a request (returns the existing cookie if already set).
    The Set-Cookie header is only added when a new value is minted.
    """
    existing = read_anon_id(request)
    if existing:
        return existing
    value = uuid4().hex
    secure = _is_secure()
    response.set_cookie(
        key=ANON_COOKIE_NAME,
        value=value,
        max_age=ANON_COOKIE_MAX_AGE,
        httponly=True,
        # SameSite=lax keeps the cookie on top-level navigations (including
        # link-preview crawlers and shared-link arrivals) while blocking
        # third-party cross-site POSTs.
        samesite="none" if secure else "lax",
        secure=secure,
        path="/",
    )
    return value
