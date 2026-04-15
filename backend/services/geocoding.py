import logging
from functools import lru_cache

from geopy.exc import GeocoderTimedOut, GeocoderServiceError
from geopy.geocoders import Nominatim

logger = logging.getLogger(__name__)

_geocoder = Nominatim(user_agent="salsa-events-calendar", timeout=5)


def geocode_location(location: str) -> tuple[float, float] | None:
    """Geocode a text location to (latitude, longitude). Returns None on failure."""
    result = _cached_geocode(location)
    return result


@lru_cache(maxsize=256)
def _cached_geocode(location: str) -> tuple[float, float] | None:
    try:
        result = _geocoder.geocode(location)
        if result:
            logger.info(
                "Geocoded '%s' -> (%.4f, %.4f)",
                location,
                result.latitude,
                result.longitude,
            )
            return (result.latitude, result.longitude)
        logger.warning("Geocoding returned no result for '%s'", location)
        return None
    except (GeocoderTimedOut, GeocoderServiceError) as e:
        logger.warning("Geocoding failed for '%s': %s", location, e)
        return None
    except Exception:
        logger.exception("Unexpected geocoding error for '%s'", location)
        return None
