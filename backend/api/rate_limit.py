"""Shared rate-limit helpers.

`client_ip` returns the real visitor IP when running behind a trusted proxy
(Cloudflare → Fly's edge → the FastAPI app). Without this, slowapi keys every
request by the proxy's IP and the whole world shares one bucket.

Trust order:
    1. CF-Connecting-IP   (set by Cloudflare; cannot be spoofed when traffic
       only enters via Cloudflare, which is our setup for *.joinmovida.com)
    2. X-Forwarded-For first hop (set by Fly's edge for non-CF traffic)
    3. request.client.host (direct connection, e.g. local dev)
"""

from __future__ import annotations

from starlette.requests import Request
from slowapi.util import get_remote_address


def client_ip(request: Request) -> str:
    cf = request.headers.get("cf-connecting-ip")
    if cf:
        return cf.strip()
    xff = request.headers.get("x-forwarded-for")
    if xff:
        # First entry is the original client; rest are proxy hops.
        first = xff.split(",", 1)[0].strip()
        if first:
            return first
    return get_remote_address(request)
