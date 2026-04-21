"""Geocoding enrichment stage."""

from backend.db.models import CachedEvent
from backend.services.geocoding import geocode_location
from backend.services.pipeline.base import EnrichmentStage


class GeocodingStage(EnrichmentStage):
    @property
    def name(self) -> str:
        return "geocoding"

    def should_process(self, event: CachedEvent) -> bool:
        return bool(event.location) and event.latitude is None

    def process(self, event: CachedEvent) -> bool:
        coords = geocode_location(event.location)
        if coords:
            event.latitude, event.longitude = coords
            return True
        return False
