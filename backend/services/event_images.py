"""Event picture pipeline: validate, normalise and store event images.

Uploads and URL imports share this code path, and so does the scenario
seeder — so what a tester sees locally is what an admin gets in production.
"""

from __future__ import annotations

import io
import ipaddress
import logging
import os
import socket
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional
from urllib.parse import urlparse

import httpx

from backend.services import object_storage
from backend.services.image_processing import (
    ALLOWED_CONTENT_TYPES,
    ImageValidationError,
    cover_crop,
    flatten_image,
    load_image,
    scale_down,
)

logger = logging.getLogger(__name__)

DEFAULT_MAX_BYTES = 8 * 1024 * 1024

THUMB_WIDTH = 400
THUMB_ASPECT = 16 / 9
FULL_MAX_WIDTH = 1200
WEBP_CONTENT_TYPE = "image/webp"
REMOTE_FETCH_TIMEOUT = 10.0
REMOTE_MAX_REDIRECTS = 3
SUGGESTION_IMAGE_PREFIX = "suggestions/"
STAGED_IMAGE_MAX_AGE = timedelta(hours=24)


def get_max_bytes() -> int:
    raw = os.getenv("EVENT_IMAGE_MAX_BYTES", "")
    try:
        return int(raw) if raw else DEFAULT_MAX_BYTES
    except ValueError:
        return DEFAULT_MAX_BYTES


def _thumb_key(base_key: str) -> str:
    return f"{base_key}/thumb.webp"


def _full_key(base_key: str) -> str:
    return f"{base_key}/full.webp"


def _original_key(base_key: str) -> str:
    return f"{base_key}/original"


def image_urls(base_key: Optional[str]) -> tuple[Optional[str], Optional[str]]:
    """Return ``(thumb_url, full_url)`` for a stored image key."""
    if not base_key:
        return None, None
    return (
        object_storage.public_url(_thumb_key(base_key)),
        object_storage.public_url(_full_key(base_key)),
    )


def resolve_event_image(event) -> tuple[Optional[str], Optional[str]]:
    """Return ``(image_url, image_thumb_url)`` for an event row.

    A managed picture (``image_key``) wins over the plain ``image_url``.
    """
    base_key = getattr(event, "image_key", None)
    if base_key:
        try:
            thumb, full = image_urls(base_key)
            return full, thumb
        except object_storage.ObjectStorageError:
            logger.warning("Object storage misconfigured; falling back to image_url")
    return getattr(event, "image_url", None), None


def event_image_fields(event) -> dict:
    """``EventResponse`` image kwargs for an event row."""
    image_url, thumb_url = resolve_event_image(event)
    return {"image_url": image_url, "image_thumb_url": thumb_url}


def process_image(data: bytes) -> tuple[bytes, bytes]:
    """Validate ``data`` and render the ``(thumb, full)`` WebP variants."""
    if not data:
        raise ImageValidationError("Image file is empty")
    max_bytes = get_max_bytes()
    if len(data) > max_bytes:
        raise ImageValidationError(
            f"Image is larger than {max_bytes // (1024 * 1024)}MB"
        )

    source = flatten_image(load_image(data))

    thumb_buffer = io.BytesIO()
    cover_crop(source, THUMB_WIDTH, THUMB_ASPECT).save(
        thumb_buffer, format="WEBP", quality=82, method=4
    )

    full_buffer = io.BytesIO()
    scale_down(source, FULL_MAX_WIDTH).save(
        full_buffer, format="WEBP", quality=85, method=4
    )

    return thumb_buffer.getvalue(), full_buffer.getvalue()


def store_event_image(
    event_id: str,
    data: bytes,
    content_type: Optional[str] = None,
    base_key: Optional[str] = None,
    client=None,
) -> str:
    """Process ``data`` and upload the original + variants. Returns the base key."""
    if content_type and content_type.split(";")[0].strip() not in ALLOWED_CONTENT_TYPES:
        raise ImageValidationError("Only JPEG, PNG and WebP images are supported")

    thumb, full = process_image(data)
    key = base_key or f"events/{event_id}/{uuid.uuid4().hex}"
    client = client or object_storage.get_client()

    object_storage.put_private(
        _original_key(key),
        data,
        content_type or "application/octet-stream",
        client=client,
    )
    object_storage.put_public(_thumb_key(key), thumb, WEBP_CONTENT_TYPE, client=client)
    object_storage.put_public(_full_key(key), full, WEBP_CONTENT_TYPE, client=client)
    return key


def suggestion_image_prefix(user_id) -> str:
    return f"{SUGGESTION_IMAGE_PREFIX}{user_id}/"


def store_suggestion_image(
    user_id, data: bytes, content_type: Optional[str] = None
) -> str:
    """Stage a submitter's picture before the suggestion exists."""
    base_key = f"{suggestion_image_prefix(user_id)}{uuid.uuid4().hex}"
    return store_event_image("", data, content_type, base_key=base_key)


def suggestion_image_exists(base_key: str) -> bool:
    return object_storage.object_exists(_thumb_key(base_key))


