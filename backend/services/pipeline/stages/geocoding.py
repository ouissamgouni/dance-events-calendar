"""Geocoding enrichment stage.

Uses a multi-candidate strategy:
  1. Raw ``event.location`` text
  2. location + locale hint (if configured)
  3. Decoded Google Maps URLs from description
  4. Address-like fragments from description

Within each candidate, Google Geocoding API is tried first (if
``GOOGLE_GEOCODING_API_KEY`` is set), then Nominatim as fallback.
The winning query and provider are persisted for observability.

Once coordinates are known, the stage reverse-geocodes them into a
structured ``city`` / ``country`` / ``country_code`` (used by the Dance
Passport geography stats).
"""

from backend.db.models import CachedEvent
from backend.services.geocoding import geocode_candidates, reverse_geocode
from backend.services.location_candidates import extract_candidates
from backend.services.pipeline.base import EnrichmentStage


class GeocodingStage(EnrichmentStage):
    @property
    def name(self) -> str:
        return "geocoding"

    def should_process(self, event: CachedEvent) -> bool:
        needs_coords = bool(event.location) and event.latitude is None
        needs_place = event.latitude is not None and event.country is None
        return needs_coords or needs_place

    def process(self, event: CachedEvent) -> bool:
        changed = False
        if event.latitude is None:
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
                changed = True
        # Derive the structured place (city / country) from coordinates once we
        # have them, so the Dance Passport stats have geography to aggregate.
        if (
            event.latitude is not None
            and event.longitude is not None
            and event.country is None
        ):
            place = reverse_geocode(event.latitude, event.longitude)
            if place:
                city, country, country_code = place
                if city and not event.city:
                    event.city = city
                if country:
                    event.country = country
                if country_code:
                    event.country_code = country_code
                changed = True
        return changed
