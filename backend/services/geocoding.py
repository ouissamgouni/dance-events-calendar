import logging
import threading
import time

from geopy.exc import GeocoderTimedOut, GeocoderServiceError
from geopy.geocoders import Nominatim

logger = logging.getLogger(__name__)

_geocoder = Nominatim(user_agent="movida", timeout=5)

# Cache only successful geocoding results (failures are retried on next sync)
_cache: dict[str, tuple[float, float]] = {}

# Circuit breaker: skip geocoding after too many consecutive failures
_MAX_CONSECUTIVE_FAILURES = 5
_CIRCUIT_COOLDOWN = 300  # seconds to wait before retrying after circuit opens
_consecutive_failures = 0
_circuit_open_until = 0.0  # monotonic timestamp

# Nominatim usage policy: max 1 request per second
_last_request_time = 0.0
_MIN_REQUEST_INTERVAL = 1.1  # seconds between requests

_lock = threading.Lock()


def geocode_location(location: str) -> tuple[float, float] | None:
    """Geocode a text location to (latitude, longitude). Returns None on failure."""
    # Check success cache first (no lock needed — dict reads are thread-safe in CPython
    # and stale reads are harmless here)
    cached = _cache.get(location)
    if cached is not None:
        return cached

    # Check circuit breaker
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
        if elapsed < _MIN_REQUEST_INTERVAL:
            wait = _MIN_REQUEST_INTERVAL - elapsed
        else:
            wait = 0
        _last_request_time = now + wait
    if wait:
        time.sleep(wait)


def _do_geocode(location: str) -> tuple[float, float] | None:
    """Make the actual geocoding call (not cached on failure)."""
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
    global _consecutive_failures, _circuit_open_until, _last_request_time
    with _lock:
        _consecutive_failures = 0
        _circuit_open_until = 0.0
        _last_request_time = 0.0
    _cache.clear()
