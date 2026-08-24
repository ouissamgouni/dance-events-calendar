import logging
import os
import threading
import time
from typing import Optional

from geopy.exc import GeocoderServiceError, GeocoderTimedOut
from geopy.geocoders import Nominatim

logger = logging.getLogger(__name__)


def _language_preference_from_header(accept_language: Optional[str]) -> str:
    """Convert Accept-Language header to Nominatim language preference string.

    Preserves the inbound language order and quality weights, then appends
    English as a fallback only if no en/en-* range is already present.
    Returns 'en' if the header is missing.

    Examples:
    - None → 'en'
    - 'en-US,en;q=0.9' → 'en-US,en;q=0.9' (unchanged; English already present)
    - 'el-GR,el;q=0.9' → 'el-GR,el;q=0.9,en;q=0.5' (English appended)
    - 'fr,de;q=0.8' → 'fr,de;q=0.8,en;q=0.5' (English appended)
    """
    if not accept_language or not accept_language.strip():
        return "en"

    # Check if any en/en-* range is already present
    has_english = any(
        part.lower().strip().startswith(("en", "en-"))
        for part in accept_language.split(",")
    )

    if has_english:
        return accept_language
    # Append English with lower priority (q=0.5 is lower than typical user preferences)
    return f"{accept_language},en;q=0.5"


_geocoder = Nominatim(user_agent="movida", timeout=5)

# Cache only successful geocoding results (failures are retried on next sync)
_cache: dict[str, tuple[float, float]] = {}

# Cache successful reverse-geocoding results, keyed by rounded coordinates.
_reverse_cache: dict[str, tuple[Optional[str], Optional[str], Optional[str]]] = {}

# Circuit breaker: skip Nominatim after too many consecutive failures
_MAX_CONSECUTIVE_FAILURES = 5
_CIRCUIT_COOLDOWN = 300  # seconds to wait before retrying after circuit opens
_consecutive_failures = 0
_circuit_open_until = 0.0  # monotonic timestamp

# Nominatim usage policy: max 1 request per second
_last_request_time = 0.0
_MIN_REQUEST_INTERVAL = 1.1  # seconds between requests

_lock = threading.Lock()

# ---------------------------------------------------------------------------
# Google Geocoding provider (optional — requires GOOGLE_GEOCODING_API_KEY)
# ---------------------------------------------------------------------------
# None  = not yet checked
# False = checked, no key configured
# GoogleV3 instance = ready to use
_google_geocoder = None
_google_lock = threading.Lock()


def _get_google_geocoder():
    """Lazily initialise the Google geocoder. Returns None if no API key is set."""
    global _google_geocoder
    # Fast path (already resolved)
    if _google_geocoder is not None:
        return _google_geocoder if _google_geocoder is not False else None
    with _google_lock:
        if _google_geocoder is not None:
            return _google_geocoder if _google_geocoder is not False else None
        api_key = os.getenv("GOOGLE_GEOCODING_API_KEY")
        if api_key:
            try:
                from geopy.geocoders import GoogleV3

                _google_geocoder = GoogleV3(api_key=api_key, timeout=5)
                logger.info("Google Geocoding API configured")
            except Exception as exc:
                logger.warning("Failed to initialise Google geocoder: %s", exc)
                _google_geocoder = False
        else:
            _google_geocoder = False
    return _google_geocoder if _google_geocoder is not False else None


def _try_google(location: str) -> Optional[tuple[float, float]]:
    """Attempt geocoding via Google. Returns coords or None. Never raises."""
    geocoder = _get_google_geocoder()
    if geocoder is None:
        return None
    try:
        result = geocoder.geocode(location)
        if result:
            return (result.latitude, result.longitude)
    except Exception as exc:
        logger.debug("Google geocoding failed for '%s': %s", location, exc)
    return None


# ---------------------------------------------------------------------------
# Public APIs
# ---------------------------------------------------------------------------


def geocode_candidates(
    candidates: list[str],
) -> Optional[tuple[tuple[float, float], str, str]]:
    """Try each candidate string, Google-first then Nominatim.

    Google is tried for *all* candidates first (fast, no strict rate limit).
    Nominatim is used as a fallback (throttled, circuit-broken).

    Returns
    -------
    (coords, winning_query, provider) or None if all candidates fail.
    provider is one of: ``"google"``, ``"nominatim"``, ``"cache"``.
    """
    google_geo = _get_google_geocoder()

    # Phase 1: Google (no throttle, generous quota)
    if google_geo is not None:
        for candidate in candidates:
            cached = _cache.get(candidate)
            if cached is not None:
                return cached, candidate, "cache"
            coords = _try_google(candidate)
            if coords:
                logger.info(
                    "Google geocoded '%s' -> (%.4f, %.4f)",
                    candidate,
                    coords[0],
                    coords[1],
                )
                _cache[candidate] = coords
                return coords, candidate, "google"

    # Phase 2: Nominatim (throttled, circuit-broken)
    for candidate in candidates:
        cached = _cache.get(candidate)
        if cached is not None:
            return cached, candidate, "cache"
        coords = _try_nominatim(candidate)
        if coords:
            return coords, candidate, "nominatim"

    return None


