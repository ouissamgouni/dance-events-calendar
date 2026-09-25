from backend.db.models import CachedEvent
from backend.services.event_extractor import (
    apply_extractor_image,
    extractor_image_needed,
)
from backend.services.pipeline.base import EnrichmentStage


class ExtractorImageStage(EnrichmentStage):
    @property
    def name(self) -> str:
        return "extractor_image"

    def should_process(self, event: CachedEvent) -> bool:
        return extractor_image_needed(event)

    def process(self, event: CachedEvent) -> bool:
        apply_extractor_image(event)
        return True