def _delete_image_objects(base_key: str, client=None) -> None:
    client = client or object_storage.get_client()
    prefix = f"{base_key}/"
    object_storage.delete_prefix(
        prefix, object_storage.get_public_bucket(), client=client
    )
    object_storage.delete_prefix(
        prefix, object_storage.get_private_bucket(), client=client
    )


def delete_event_image(base_key: Optional[str], client=None) -> None:
    # Submitted pictures are shared by every occurrence; the sweep reclaims them.
    if not base_key or base_key.startswith(SUGGESTION_IMAGE_PREFIX):
        return
    _delete_image_objects(base_key, client=client)


def sweep_suggestion_images(session, now: Optional[datetime] = None) -> int:
    """Delete stale submitter pictures no suggestion or event references."""
    from sqlmodel import col, select

    from backend.db.models import CachedEvent, EventSuggestion

    cutoff = (now or datetime.now(timezone.utc)) - STAGED_IMAGE_MAX_AGE
    client = object_storage.get_client()
    newest: dict[str, datetime] = {}
    for key, modified in object_storage.list_objects(
        SUGGESTION_IMAGE_PREFIX, object_storage.get_public_bucket(), client=client
    ):
        base_key = key.rsplit("/", 1)[0]
        if base_key not in newest or modified > newest[base_key]:
            newest[base_key] = modified

    stale = {key for key, modified in newest.items() if modified < cutoff}
    if not stale:
        return 0
    referenced = set(
        session.exec(
            select(EventSuggestion.image_key).where(
                col(EventSuggestion.image_key).in_(stale)
            )
        ).all()
    ) | set(
        session.exec(
            select(CachedEvent.image_key).where(col(CachedEvent.image_key).in_(stale))
        ).all()
    )
    removed = 0
    for base_key in stale - referenced:
        _delete_image_objects(base_key, client=client)
        removed += 1
    return removed


def run_sweep_once() -> dict:
    from sqlmodel import Session

    from backend.db.database import get_engine

    with Session(get_engine()) as session:
        return {"removed": sweep_suggestion_images(session)}


def _is_blocked_address(raw: str) -> bool:
    address = ipaddress.ip_address(raw)
    return (
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_reserved
        or address.is_multicast
        or address.is_unspecified
    )


def _assert_public_host(host: str) -> None:
    """Reject private/loopback targets so URL import can't probe internal services."""
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise ImageValidationError("Could not resolve the image host") from exc

    for info in infos:
        if _is_blocked_address(info[4][0]):
            raise ImageValidationError("Image URL must point to a public host")


def _assert_public_peer(response: httpx.Response) -> None:
    # DNS can answer differently at connect time than in _assert_public_host.
    stream = response.extensions.get("network_stream")
    peer = stream.get_extra_info("server_addr") if stream is not None else None
    if not peer or _is_blocked_address(peer[0]):
        raise ImageValidationError("Image URL must point to a public host")


def _validate_remote_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise ImageValidationError("Image URL must use https")
    if not parsed.hostname:
        raise ImageValidationError("Image URL is not valid")
    _assert_public_host(parsed.hostname)


def fetch_remote_image(url: str) -> tuple[bytes, str]:
    """Download an image from a public https URL. Returns ``(bytes, content_type)``."""
    max_bytes = get_max_bytes()
    current = url

    for _ in range(REMOTE_MAX_REDIRECTS + 1):
        _validate_remote_url(current)
        try:
            with httpx.stream(
                "GET", current, timeout=REMOTE_FETCH_TIMEOUT, follow_redirects=False
            ) as response:
                _assert_public_peer(response)
                if response.is_redirect:
                    location = response.headers.get("location")
                    if not location:
                        raise ImageValidationError("Image URL redirect is not valid")
                    current = str(response.url.join(location))
                    continue
                if response.status_code != 200:
                    raise ImageValidationError(
                        f"Image URL returned HTTP {response.status_code}"
                    )

                content_type = (
                    response.headers.get("content-type", "")
                    .split(";")[0]
                    .strip()
                    .lower()
                )
                if content_type and content_type not in ALLOWED_CONTENT_TYPES:
                    raise ImageValidationError(
                        "URL does not point to a JPEG, PNG or WebP image"
                    )

                chunks = bytearray()
                for chunk in response.iter_bytes():
                    chunks.extend(chunk)
                    if len(chunks) > max_bytes:
                        raise ImageValidationError(
                            f"Image is larger than {max_bytes // (1024 * 1024)}MB"
                        )
                return bytes(chunks), content_type or "application/octet-stream"
        except httpx.HTTPError as exc:
            raise ImageValidationError("Could not download the image URL") from exc

    raise ImageValidationError("Image URL has too many redirects")


def replace_event_image_from_url(
    event_id: str,
    url: str,
    previous_key: Optional[str] = None,
) -> str:
    data, content_type = fetch_remote_image(url)
    key = store_event_image(event_id, data, content_type)
    delete_event_image(previous_key)
    return key