def geocode_location(location: str) -> Optional[tuple[float, float]]:
    """Geocode a single location string. Returns (lat, lng) or None.

    Backward-compatible public API. Internally uses ``geocode_candidates``.
    """
    result = geocode_candidates([location])
    return result[0] if result else None


def search_locations(
    query: str, limit: int = 5, language: Optional[str] = None
) -> list[dict]:
    """Search for address suggestions (used by the admin geocode search UI).

    Prefers Google Geocoding API (if ``GOOGLE_GEOCODING_API_KEY`` is set),
    falls back to Nominatim with optional language preference.

    Parameters
    ----------
    query : str
        The address or location string to search for.
    limit : int
        Maximum number of results to return (default 5).
    language : str, optional
        Nominatim language preference string (e.g., 'en-US,en;q=0.9').
        If None, defaults to 'en'.

    Returns
    -------
    list of dicts with keys ``display_name``, ``latitude``, ``longitude``.
    """
    google_geo = _get_google_geocoder()
    if google_geo is not None:
        try:
            results = google_geo.geocode(query, exactly_one=False)
            if results:
                return [
                    {
                        "display_name": r.address,
                        "latitude": r.latitude,
                        "longitude": r.longitude,
                    }
                    for r in results[:limit]
                ]
        except Exception as exc:
            logger.warning("Google geocode search failed for '%s': %s", query, exc)

    # Fallback: Nominatim with language preference
    if language is None:
        language = "en"
    try:
        results = _geocoder.geocode(
            query, exactly_one=False, limit=limit, language=language
        )
        if results:
            return [
                {
                    "display_name": r.address,
                    "latitude": r.latitude,
                    "longitude": r.longitude,
                }
                for r in results[:limit]
            ]
    except Exception as exc:
        logger.warning("Nominatim geocode search failed for '%s': %s", query, exc)
    return []


# ---------------------------------------------------------------------------
# Reverse geocoding: coordinates -> structured place (city / country)
# ---------------------------------------------------------------------------

_Place = tuple[Optional[str], Optional[str], Optional[str]]

# Google address_component types to consult for the "city", best first.
_GOOGLE_CITY_TYPES = (
    "locality",
    "postal_town",
    "administrative_area_level_2",
    "administrative_area_level_1",
)


def _parse_google_place(raw: dict) -> Optional[_Place]:
    components = raw.get("address_components") or []
    by_type: dict[str, tuple[Optional[str], Optional[str]]] = {}
    for comp in components:
        for t in comp.get("types", []):
            by_type.setdefault(t, (comp.get("long_name"), comp.get("short_name")))
    city = None
    for t in _GOOGLE_CITY_TYPES:
        if t in by_type:
            city = by_type[t][0]
            break
    country = country_code = None
    if "country" in by_type:
        country = by_type["country"][0]
        short = by_type["country"][1]
        country_code = short.upper() if short else None
    if not city and not country:
        return None
    return city, country, country_code


def _parse_nominatim_place(address: dict) -> Optional[_Place]:
    city = (
        address.get("city")
        or address.get("town")
        or address.get("village")
        or address.get("municipality")
        or address.get("county")
    )
    country = address.get("country")
    code = address.get("country_code")
    country_code = code.upper() if code else None
    if not city and not country:
        return None
    return city, country, country_code


def _reverse_google(latitude: float, longitude: float) -> Optional[_Place]:
    geocoder = _get_google_geocoder()
    if geocoder is None:
        return None
    try:
        result = geocoder.reverse((latitude, longitude), exactly_one=True)
        if result and getattr(result, "raw", None):
            return _parse_google_place(result.raw)
    except Exception as exc:
        logger.debug(
            "Google reverse geocoding failed for (%s, %s): %s",
            latitude,
            longitude,
            exc,
        )
    return None


