"""Geocoding enrichment stage.

Uses a multi-candidate strategy:
  1. Raw ``event.location`` text
  2. location + locale hint (if configured)
  3. Decoded Google Maps URLs from description
  4. Address-like fragments from description

Within each candidate, Google Geocoding API is tried first (if
``GOOGLE_GEOCODING_API_KEY`` is set), then Nominatim as fallback.
The winning query and provider are persisted for observability.
"""

from backend.db.models import CachedEvent
from backend.services.geocoding import geocode_candidates
from backend.services.location_candidates import extract_candidates
from backend.services.pipeline.base import EnrichmentStage


class GeocodingStage(EnrichmentStage):
    @property
    def name(self) -> str:
        return "geocoding"

    def should_process(self, event: CachedEvent) -> bool:
        return bool(event.location) and event.latitude is None

    def process(self, event: CachedEvent) -> bool:
        candidates = extract_candidates(
            location=event.location,
            description=event.description,
        )
        result = geocode_candidates(candidates)
        if result:
            coords, winning_query, provider = result
            event.latitude, event.longitude = coords
            event.geocode_query = winning_query
            event.geocode_provider = provider
            return True
        return False
