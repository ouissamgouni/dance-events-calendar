import math

from backend.db.models import UserInterestProfile


def haversine_km(lat_a: float, lng_a: float, lat_b: float, lng_b: float) -> float:
    earth_radius_km = 6371.0
    lat_delta = math.radians(lat_b - lat_a)
    lng_delta = math.radians(lng_b - lng_a)
    start_lat = math.radians(lat_a)
    end_lat = math.radians(lat_b)
    haversine = (
        math.sin(lat_delta / 2) ** 2
        + math.cos(start_lat) * math.cos(end_lat) * math.sin(lng_delta / 2) ** 2
    )
    return earth_radius_km * 2 * math.asin(min(1.0, math.sqrt(haversine)))


def profile_contains_point(
    profile: UserInterestProfile, lat: float, lng: float
) -> bool:
    if not (
        profile.min_lat <= lat <= profile.max_lat
        and profile.min_lng <= lng <= profile.max_lng
    ):
        return False
    if profile.geo_kind != "radius":
        return True
    if None in (profile.center_lat, profile.center_lng, profile.radius_km):
        return False
    return (
        haversine_km(profile.center_lat, profile.center_lng, lat, lng)
        <= profile.radius_km
    )
