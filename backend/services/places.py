"""Place autocomplete for location inputs: known venues + Geoapify / Photon.

The public Nominatim API forbids autocomplete, so search-as-you-type goes to
Geoapify (behind the ``geoapify_enabled`` flag) with Photon as the fallback.
"""

import logging
import os
import threading
import time
from datetime import datetime, timezone
from typing import Literal, Optional

import httpx
from sqlalchemy import func, or_
from sqlmodel import Session, col, select

from backend.db.models import CachedEvent
from backend.services import app_settings
from backend.services.event_visibility import apply_event_visibility
from backend.services.geocoding import _PLACE_KIND_LABELS

logger = logging.getLogger(__name__)

Kind = Literal["any", "venue", "city"]

PLACE_FIELDS = ("venue_name", "street_address", "place_id", "place_provider")
GEO_FIELDS = ("city", "country", "country_code")
SUGGESTION_PLACE_FIELDS = PLACE_FIELDS + GEO_FIELDS

GEOAPIFY_URL = "https://api.geoapify.com/v1/geocode/autocomplete"
PHOTON_URL = "https://photon.komoot.io/api/"
PHOTON_LANGS = {"de", "en", "fr"}
_HEADERS = {"User-Agent": "movida"}
_TIMEOUT = 3.0
_CACHE_TTL = 24 * 3600
_CACHE_MAX = 1000

_cache: dict[tuple, tuple[float, list[dict]]] = {}
_budget_day: Optional[str] = None
_budget_used = 0
_lock = threading.Lock()

_GEOAPIFY_KINDS = {
    "amenity": "poi",
    "street": "address",
    "suburb": "locality",
    "postcode": "locality",
    "district": "district",
    "city": "city",
    "county": "county",
    "state": "region",
    "country": "country",
}

_PHOTON_KINDS = {
    "street": "address",
    "locality": "locality",
    "district": "district",
    "city": "city",
    "county": "county",
    "state": "region",
    "country": "country",
}


def primary_language(accept_language: Optional[str]) -> str:
    tag = (accept_language or "").split(",")[0].split(";")[0].split("-")[0]
    tag = tag.strip().lower()
    return tag if len(tag) == 2 and tag.isalpha() else "en"


def _join(*parts: Optional[str]) -> Optional[str]:
    return " ".join(p for p in parts if p) or None


def _context(name: str, parts: list[Optional[str]]) -> Optional[str]:
    seen: list[str] = []
    for part in parts:
        if part and part != name and part not in seen:
            seen.append(part)
    return ", ".join(seen) or None


def _suggestion(
    *,
    display_name: str,
    latitude: float,
    longitude: float,
    name: str,
    context: Optional[str],
    place_kind: str,
    provider: Optional[str],
    source: str = "provider",
    **extra,
) -> dict:
    return {
        "display_name": display_name,
        "latitude": latitude,
        "longitude": longitude,
        "name": name,
        "context": context,
        "place_kind": place_kind,
        "type_label": _PLACE_KIND_LABELS[place_kind],
        "provider": provider,
        "source": source,
        **extra,
    }


def geoapify_suggestion(raw: dict) -> Optional[dict]:
    lat, lon = raw.get("lat"), raw.get("lon")
    if lat is None or lon is None:
        return None
    result_type = raw.get("result_type") or "unknown"
    kind = _GEOAPIFY_KINDS.get(result_type, "unknown")
    if result_type == "building":
        kind = "poi" if raw.get("name") else "address"
    name = raw.get("name") or raw.get("address_line1") or raw.get("formatted")
    bbox = raw.get("bbox") or {}
    bounding_box = None
    if {"lon1", "lat1", "lon2", "lat2"} <= bbox.keys():
        bounding_box = {
            "min_lat": min(bbox["lat1"], bbox["lat2"]),
            "min_lng": min(bbox["lon1"], bbox["lon2"]),
            "max_lat": max(bbox["lat1"], bbox["lat2"]),
            "max_lng": max(bbox["lon1"], bbox["lon2"]),
        }
    code = raw.get("country_code")
    return _suggestion(
        display_name=raw.get("formatted") or name,
        latitude=lat,
        longitude=lon,
        name=name,
        context=_context(name, [raw.get("address_line2")]),
        place_kind=kind,
        provider="geoapify",
        place_id=raw.get("place_id"),
        street_address=_join(raw.get("street"), raw.get("housenumber")),
        city=raw.get("city"),
        region=raw.get("state"),
        country=raw.get("country"),
        country_code=code.upper() if code else None,
        bounding_box=bounding_box,
        timezone=(raw.get("timezone") or {}).get("name"),
    )


