"""Extensible enrichment pipeline for post-sync event processing."""

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime

from sqlmodel import Session, col, select

from backend.db.models import CachedEvent

logger = logging.getLogger(__name__)


@dataclass
class StageResult:
    """Outcome of processing a single event through a stage."""

    processed: int = 0
    skipped: int = 0
    failed: int = 0


@dataclass
class PipelineProgress:
    """Aggregate progress across all stages."""

    stages: dict[str, StageResult] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            name: {"processed": r.processed, "skipped": r.skipped, "failed": r.failed}
            for name, r in self.stages.items()
        }


class EnrichmentStage(ABC):
    """Base class for an enrichment pipeline stage."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Unique stage identifier (e.g. 'geocoding')."""

    @abstractmethod
    def should_process(self, event: CachedEvent) -> bool:
        """Return True if this event needs processing by this stage."""

    @abstractmethod
    def process(self, event: CachedEvent) -> bool:
        """Enrich the event in-place. Return True on success, False on failure."""


class EnrichmentPipeline:
    """Runs events through a sequence of enrichment stages."""

    def __init__(self, stages: list[EnrichmentStage] | None = None):
        self.stages: list[EnrichmentStage] = stages or []

    def add_stage(self, stage: EnrichmentStage) -> "EnrichmentPipeline":
        self.stages.append(stage)
        return self

    def enrich(
        self,
        event: CachedEvent,
        on_stage_start: "callable | None" = None,
    ) -> dict[str, StageResult]:
        """Run all stages on a transient event buffer (no DB writes).

        Used by the parallel pipeline processor where persistence is performed
        separately after enrichment completes. Each stage mutates ``event`` in
        place. ``on_stage_start`` is called with the stage name before each
        stage runs so callers can update progress UI.
        """
        results: dict[str, StageResult] = {
            stage.name: StageResult() for stage in self.stages
        }
        for stage in self.stages:
            result = results[stage.name]
            if on_stage_start is not None:
                try:
                    on_stage_start(stage.name)
                except Exception:
                    logger.exception("on_stage_start callback failed")
            if not stage.should_process(event):
                result.skipped += 1
                continue
            try:
                ok = stage.process(event)
                if ok:
                    result.processed += 1
                else:
                    result.failed += 1
            except Exception:
                logger.exception(
                    "Stage %s failed for event %s", stage.name, event.event_id
                )
                result.failed += 1
        return results

    def process_event(
        self, session: Session, event: CachedEvent
    ) -> dict[str, StageResult]:
        """Run all stages on a single pre-loaded event.

        Designed for parallel enrichment where each worker owns its own session.
        The caller is responsible for loading the event and committing the session.
        """
        results: dict[str, StageResult] = {
            stage.name: StageResult() for stage in self.stages
        }
        if event.deleted_at is not None:
            return results
        for stage in self.stages:
            result = results[stage.name]
            if not stage.should_process(event):
                result.skipped += 1
                continue
            try:
                ok = stage.process(event)
                if ok:
                    result.processed += 1
                else:
                    result.failed += 1
            except Exception:
                logger.exception(
                    "Stage %s failed for event %s", stage.name, event.event_id
                )
                result.failed += 1
            session.add(event)
            session.commit()
        return results

    _CHUNK_SIZE = 50  # events loaded per DB query to cap peak memory

    def run(
        self,
        session: Session,
        event_ids: list[str],
        since_date: datetime | None = None,
    ) -> PipelineProgress:
        """Run all stages on the given events. Future events first, skip past events.

        Events are loaded in chunks of _CHUNK_SIZE to avoid materialising the full
        list in memory when syncing large calendars.
        """
        progress = PipelineProgress()
        for stage in self.stages:
            progress.stages[stage.name] = StageResult()

        for chunk_start in range(0, len(event_ids), self._CHUNK_SIZE):
            chunk_ids = event_ids[chunk_start : chunk_start + self._CHUNK_SIZE]

            events = session.exec(
                select(CachedEvent)
                .where(
                    CachedEvent.event_id.in_(chunk_ids),  # type: ignore[attr-defined]
                    CachedEvent.deleted_at == None,
                )
                .order_by(col(CachedEvent.start).desc())
            ).all()

            if since_date:
                events = [e for e in events if e.start >= since_date]

            for event in events:
                for stage in self.stages:
                    result = progress.stages[stage.name]
                    if not stage.should_process(event):
                        result.skipped += 1
                        continue
                    try:
                        ok = stage.process(event)
                        if ok:
                            result.processed += 1
                        else:
                            result.failed += 1
                    except Exception:
                        logger.exception(
                            "Stage %s failed for event %s", stage.name, event.event_id
                        )
                        result.failed += 1

                    # Commit per-event per-stage so progress is visible immediately
                    session.add(event)
                    session.commit()

        return progress
