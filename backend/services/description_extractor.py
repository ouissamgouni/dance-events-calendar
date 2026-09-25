import json
import re
from dataclasses import dataclass
from typing import Optional
from urllib.parse import urlsplit


START_MARKER = "<<<EXTRACTOR_JSON>>>"
END_MARKER = "<<<END_EXTRACTOR_JSON>>>"
_BLOCK_PATTERN = re.compile(
    rf"{re.escape(START_MARKER)}(.*?){re.escape(END_MARKER)}",
    re.DOTALL,
)


@dataclass(frozen=True)
class ExtractorPayload:
    links: list[str]
    image: str
    tags: list[str]
    price_range: str


@dataclass(frozen=True)
class DescriptionExtraction:
    description: Optional[str]
    payload: Optional[ExtractorPayload]


def _is_http_url(value: str) -> bool:
    parsed = urlsplit(value)
    return parsed.scheme.lower() in {"http", "https"} and bool(parsed.netloc)


def _deduplicate(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result


def extract_description(description: Optional[str]) -> DescriptionExtraction:
    if description is None:
        return DescriptionExtraction(description=None, payload=None)

    match = _BLOCK_PATTERN.search(description)
    if match is None:
        return DescriptionExtraction(description=description, payload=None)

    try:
        raw = json.loads(match.group(1))
    except (json.JSONDecodeError, TypeError):
        return DescriptionExtraction(description=description, payload=None)

    if not isinstance(raw, dict):
        return DescriptionExtraction(description=description, payload=None)

    links = raw.get("links", [])
    image = raw.get("image", "")
    tags = raw.get("tags", [])
    price_range = raw.get("price_range", "")
    if (
        not isinstance(links, list)
        or not all(isinstance(value, str) for value in links)
        or not isinstance(image, str)
        or not isinstance(tags, list)
        or not all(isinstance(value, str) for value in tags)
        or not isinstance(price_range, str)
    ):
        return DescriptionExtraction(description=description, payload=None)

    normalized_links = _deduplicate(
        [value.strip() for value in links if _is_http_url(value.strip())]
    )
    normalized_image = image.strip()
    if normalized_image and not _is_http_url(normalized_image):
        normalized_image = ""
    normalized_tags = _deduplicate(
        [value.strip().lower() for value in tags if value.strip()]
    )
    cleaned = _BLOCK_PATTERN.sub("", description).strip()

    return DescriptionExtraction(
        description=cleaned,
        payload=ExtractorPayload(
            links=normalized_links,
            image=normalized_image,
            tags=normalized_tags,
            price_range=price_range.strip(),
        ),
    )
