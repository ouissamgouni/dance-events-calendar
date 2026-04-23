import ipaddress
import logging

import httpx

logger = logging.getLogger(__name__)


def _is_private_ip(ip: str) -> bool:
    try:
        return ipaddress.ip_address(ip).is_private
    except ValueError:
        return True


async def geolocate_ip(ip: str) -> dict | None:
    """Resolve IP to city/country/lat/lon via ip-api.com. Returns None on failure."""
    if _is_private_ip(ip):
        return None

    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(
                f"https://ip-api.com/json/{ip}?fields=status,city,country,lat,lon"
            )
            data = resp.json()
            if data.get("status") == "success":
                return {
                    "city": data.get("city"),
                    "country": data.get("country"),
                    "lat": data.get("lat"),
                    "lon": data.get("lon"),
                }
    except Exception:
        logger.warning("IP geolocation failed for %s", ip, exc_info=True)

    return None
