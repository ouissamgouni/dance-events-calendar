"""Price extraction enrichment stage."""

from backend.db.models import CachedEvent
from backend.services.pipeline.base import EnrichmentStage
from backend.services.price_extractor import extract_price


class PriceExtractionStage(EnrichmentStage):
    @property
    def name(self) -> str:
        return "price_extraction"

    def should_process(self, event: CachedEvent) -> bool:
        return bool(event.description) and event.price_min is None

    def process(self, event: CachedEvent) -> bool:
        price = extract_price(event.description)
        if price:
            event.price_min = price["min"]
            event.price_max = price["max"]
            event.price_currency = price["currency"]
            event.price_is_free = price["is_free"]
            return True
        return False
