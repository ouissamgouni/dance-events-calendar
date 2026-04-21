"""Link extraction enrichment stage."""

import re

from backend.db.models import CachedEvent
from backend.services.pipeline.base import EnrichmentStage

_URL_PATTERN = re.compile(
    r"https?://[^\s<>\"')\]]+",
    re.IGNORECASE,
)


class LinkExtractionStage(EnrichmentStage):
    @property
    def name(self) -> str:
        return "link_extraction"

    def should_process(self, event: CachedEvent) -> bool:
        return bool(event.description) and event.links is None

    def process(self, event: CachedEvent) -> bool:
        urls = _URL_PATTERN.findall(event.description or "")
        if urls:
            # Deduplicate while preserving order
            seen: set[str] = set()
            unique: list[dict] = []
            for url in urls:
                normalized = url.rstrip(".,;:")
                if normalized not in seen:
                    seen.add(normalized)
                    unique.append({"url": normalized, "label": None})
            event.links = unique
            return True
        return False
