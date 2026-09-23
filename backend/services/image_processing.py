"""Shared image validation and rendering primitives."""

from __future__ import annotations

import io

from PIL import Image, ImageOps, UnidentifiedImageError

ALLOWED_CONTENT_TYPES = {"image/jpeg", "image/png", "image/webp"}
MAX_SOURCE_PIXELS = 50_000_000


class ImageValidationError(ValueError):
    """Raised when submitted image data is not acceptable."""


def load_image(data: bytes) -> Image.Image:
    try:
        image = Image.open(io.BytesIO(data))
        image = ImageOps.exif_transpose(image)
        image.load()
    except (UnidentifiedImageError, OSError) as exc:
        raise ImageValidationError("File is not a readable image") from exc

    if image.format and f"image/{image.format.lower()}" not in ALLOWED_CONTENT_TYPES:
        raise ImageValidationError("Only JPEG, PNG and WebP images are supported")
    if image.width * image.height > MAX_SOURCE_PIXELS:
        raise ImageValidationError("Image resolution is too large")
    return image


def flatten_image(image: Image.Image) -> Image.Image:
    if image.mode in ("RGBA", "LA", "P"):
        rgba = image.convert("RGBA")
        canvas = Image.new("RGB", rgba.size, (255, 255, 255))
        canvas.paste(rgba, mask=rgba.split()[-1])
        return canvas
    return image.convert("RGB")


def cover_crop(image: Image.Image, width: int, aspect: float) -> Image.Image:
    src_ratio = image.width / image.height
    if src_ratio > aspect:
        crop_height = image.height
        crop_width = round(crop_height * aspect)
    else:
        crop_width = image.width
        crop_height = round(crop_width / aspect)
    left = (image.width - crop_width) // 2
    top = (image.height - crop_height) // 2
    cropped = image.crop((left, top, left + crop_width, top + crop_height))
    return cropped.resize((width, round(width / aspect)), Image.Resampling.LANCZOS)


def scale_down(image: Image.Image, max_width: int) -> Image.Image:
    if image.width <= max_width:
        return image
    height = round(image.height * max_width / image.width)
    return image.resize((max_width, height), Image.Resampling.LANCZOS)
