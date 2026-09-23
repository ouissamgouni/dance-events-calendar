"""Validation, storage, and URL resolution for managed user avatars."""

from __future__ import annotations

import io
import logging
import uuid
from typing import Optional

from backend.services import object_storage
from backend.services.image_processing import (
    ALLOWED_CONTENT_TYPES,
    ImageValidationError,
    cover_crop,
    flatten_image,
    load_image,
)

logger = logging.getLogger(__name__)

AVATAR_SIZE = 512
MAX_AVATAR_BYTES = 5 * 1024 * 1024
WEBP_CONTENT_TYPE = "image/webp"


def _avatar_key(base_key: str) -> str:
    return f"{base_key}/avatar.webp"


def _original_key(base_key: str) -> str:
    return f"{base_key}/original"


def process_avatar(data: bytes) -> bytes:
    if not data:
        raise ImageValidationError("Image file is empty")
    if len(data) > MAX_AVATAR_BYTES:
        raise ImageValidationError("Image is larger than 5MB")

    source = flatten_image(load_image(data))
    output = io.BytesIO()
    cover_crop(source, AVATAR_SIZE, 1).save(output, format="WEBP", quality=85, method=4)
    return output.getvalue()


def store_user_avatar(
    user_id: str,
    data: bytes,
    content_type: Optional[str] = None,
    client=None,
) -> str:
    normalized_content_type = (content_type or "").split(";")[0].strip()
    if normalized_content_type and normalized_content_type not in ALLOWED_CONTENT_TYPES:
        raise ImageValidationError("Only JPEG, PNG and WebP images are supported")

    avatar = process_avatar(data)
    base_key = f"users/{user_id}/avatar/{uuid.uuid4().hex}"
    client = client or object_storage.get_client()
    object_storage.put_private(
        _original_key(base_key),
        data,
        normalized_content_type or "application/octet-stream",
        client=client,
    )
    object_storage.put_public(
        _avatar_key(base_key), avatar, WEBP_CONTENT_TYPE, client=client
    )
    return base_key


def delete_user_avatar(base_key: Optional[str], client=None) -> None:
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


def resolve_user_avatar(user) -> Optional[str]:
    base_key = getattr(user, "avatar_key", None)
    if base_key:
        try:
            return object_storage.public_url(_avatar_key(base_key))
        except object_storage.ObjectStorageError:
            logger.warning(
                "Object storage misconfigured; falling back to provider avatar"
            )
    return getattr(user, "avatar_url", None)