def photon_suggestion(feature: dict) -> Optional[dict]:
    props = feature.get("properties") or {}
    coords = (feature.get("geometry") or {}).get("coordinates") or []
    if len(coords) != 2:
        return None
    lon, lat = coords
    named = bool(props.get("name"))
    kind = _PHOTON_KINDS.get(props.get("type") or "", "poi" if named else "unknown")
    if props.get("type") == "house":
        kind = "poi" if named else "address"
    street = _join(props.get("street"), props.get("housenumber"))
    city = props.get("city")
    name = props.get("name") or street or city or ""
    if not name:
        return None
    locality = _join(props.get("postcode"), city)
    country = props.get("country")
    display = _context("", [name, street, locality, country])
    if kind in {"poi", "address"}:
        context = _context(name, [street, city, country])
    else:
        context = _context(name, [props.get("state"), country])
    extent = props.get("extent")
    bounding_box = None
    if isinstance(extent, list) and len(extent) == 4:
        west, north, east, south = extent
        bounding_box = {
            "min_lat": min(north, south),
            "min_lng": min(west, east),
            "max_lat": max(north, south),
            "max_lng": max(west, east),
        }
    code = props.get("countrycode")
    osm_type, osm_id = props.get("osm_type"), props.get("osm_id")
    return _suggestion(
        display_name=display or name,
        latitude=lat,
        longitude=lon,
        name=name,
        context=context,
        place_kind=kind,
        provider="photon",
        place_id=f"{osm_type}{osm_id}" if osm_type and osm_id else None,
        street_address=street,
        city=city,
        region=props.get("state"),
        country=country,
        country_code=code.upper() if code else None,
        bounding_box=bounding_box,
    )


def _daily_budget() -> int:
    try:
        return int(os.getenv("GEOAPIFY_DAILY_BUDGET", "2500"))
    except ValueError:
        return 2500


def _take_budget() -> bool:
    # Per-process soft cap that keeps us inside Geoapify's free daily credits.
    global _budget_day, _budget_used
    today = datetime.now(timezone.utc).date().isoformat()
    with _lock:
        if _budget_day != today:
            _budget_day, _budget_used = today, 0
        if _budget_used >= _daily_budget():
            return False
        _budget_used += 1
        return True


def _search_geoapify(
    api_key: str,
    query: str,
    kind: Kind,
    lang: str,
    near: Optional[tuple[float, float]],
    limit: int,
) -> Optional[list[dict]]:
    params: dict = {
        "text": query,
        "format": "json",
        "limit": limit,
        "lang": lang,
        "apiKey": api_key,
    }
    if kind == "city":
        params["type"] = "city"
    if near:
        params["bias"] = f"proximity:{near[1]},{near[0]}"
    try:
        response = httpx.get(GEOAPIFY_URL, params=params, timeout=_TIMEOUT)
        response.raise_for_status()
        results = response.json().get("results") or []
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning("Geoapify autocomplete failed: %s", exc)
        return None
    return [s for s in map(geoapify_suggestion, results) if s]


def _search_photon(
    query: str,
    kind: Kind,
    lang: str,
    near: Optional[tuple[float, float]],
    limit: int,
) -> list[dict]:
    params: dict = {
        "q": query,
        "limit": limit,
        "lang": lang if lang in PHOTON_LANGS else "default",
    }
    if kind == "city":
        params["layer"] = "city"
    if near:
        params["lat"], params["lon"] = near
    try:
        response = httpx.get(
            PHOTON_URL, params=params, headers=_HEADERS, timeout=_TIMEOUT
        )
        response.raise_for_status()
        features = response.json().get("features") or []
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning("Photon autocomplete failed: %s", exc)
        return []
    return [s for s in map(photon_suggestion, features) if s]


