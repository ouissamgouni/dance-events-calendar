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
import re
from uuid import uuid4

from fastapi import Request, Response

# Accept any opaque, cookie-safe identifier between 4 and 128 characters
# (alphanumeric / `-` / `_`). The dedupe key is not a security boundary
# (it only groups rows owned by the same anonymous human, all of which
# already have user_id IS NULL), so we don't need to require UUID shape;
# we only need to keep the seeded value safe to embed in a Set-Cookie
# header. Tests rely on short labels like "d-anon" being accepted here.
_PREFERRED_VALUE_RE = re.compile(r"^[A-Za-z0-9_-]{4,128}$")

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


def get_or_set_anon_id(
    request: Request,
    response: Response,
    *,
    preferred_value: str | None = None,
) -> str:
    """Return the anon-id cookie value, minting and setting it if absent.

    Idempotent within a request (returns the existing cookie if already set).
    The Set-Cookie header is only added when a new value is minted.

    ``preferred_value`` lets the caller seed the cookie with an existing
    client-side identifier (typically the legacy ``movida_device_id`` from
    localStorage) instead of a fresh UUID. This eliminates a multi-machine
    race where two parallel "first writes" from the same anonymous human
    each mint different anon ids on different backend instances and produce
    duplicate ``UserSavedEvent`` / ``UserEventAttendance`` rows that defeat
    the ``(device_id, event_id)`` unique constraint. Once the cookie is
    set, subsequent localStorage clears do not change it (it is httpOnly),
    so the localStorage-clear inflation protection the cookie was added
    for is preserved.

    Untrusted ``preferred_value`` strings are validated against a strict
    UUID-shape regex; invalid values fall back to a freshly minted UUID.
    """
    existing = read_anon_id(request)
    if existing:
        return existing
    if preferred_value and _PREFERRED_VALUE_RE.match(preferred_value):
        value = preferred_value
    else:
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


def clear_anon_id(response: Response) -> None:
    """Clear the anonymous-id cookie.

    Used on logout / account delete so the next anonymous session on the
    same browser is a fresh identity (otherwise saves/going made by the
    next anonymous user on this device would inherit the previous user's
    httpOnly ``movida_aid`` row identity).

    Cookie attributes (path, samesite, secure) must match the setter in
    ``get_or_set_anon_id`` for the browser to actually clear the cookie.
    """
    secure = _is_secure()
    response.delete_cookie(
        key=ANON_COOKIE_NAME,
        path="/",
        samesite="none" if secure else "lax",
        secure=secure,
    )
