from typing import Any, Optional

from backend.db.models import CachedEvent
from backend.services.description_extractor import (
    ExtractorPayload,
    extract_description,
)
from backend.services.price_parser import parse_price_range


def _payload_dict(payload: ExtractorPayload) -> dict[str, Any]:
    return {
        "links": payload.links,
        "image": payload.image,
        "tags": payload.tags,
        "price_range": payload.price_range,
    }


def _link_items(payload: ExtractorPayload) -> list[dict[str, Optional[str]]]:
    return [{"url": url, "label": None} for url in payload.links]


def _price_fields(payload: ExtractorPayload) -> dict[str, Any]:
    parsed = parse_price_range(payload.price_range)
    if parsed is None:
        return {
            "price_min": None,
            "price_max": None,
            "price_currency": None,
            "price_is_free": None,
        }
    return {
        "price_min": parsed["min"],
        "price_max": parsed["max"],
        "price_currency": parsed["currency"],
        "price_is_free": parsed["is_free"],
    }


def _current_price(event: CachedEvent) -> dict[str, Any]:
    return {
        "price_min": event.price_min,
        "price_max": event.price_max,
        "price_currency": event.price_currency,
        "price_is_free": event.price_is_free,
    }


def apply_calendar_description(
    event: CachedEvent,
    source_description: Optional[str],
    *,
    is_new: bool,
) -> bool:
    before = (
        event.source_description,
        event.description,
        event.links,
        _current_price(event),
        event.extractor_state,
    )
    extraction = extract_description(source_description)
    old_state = event.extractor_state or {}
    old_applied = dict(old_state.get("applied") or {})
    applied = dict(old_applied)

    if is_new:
        description_owned = True
    else:
        previous = extract_description(event.source_description)
        previous_applied = old_applied.get("description", previous.description)
        description_owned = event.description == previous_applied or (
            not old_state and event.description == event.source_description
        )

    event.source_description = source_description
    if description_owned:
        event.description = extraction.description
        applied["description"] = extraction.description

    payload = extraction.payload
    if payload is not None:
        links = _link_items(payload)
        links_owned = is_new or (
            event.links == old_applied["links"]
            if "links" in old_applied
            else event.links is None
        )
        if links_owned:
            event.links = links
            applied["links"] = links

        price = _price_fields(payload)
        price_owned = is_new or (
            _current_price(event) == old_applied["price"]
            if "price" in old_applied
            else all(value is None for value in _current_price(event).values())
        )
        if price_owned:
            event.price_min = price["price_min"]
            event.price_max = price["price_max"]
            event.price_currency = price["price_currency"]
            event.price_is_free = price["price_is_free"]
            applied["price"] = price

    new_state = dict(old_state)
    new_state.update(
        {
            "version": 1,
            "valid": payload is not None,
            "payload": _payload_dict(payload) if payload is not None else None,
            "applied": applied,
        }
    )
    event.extractor_state = new_state
    after = (
        event.source_description,
        event.description,
        event.links,
        _current_price(event),
        event.extractor_state,
    )
    return before != after


def extractor_image_needed(event: CachedEvent) -> bool:
    state = event.extractor_state or {}
    if not state.get("valid"):
        return False
    payload = state.get("payload") or {}
    desired_url = payload.get("image", "")
    applied = state.get("applied") or {}
    previous = applied.get("image")
    if previous is None:
        return event.image_key is None and bool(desired_url)
    if event.image_key != previous.get("key"):
        return False
    return desired_url != previous.get("url")


def apply_extractor_image(event: CachedEvent) -> bool:
    if not extractor_image_needed(event):
        return False

    from backend.services.event_images import (
        delete_event_image,
        replace_event_image_from_url,
    )

    state = dict(event.extractor_state or {})
    payload = state.get("payload") or {}
    desired_url = payload.get("image", "")
    applied = dict(state.get("applied") or {})
    if desired_url:
        event.image_key = replace_event_image_from_url(
            event.event_id,
            desired_url,
            event.image_key,
        )
    else:
        delete_event_image(event.image_key)
        event.image_key = None
    applied["image"] = {"url": desired_url, "key": event.image_key}
    state["applied"] = applied
    event.extractor_state = state
    return True