def _reverse_nominatim(latitude: float, longitude: float) -> Optional[_Place]:
    with _lock:
        if _consecutive_failures >= _MAX_CONSECUTIVE_FAILURES:
            if time.monotonic() < _circuit_open_until:
                return None
            logger.info("Geocoding circuit breaker reset, retrying")
            _reset_circuit_unlocked()
    _throttle()
    try:
        result = _geocoder.reverse(
            (latitude, longitude), exactly_one=True, language="en"
        )
        if result and getattr(result, "raw", None):
            place = _parse_nominatim_place(result.raw.get("address") or {})
            _record_success()
            return place
        logger.warning(
            "Reverse geocoding returned no result for (%s, %s)", latitude, longitude
        )
        return None
    except (GeocoderTimedOut, GeocoderServiceError) as e:
        logger.warning(
            "Reverse geocoding failed for (%s, %s): %s", latitude, longitude, e
        )
        _record_failure()
        return None
    except Exception:
        logger.exception(
            "Unexpected reverse geocoding error for (%s, %s)", latitude, longitude
        )
        _record_failure()
        return None


def reverse_geocode(latitude: float, longitude: float) -> Optional[_Place]:
    """Resolve coordinates to a structured place.

    Returns ``(city, country, country_code)`` (any element may be ``None``) or
    ``None`` if neither provider could resolve a place. Google is tried first
    (generous quota), then Nominatim (throttled, circuit-broken). Successful
    lookups are cached by rounded coordinates.
    """
    key = f"{round(latitude, 4)},{round(longitude, 4)}"
    cached = _reverse_cache.get(key)
    if cached is not None:
        return cached
    place = _reverse_google(latitude, longitude)
    if place is None:
        place = _reverse_nominatim(latitude, longitude)
    if place is not None:
        _reverse_cache[key] = place
    return place


# ---------------------------------------------------------------------------
# Nominatim internals (circuit breaker + throttle)
# ---------------------------------------------------------------------------


def _try_nominatim(location: str) -> Optional[tuple[float, float]]:
    """Try Nominatim with circuit-breaker guard. Returns coords or None."""
    with _lock:
        if _consecutive_failures >= _MAX_CONSECUTIVE_FAILURES:
            if time.monotonic() < _circuit_open_until:
                return None
            logger.info("Geocoding circuit breaker reset, retrying")
            _reset_circuit_unlocked()
    return _do_geocode(location)


def _reset_circuit_unlocked():
    """Reset circuit breaker state. Caller MUST hold _lock."""
    global _consecutive_failures, _circuit_open_until
    _consecutive_failures = 0
    _circuit_open_until = 0.0


def _record_failure():
    global _consecutive_failures, _circuit_open_until
    with _lock:
        _consecutive_failures += 1
        if _consecutive_failures >= _MAX_CONSECUTIVE_FAILURES:
            _circuit_open_until = time.monotonic() + _CIRCUIT_COOLDOWN
            logger.warning(
                "Geocoding circuit breaker opened after %d failures, pausing for %ds",
                _consecutive_failures,
                _CIRCUIT_COOLDOWN,
            )


def _record_success():
    global _consecutive_failures
    with _lock:
        _consecutive_failures = 0


def _throttle():
    """Respect Nominatim's 1 req/sec rate limit."""
    global _last_request_time
    with _lock:
        now = time.monotonic()
        elapsed = now - _last_request_time
        wait = max(0.0, _MIN_REQUEST_INTERVAL - elapsed)
        _last_request_time = now + wait
    if wait:
        time.sleep(wait)


def _do_geocode(location: str) -> Optional[tuple[float, float]]:
    """Make the actual Nominatim geocoding call (not cached on failure)."""
    _throttle()
    try:
        result = _geocoder.geocode(location)
        if result:
            coords = (result.latitude, result.longitude)
            logger.info(
                "Geocoded '%s' -> (%.4f, %.4f)",
                location,
                result.latitude,
                result.longitude,
            )
            _cache[location] = coords
            _record_success()
            return coords
        logger.warning("Geocoding returned no result for '%s'", location)
        return None
    except (GeocoderTimedOut, GeocoderServiceError) as e:
        logger.warning("Geocoding failed for '%s': %s", location, e)
        _record_failure()
        return None
    except Exception:
        logger.exception("Unexpected geocoding error for '%s'", location)
        _record_failure()
        return None


def _reset_state():
    """Reset all module state. For testing only."""
    global \
        _consecutive_failures, \
        _circuit_open_until, \
        _last_request_time, \
        _google_geocoder
    with _lock:
        _consecutive_failures = 0
        _circuit_open_until = 0.0
        _last_request_time = 0.0
    _cache.clear()
    _reverse_cache.clear()
    # Reset lazy Google geocoder so tests that patch the env var take effect
    with _google_lock:
        _google_geocoder = None
