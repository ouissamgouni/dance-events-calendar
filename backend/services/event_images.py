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
from typing import Optional
from urllib.parse import urlparse

import httpx
from PIL import Image, UnidentifiedImageError

from backend.services import object_storage

logger = logging.getLogger(__name__)

ALLOWED_CONTENT_TYPES = {"image/jpeg", "image/png", "image/webp"}
DEFAULT_MAX_BYTES = 8 * 1024 * 1024

THUMB_WIDTH = 400
THUMB_ASPECT = 16 / 9
FULL_MAX_WIDTH = 1200
# Guards against decompression bombs before we allocate the full raster.
MAX_SOURCE_PIXELS = 50_000_000

WEBP_CONTENT_TYPE = "image/webp"
REMOTE_FETCH_TIMEOUT = 10.0
REMOTE_MAX_REDIRECTS = 3


class ImageValidationError(ValueError):
    """Raised when the submitted image or URL is not acceptable."""


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


def _load_image(data: bytes) -> Image.Image:
    try:
        image = Image.open(io.BytesIO(data))
        image.load()
    except (UnidentifiedImageError, OSError) as exc:
        raise ImageValidationError("File is not a readable image") from exc

    if image.format and f"image/{image.format.lower()}" not in ALLOWED_CONTENT_TYPES:
        raise ImageValidationError("Only JPEG, PNG and WebP images are supported")
    if image.width * image.height > MAX_SOURCE_PIXELS:
        raise ImageValidationError("Image resolution is too large")
    return image


def _flatten(image: Image.Image) -> Image.Image:
    """Drop alpha/EXIF by recomposing onto white in RGB."""
    if image.mode in ("RGBA", "LA", "P"):
        rgba = image.convert("RGBA")
        canvas = Image.new("RGB", rgba.size, (255, 255, 255))
        canvas.paste(rgba, mask=rgba.split()[-1])
        return canvas
    return image.convert("RGB")


def _cover_crop(image: Image.Image, width: int, aspect: float) -> Image.Image:
    """Center-crop to ``aspect`` then scale to ``width`` — never distorts."""
    target_ratio = aspect
    src_ratio = image.width / image.height
    if src_ratio > target_ratio:
        crop_h = image.height
        crop_w = round(crop_h * target_ratio)
    else:
        crop_w = image.width
        crop_h = round(crop_w / target_ratio)
    left = (image.width - crop_w) // 2
    top = (image.height - crop_h) // 2
    cropped = image.crop((left, top, left + crop_w, top + crop_h))
    return cropped.resize((width, round(width / target_ratio)), Image.LANCZOS)


def _scale_down(image: Image.Image, max_width: int) -> Image.Image:
    if image.width <= max_width:
        return image
    height = round(image.height * max_width / image.width)
    return image.resize((max_width, height), Image.LANCZOS)


def process_image(data: bytes) -> tuple[bytes, bytes]:
    """Validate ``data`` and render the ``(thumb, full)`` WebP variants."""
    if not data:
        raise ImageValidationError("Image file is empty")
    max_bytes = get_max_bytes()
    if len(data) > max_bytes:
        raise ImageValidationError(
            f"Image is larger than {max_bytes // (1024 * 1024)}MB"
        )

    source = _flatten(_load_image(data))

    thumb_buffer = io.BytesIO()
    _cover_crop(source, THUMB_WIDTH, THUMB_ASPECT).save(
        thumb_buffer, format="WEBP", quality=82, method=4
    )

    full_buffer = io.BytesIO()
    _scale_down(source, FULL_MAX_WIDTH).save(
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


def delete_event_image(base_key: Optional[str], client=None) -> None:
    if not base_key:
        return
    client = client or object_storage.get_client()
    prefix = f"{base_key}/"
    object_storage.delete_prefix(
        prefix, object_storage.get_public_bucket(), client=client
    )
    object_storage.delete_prefix(
        prefix, object_storage.get_private_bucket(), client=client
    )


def _assert_public_host(host: str) -> None:
    """Reject private/loopback targets so URL import can't probe internal services."""
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise ImageValidationError("Could not resolve the image host") from exc

    for info in infos:
        address = ipaddress.ip_address(info[4][0])
        if (
            address.is_private
            or address.is_loopback
            or address.is_link_local
            or address.is_reserved
            or address.is_multicast
            or address.is_unspecified
        ):
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