def autocomplete(
    session: Session,
    query: str,
    *,
    kind: Kind = "any",
    lang: str = "en",
    near: Optional[tuple[float, float]] = None,
    limit: int = 5,
) -> list[dict]:
    api_key = os.getenv("GEOAPIFY_API_KEY")
    use_geoapify = bool(api_key) and app_settings.get_geoapify_enabled(session)
    rounded = (round(near[0], 1), round(near[1], 1)) if near else None
    key = (use_geoapify, " ".join(query.lower().split()), kind, lang, rounded, limit)
    now = time.monotonic()
    with _lock:
        hit = _cache.get(key)
    if hit and hit[0] > now:
        return hit[1]

    results = None
    if use_geoapify and _take_budget():
        results = _search_geoapify(api_key, query, kind, lang, near, limit)
    if results is None:
        results = _search_photon(query, kind, lang, near, limit)

    if results:
        with _lock:
            if len(_cache) >= _CACHE_MAX:
                _cache.pop(next(iter(_cache)))
            _cache[key] = (now + _CACHE_TTL, results)
    return results


def known_venues(session: Session, query: str, limit: int = 3) -> list[dict]:
    """Locations of visible events matching ``query``, most used first."""
    escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    pattern = f"%{escaped}%"
    columns = (
        CachedEvent.location,
        CachedEvent.latitude,
        CachedEvent.longitude,
        CachedEvent.venue_name,
        CachedEvent.street_address,
        CachedEvent.city,
        CachedEvent.country,
        CachedEvent.country_code,
        CachedEvent.timezone,
        CachedEvent.place_id,
        CachedEvent.place_provider,
    )
    statement = (
        select(*columns, func.count().label("uses"))
        .where(
            col(CachedEvent.location).is_not(None),
            col(CachedEvent.latitude).is_not(None),
            col(CachedEvent.longitude).is_not(None),
            or_(
                col(CachedEvent.location).ilike(pattern, escape="\\"),
                col(CachedEvent.venue_name).ilike(pattern, escape="\\"),
            ),
        )
        .group_by(*columns)
        .order_by(func.count().desc())
        .limit(limit * 5)
    )
    statement = apply_event_visibility(statement, session)

    venues: list[dict] = []
    seen: set[str] = set()
    for row in session.exec(statement).all():
        location = row.location.strip()
        if not location or location.lower() in seen:
            continue
        seen.add(location.lower())
        name = row.venue_name or location.split(",")[0].strip()
        venues.append(
            _suggestion(
                display_name=location,
                latitude=row.latitude,
                longitude=row.longitude,
                name=name,
                context=_context(name, [row.street_address, row.city, row.country])
                or _context(name, [location]),
                place_kind="poi",
                provider=row.place_provider,
                source="known",
                place_id=row.place_id,
                street_address=row.street_address,
                city=row.city,
                country=row.country,
                country_code=row.country_code,
                timezone=row.timezone,
            )
        )
        if len(venues) == limit:
            break
    return venues


def merge_suggestions(known: list[dict], found: list[dict]) -> list[dict]:
    """Known venues first; drop provider hits that repeat one of them."""

    def same(a: dict, b: dict) -> bool:
        return (
            abs(a["latitude"] - b["latitude"]) < 0.001
            and abs(a["longitude"] - b["longitude"]) < 0.0015
            and (a.get("name") or "").lower() == (b.get("name") or "").lower()
        )

    return known + [f for f in found if not any(same(f, k) for k in known)]


def clear_stale_place(
    changes: dict,
    current_location: Optional[str],
    fields: tuple[str, ...] = PLACE_FIELDS,
) -> None:
    """A location changed without a picked place drops the old place."""
    if changes.get("location", current_location) == current_location:
        return
    if any(changes.get(field) for field in PLACE_FIELDS):
        return
    for field in fields:
        changes.setdefault(field, None)
