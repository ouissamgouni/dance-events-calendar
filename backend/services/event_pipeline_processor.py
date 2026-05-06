"""Streaming event pipeline processor.

Events submitted by CalendarSyncWorkers flow into a bounded queue.
EnrichmentWorkers pull tasks, run the enrichment pipeline on a transient
event buffer, then upsert (with content-hash dedup) and commit — all in a
single transaction per event. Mirrors the trades-exporter parallel pipeline
where persistence is the LAST stage so the DB never sees an unenriched event.

Architecture:
    CalendarSyncWorker × N  ──►  bounded Queue  ──►  EnrichmentWorker × M
                                                       (enrich → persist, single commit)
"""

import logging
import queue
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import Enum

from sqlmodel import Session, select

from backend.db.database import get_engine
from backend.db.models import CachedEvent, EventCalendarSource, EventTag
from backend.services.calendar.base import CalendarEvent
from backend.services.pipeline.base import EnrichmentPipeline
from backend.services.sync_service import compute_content_hash

logger = logging.getLogger(__name__)

_POISON = object()  # sentinel value to signal workers to exit


# ---------------------------------------------------------------------------
# Thread-local context: which calendar is the current thread working on?
# Used by JobLogHandler to route stdlib log records to the right CalendarProgress.
# ---------------------------------------------------------------------------

_thread_ctx = threading.local()


def set_current_calendar_id(calendar_id: str | None) -> None:
    _thread_ctx.calendar_id = calendar_id


def get_current_calendar_id() -> str | None:
    return getattr(_thread_ctx, "calendar_id", None)


class JobLogHandler(logging.Handler):
    """Routes stdlib log records emitted from worker threads into the right
    CalendarProgress.logs list, so users see them live in the UI.

    Resolves the calendar via the thread-local context set by
    CalendarSyncWorker / EventPipelineProcessor before invoking stages.
    Records without a known calendar are pushed to the job-level log buffer
    via the optional ``global_log_callback``.
    """

    def __init__(
        self,
        progress_map: dict,
        global_log_callback=None,
        level: int = logging.INFO,
    ) -> None:
        super().__init__(level=level)
        self._progress_map = progress_map
        self._global_log_callback = global_log_callback

    def emit(self, record: logging.LogRecord) -> None:  # noqa: D401
        try:
            msg = self.format(record)
            cal_id = get_current_calendar_id()
            if cal_id and cal_id in self._progress_map:
                self._progress_map[cal_id].add_log(record.levelname, msg)
                # Also append to the job-level merged buffer (if provided) so
                # the JobDetailDrawer Logs tab shows a unified stream.
                if self._global_log_callback is not None:
                    try:
                        # Best-effort with calendar_id kw if the callback accepts it.
                        self._global_log_callback(record.levelname, msg)
                    except Exception:
                        pass
            elif self._global_log_callback is not None:
                self._global_log_callback(record.levelname, msg)
        except Exception:
            # Never let logging failures break worker threads (avoids
            # cascading [Errno 9] Bad file descriptor errors etc.).
            pass


class PipelineStage(str, Enum):
    """High-level stages an event flows through inside an enrichment worker."""

    LINK_EXTRACTION = "link_extraction"
    PRICE_EXTRACTION = "price_extraction"
    GEOCODING = "geocoding"
    TAG_SUGGESTION = "tag_suggestion"
    PERSISTENCE = "persistence"


class FailureType(str, Enum):
    """Categorised failure surfaced to the UI's Errors tab + filter chips."""

    UNGEOLOCATED = "ungeolocated"
    ENRICHMENT_EXCEPTION = "enrichment_exception"
    PERSISTENCE_FAILED = "persistence_failed"


# Maps the enrichment stage that produced a `failed` StageResult to its
# user-facing failure type. Only stages whose `failed` count represents an
# actual problem belong here. Link/price extraction stages no longer report
# `failed` for "nothing to extract" — those are normal outcomes — so they
# are intentionally absent.
_STAGE_FAILURE_TYPE: dict[str, FailureType] = {
    PipelineStage.GEOCODING.value: FailureType.UNGEOLOCATED,
}


# Stages that come from the EnrichmentPipeline (used to preallocate stage_stats).
_ENRICHMENT_STAGE_NAMES = (
    PipelineStage.LINK_EXTRACTION.value,
    PipelineStage.PRICE_EXTRACTION.value,
    PipelineStage.GEOCODING.value,
    PipelineStage.TAG_SUGGESTION.value,
)
_ALL_STAGE_NAMES = _ENRICHMENT_STAGE_NAMES + (PipelineStage.PERSISTENCE.value,)


# ---------------------------------------------------------------------------
# Data types
# ---------------------------------------------------------------------------


def _utcnow_iso() -> str:
    return datetime.now(UTC).replace(tzinfo=None).isoformat()


@dataclass
class LogEntry:
    timestamp: str
    level: str  # DEBUG | INFO | WARNING | ERROR
    message: str

    def to_dict(self) -> dict:
        return {
            "timestamp": self.timestamp,
            "level": self.level,
            "message": self.message,
        }


@dataclass
class FailureEntry:
    """A single typed failure for one event — surfaced in the Errors tab."""

    timestamp: str
    event_id: str
    title: str
    stage: str  # PipelineStage value (e.g. 'geocoding')
    type: str  # FailureType value (e.g. 'ungeolocated')
    message: str

    def to_dict(self) -> dict:
        return {
            "timestamp": self.timestamp,
            "event_id": self.event_id,
            "title": self.title,
            "stage": self.stage,
            "type": self.type,
            "message": self.message,
        }


@dataclass
class ProcessedEventSummary:
    event_id: str
    title: str
    start_dt: str
    location: str | None
    action: str  # new | updated | unchanged | deduped | failed | processing
    pipeline_stage: str | None = None  # current stage (set while in flight)
    geocode_provider: str | None = None
    price: str | None = None
    links_count: int | None = None
    error: str | None = None

    def to_dict(self) -> dict:
        return {
            "event_id": self.event_id,
            "title": self.title,
            "start_dt": self.start_dt,
            "location": self.location,
            "action": self.action,
            "pipeline_stage": self.pipeline_stage,
            "geocode_provider": self.geocode_provider,
            "price": self.price,
            "links_count": self.links_count,
            "error": self.error,
        }


@dataclass
class StageStats:
    """Per-stage success/failed/skipped counters for one calendar."""

    processed: int = 0
    skipped: int = 0
    failed: int = 0

    def to_dict(self) -> dict:
        return {
            "processed": self.processed,
            "skipped": self.skipped,
            "failed": self.failed,
        }


@dataclass
class CalendarProgress:
    """Per-calendar live counters and event log — updated by enrichment workers."""

    calendar_id: str
    calendar_name: str
    status: str = (
        "queued"  # queued | running | processing | completed | warning | failed
    )
    fetched: int = 0
    upserted: int = 0
    deduped: int = 0
    enriched_ok: int = 0
    enriched_failed: int = 0
    error_count: int = 0
    started_at: str | None = None
    finished_at: str | None = None
    error: str | None = None
    current_operation: str | None = (
        None  # human-readable: e.g. "Geocoding 'Salsa Night'"
    )
    pipeline_stage: str | None = None  # last PipelineStage value

    # Private (not constructor params)
    lock: threading.Lock = field(
        default_factory=threading.Lock, init=False, repr=False, compare=False
    )
    logs: list = field(default_factory=list, init=False, repr=False, compare=False)
    processed_events: list = field(
        default_factory=list, init=False, repr=False, compare=False
    )
    stage_stats: dict = field(
        default_factory=dict, init=False, repr=False, compare=False
    )
    failures: list = field(default_factory=list, init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        # Preallocate stage stats so the UI can render all stages from the start.
        self.stage_stats = {name: StageStats() for name in _ALL_STAGE_NAMES}

    # --- Thread-safe counter helpers ---

    def inc_fetched(self) -> None:
        with self.lock:
            self.fetched += 1

    def inc_upserted(self) -> None:
        with self.lock:
            self.upserted += 1

    def inc_deduped(self) -> None:
        with self.lock:
            self.deduped += 1

    def inc_enriched_ok(self) -> None:
        with self.lock:
            self.enriched_ok += 1

    def inc_enriched_failed(self) -> None:
        with self.lock:
            self.enriched_failed += 1
            self.error_count += 1

    def set_current(self, operation: str | None, stage: str | None) -> None:
        with self.lock:
            self.current_operation = operation
            self.pipeline_stage = stage

    def record_stage_result(
        self, stage_name: str, *, processed: int = 0, failed: int = 0, skipped: int = 0
    ) -> None:
        with self.lock:
            stats = self.stage_stats.get(stage_name)
            if stats is None:
                stats = StageStats()
                self.stage_stats[stage_name] = stats
            stats.processed += processed
            stats.failed += failed
            stats.skipped += skipped

    def add_log(self, level: str, message: str) -> None:
        entry = LogEntry(timestamp=_utcnow_iso(), level=level, message=message)
        with self.lock:
            self.logs.append(entry)
            if len(self.logs) > 500:
                self.logs = self.logs[-500:]

    def add_failure(
        self,
        *,
        event_id: str,
        title: str,
        stage: str,
        failure_type: "FailureType",
        message: str,
    ) -> None:
        entry = FailureEntry(
            timestamp=_utcnow_iso(),
            event_id=event_id,
            title=title,
            stage=stage,
            type=failure_type.value,
            message=message,
        )
        with self.lock:
            self.failures.append(entry)
            if len(self.failures) > 1000:
                self.failures = self.failures[-1000:]

    def add_processed_event(self, summary: ProcessedEventSummary) -> None:
        with self.lock:
            # Replace existing entry for the same event_id (in-flight → finished)
            for i, e in enumerate(self.processed_events):
                if e.event_id == summary.event_id:
                    self.processed_events[i] = summary
                    return
            self.processed_events.append(summary)
            if len(self.processed_events) > 500:
                self.processed_events = self.processed_events[-500:]

    def to_dict(self) -> dict:
        with self.lock:
            return {
                "calendar_id": self.calendar_id,
                "calendar_name": self.calendar_name,
                "status": self.status,
                "fetched": self.fetched,
                "upserted": self.upserted,
                "deduped": self.deduped,
                "enriched_ok": self.enriched_ok,
                "enriched_failed": self.enriched_failed,
                "error_count": self.error_count,
                "started_at": self.started_at,
                "finished_at": self.finished_at,
                "error": self.error,
                "current_operation": self.current_operation,
                "pipeline_stage": self.pipeline_stage,
                "stage_stats": {k: v.to_dict() for k, v in self.stage_stats.items()},
                "logs": [e.to_dict() for e in self.logs],
                "processed_events": [e.to_dict() for e in self.processed_events],
                "failures": [e.to_dict() for e in self.failures],
            }


@dataclass
class EventTask:
    """A single event to be upserted and enriched by a worker."""

    calendar_event: CalendarEvent
    calendar_id: str
    default_tag_ids: list[int]
    abort_event: threading.Event


# ---------------------------------------------------------------------------
# Pipeline processor
# ---------------------------------------------------------------------------


class EventPipelineProcessor:
    """Bounded-queue + worker-pool that upserts and enriches events concurrently.

    Usage::

        processor = EventPipelineProcessor(pipeline, progress_map, abort_event)
        processor.start()

        # In calendar fetch threads:
        processor.submit(EventTask(...))  # blocks when queue is full

        # After all calendars are done:
        processor.stop()  # drains queue, shuts down workers
    """

    def __init__(
        self,
        pipeline: EnrichmentPipeline,
        progress_map: dict[str, CalendarProgress],
        abort_event: threading.Event,
        num_workers: int = 4,
        max_queue_size: int = 500,
    ):
        self._pipeline = pipeline
        self._progress_map = progress_map
        self._abort_event = abort_event
        self._num_workers = num_workers
        self._queue: queue.Queue = queue.Queue(maxsize=max_queue_size)
        self._executor: ThreadPoolExecutor | None = None
        self._futures = []

    def start(self) -> None:
        """Spawn enrichment worker threads."""
        self._executor = ThreadPoolExecutor(
            max_workers=self._num_workers,
            thread_name_prefix="event-pipeline-worker",
        )
        self._futures = [
            self._executor.submit(self._worker, i) for i in range(self._num_workers)
        ]

    def submit(self, task: EventTask) -> None:
        """Enqueue a task. Blocks when the queue is full (natural backpressure).

        Drops the task silently if abort is requested.
        """
        if self._abort_event.is_set():
            return
        self._queue.put(task)

    def stop(self) -> None:
        """Send poison pills, wait for all items to drain, shut down executor."""
        for _ in range(self._num_workers):
            self._queue.put(_POISON)
        self._queue.join()
        if self._executor:
            self._executor.shutdown(wait=True)

    def abort(self) -> None:
        """Hard-stop: drain all queued tasks immediately, then shut down workers.

        Drops any tasks waiting in the queue (they were never started). Workers
        already mid-event will finish their current item; the abort_event flag
        prevents them from picking up new work after that.
        """
        # Empty the queue without processing
        try:
            while True:
                item = self._queue.get_nowait()
                self._queue.task_done()
                if item is _POISON:
                    # Re-inject so each worker sees one
                    self._queue.put(_POISON)
                    break
        except queue.Empty:
            pass
        # Now signal a clean shutdown
        for _ in range(self._num_workers):
            self._queue.put(_POISON)
        self._queue.join()
        if self._executor:
            self._executor.shutdown(wait=True)

    # ------------------------------------------------------------------
    # Worker internals
    # ------------------------------------------------------------------

    def _worker(self, worker_id: int) -> None:
        logger.debug("EventPipelineProcessor worker-%d started", worker_id)
        while True:
            item = self._queue.get()
            if item is _POISON:
                self._queue.task_done()
                break
            if self._abort_event.is_set():
                # Drop the task without processing
                self._queue.task_done()
                continue
            try:
                self._process_one(item)
            except Exception:
                logger.exception(
                    "Worker-%d: unhandled error processing event %s",
                    worker_id,
                    item.calendar_event.event_id,
                )
            finally:
                set_current_calendar_id(None)
                self._queue.task_done()
        logger.debug("EventPipelineProcessor worker-%d exiting", worker_id)

    def _process_one(self, task: EventTask) -> None:
        from sqlmodel import Session as DBSession

        engine = get_engine()
        progress = self._progress_map.get(task.calendar_id)
        cal_event = task.calendar_event

        # Tag this thread so stdlib log records emitted by helpers
        # (geocoding, link_extraction, etc.) get routed to this calendar.
        set_current_calendar_id(task.calendar_id)

        # Mark this event as in-flight so the UI can show its current stage.
        if progress:
            progress.add_processed_event(
                ProcessedEventSummary(
                    event_id=cal_event.event_id,
                    title=cal_event.title,
                    start_dt=cal_event.start.isoformat(),
                    location=cal_event.location,
                    action="processing",
                    pipeline_stage=None,
                )
            )

        # ------------------------------------------------------------------
        # Step 1 — Build a transient CachedEvent buffer (no DB yet).
        # Stages mutate this buffer in place. Persistence happens at the end
        # in a single commit, so the DB never sees an unenriched event.
        # ------------------------------------------------------------------
        buffer = CachedEvent(
            event_id=cal_event.event_id,
            calendar_id=cal_event.calendar_id,
            title=cal_event.title,
            description=cal_event.description,
            location=cal_event.location,
            start=cal_event.start,
            end=cal_event.end,
            all_day=cal_event.all_day,
            content_hash=compute_content_hash(
                cal_event.title, cal_event.start, cal_event.location
            ),
        )

        # ------------------------------------------------------------------
        # Step 2 — Run enrichment stages on the buffer (no DB writes).
        # ------------------------------------------------------------------
        def _on_stage_start(stage_name: str) -> None:
            if progress:
                progress.set_current(
                    operation=f"{stage_name}: {cal_event.title}",
                    stage=stage_name,
                )
                progress.add_processed_event(
                    ProcessedEventSummary(
                        event_id=cal_event.event_id,
                        title=cal_event.title,
                        start_dt=cal_event.start.isoformat(),
                        location=cal_event.location,
                        action="processing",
                        pipeline_stage=stage_name,
                    )
                )

        try:
            stage_results = self._pipeline.enrich(
                buffer, on_stage_start=_on_stage_start
            )
        except Exception as exc:
            logger.exception("Enrichment phase failed for event %s", cal_event.event_id)
            if progress:
                progress.inc_enriched_failed()
                progress.set_current(None, None)
                # Enrichment failures are non-fatal (the event still won't be
                # persisted, but the sync continues) — surface as WARNING, not ERROR.
                msg = f"{cal_event.title}: enrichment {type(exc).__name__}: {exc}"
                progress.add_log("WARNING", msg)
                progress.add_failure(
                    event_id=cal_event.event_id,
                    title=cal_event.title,
                    stage="enrichment",
                    failure_type=FailureType.ENRICHMENT_EXCEPTION,
                    message=msg,
                )
                progress.add_processed_event(
                    ProcessedEventSummary(
                        event_id=cal_event.event_id,
                        title=cal_event.title,
                        start_dt=cal_event.start.isoformat(),
                        location=cal_event.location,
                        action="failed",
                        error=str(exc),
                    )
                )
            return

        # Roll up per-stage stats onto the calendar progress.
        if progress:
            for stage_name, result in stage_results.items():
                progress.record_stage_result(
                    stage_name,
                    processed=result.processed,
                    skipped=result.skipped,
                    failed=result.failed,
                )
                # Record one typed failure per failed enrichment stage so the
                # Errors tab can group/filter by type (ungeolocated, etc.).
                if result.failed > 0 and stage_name in _STAGE_FAILURE_TYPE:
                    progress.add_failure(
                        event_id=cal_event.event_id,
                        title=cal_event.title,
                        stage=stage_name,
                        failure_type=_STAGE_FAILURE_TYPE[stage_name],
                        message=f"{stage_name} returned no result for: {cal_event.location or '(no location)'}",
                    )

        # Abort gate before touching the DB
        if task.abort_event.is_set():
            if progress:
                progress.set_current(None, None)
            return

        # ------------------------------------------------------------------
        # Step 3 — PERSISTENCE stage: dedup + upsert + tag/source rows + commit.
        # Single transaction, single commit per event.
        # ------------------------------------------------------------------
        if progress:
            progress.set_current(
                operation=f"persistence: {cal_event.title}",
                stage=PipelineStage.PERSISTENCE.value,
            )

        try:
            with DBSession(engine) as session:
                db_event, action = self._persist_with_dedup(session, task, buffer)
                session.commit()
                # Snapshot attributes BEFORE the session closes — otherwise
                # accessing them later raises DetachedInstanceError because
                # commit() expires loaded attributes by default.
                persisted_event_id = db_event.event_id
                persisted_title = db_event.title
                persisted_location = db_event.location
                persisted_geocode_provider = db_event.geocode_provider
                persisted_price = (
                    str(db_event.price_min) if db_event.price_min is not None else None
                )
                persisted_links_count = len(db_event.links) if db_event.links else 0
        except Exception as exc:
            logger.exception("Persistence failed for event %s", cal_event.event_id)
            if progress:
                progress.record_stage_result(PipelineStage.PERSISTENCE.value, failed=1)
                progress.inc_enriched_failed()
                progress.set_current(None, None)
                msg = f"{cal_event.title}: {type(exc).__name__}: {exc}"
                progress.add_log("ERROR", msg)
                progress.add_failure(
                    event_id=cal_event.event_id,
                    title=cal_event.title,
                    stage=PipelineStage.PERSISTENCE.value,
                    failure_type=FailureType.PERSISTENCE_FAILED,
                    message=msg,
                )
                progress.add_processed_event(
                    ProcessedEventSummary(
                        event_id=cal_event.event_id,
                        title=cal_event.title,
                        start_dt=cal_event.start.isoformat(),
                        location=cal_event.location,
                        action="failed",
                        error=str(exc),
                    )
                )
            return

        # ------------------------------------------------------------------
        # Step 4 — Update progress counters / processed-event row.
        # ------------------------------------------------------------------
        if progress:
            progress.set_current(None, None)
            progress.record_stage_result(PipelineStage.PERSISTENCE.value, processed=1)

            if action == "deduped":
                progress.inc_deduped()
                progress.add_log("INFO", f"Deduped: {cal_event.title}")
                progress.add_processed_event(
                    ProcessedEventSummary(
                        event_id=persisted_event_id,
                        title=cal_event.title,
                        start_dt=cal_event.start.isoformat(),
                        location=cal_event.location,
                        action="deduped",
                        geocode_provider=persisted_geocode_provider,
                        price=persisted_price,
                        links_count=persisted_links_count,
                    )
                )
                return

            if action == "unchanged":
                # Re-pulled from upstream but nothing actually changed.
                # Don't bump upserted/enriched counters — just record the row.
                progress.add_processed_event(
                    ProcessedEventSummary(
                        event_id=persisted_event_id,
                        title=persisted_title,
                        start_dt=cal_event.start.isoformat(),
                        location=persisted_location,
                        action="unchanged",
                        geocode_provider=persisted_geocode_provider,
                        price=persisted_price,
                        links_count=persisted_links_count,
                    )
                )
                return

            progress.inc_upserted()
            # Geocoding may have failed for this event (no provider hit), but
            # the event is still persisted with whatever data we have. We
            # surface those as `failures` of type UNGEOLOCATED (warnings) but
            # NOT as `enriched_failed` — that counter is reserved for genuine
            # errors (exceptions, persistence failures).
            progress.inc_enriched_ok()

            progress.add_log(
                "INFO",
                f"{'New' if action == 'new' else 'Updated'}: {cal_event.title}",
            )

            if (
                stage_results.get("geocoding")
                and stage_results["geocoding"].processed > 0
            ):
                progress.add_log(
                    "INFO",
                    f"Geocoded: {persisted_title} → {persisted_geocode_provider}",
                )

            progress.add_processed_event(
                ProcessedEventSummary(
                    event_id=persisted_event_id,
                    title=persisted_title,
                    start_dt=cal_event.start.isoformat(),
                    location=persisted_location,
                    action=action,
                    geocode_provider=persisted_geocode_provider,
                    price=persisted_price,
                    links_count=persisted_links_count,
                )
            )

    def _persist_with_dedup(
        self, session: Session, task: EventTask, buffer: CachedEvent
    ) -> tuple[CachedEvent, str]:
        """Persist an enriched event buffer with content-hash dedup.

        Returns (db_event, action) where action is 'new', 'updated', or 'deduped'.
        Single transaction; the caller is responsible for ``session.commit()``.
        """
        from datetime import datetime as _dt

        existing = session.get(CachedEvent, buffer.event_id)
        if existing:
            # Detect whether this re-pull actually changes anything.
            content_unchanged = existing.content_hash == buffer.content_hash
            new_geocode = existing.latitude is None and buffer.latitude is not None
            new_price = existing.price_min is None and buffer.price_min is not None
            new_links = existing.links is None and buffer.links is not None
            if content_unchanged and not (new_geocode or new_price or new_links):
                # No-op re-pull from upstream — still upsert calendar source link
                # (cheap, idempotent) but skip the row write.
                _upsert_calendar_source(session, buffer.event_id, task.calendar_id)
                return existing, "unchanged"

            # Known event ID — update fields (including any enriched columns)
            fields_changed = (
                existing.title != buffer.title
                or existing.description != buffer.description
                or existing.location != buffer.location
                or existing.start != buffer.start
                or existing.end != buffer.end
                or existing.all_day != buffer.all_day
            )
            existing.title = buffer.title
            existing.description = buffer.description
            existing.location = buffer.location
            existing.start = buffer.start
            existing.end = buffer.end
            existing.all_day = buffer.all_day
            existing.content_hash = buffer.content_hash
            existing.updated_at = _dt.utcnow()
            existing.deleted_at = None
            # Apply newly-enriched fields only when missing (don't clobber human edits).
            if existing.latitude is None and buffer.latitude is not None:
                existing.latitude = buffer.latitude
                existing.longitude = buffer.longitude
                existing.geocode_query = buffer.geocode_query
                existing.geocode_provider = buffer.geocode_provider
            if existing.price_min is None and buffer.price_min is not None:
                existing.price_min = buffer.price_min
                existing.price_max = buffer.price_max
                existing.price_currency = buffer.price_currency
                existing.price_is_free = buffer.price_is_free
            if existing.links is None and buffer.links is not None:
                existing.links = buffer.links
            if fields_changed:
                existing.review_status = "pending"
            session.add(existing)
            _upsert_calendar_source(session, buffer.event_id, task.calendar_id)
            return existing, "updated"

        # Unknown event ID — check for content-hash duplicate
        canonical = session.exec(
            select(CachedEvent).where(
                CachedEvent.content_hash == buffer.content_hash,
                CachedEvent.deleted_at == None,  # noqa: E711
            )
        ).first()

        if canonical:
            logger.info(
                "Duplicate detected: '%s' (incoming_id=%s) matches canonical %s — merging",
                buffer.title,
                buffer.event_id,
                canonical.event_id,
            )
            for tag_id in task.default_tag_ids:
                _upsert_event_tag(session, canonical.event_id, tag_id)
            _upsert_calendar_source(session, canonical.event_id, task.calendar_id)
            return canonical, "deduped"

        # Genuinely new event — buffer is already a CachedEvent with all enriched fields.
        session.add(buffer)
        for tag_id in task.default_tag_ids:
            session.add(EventTag(event_id=buffer.event_id, tag_id=tag_id))
        _upsert_calendar_source(session, buffer.event_id, task.calendar_id)
        return buffer, "new"


# ---------------------------------------------------------------------------
# Private session helpers (duplicated from sync_service to avoid coupling)
# ---------------------------------------------------------------------------


def _upsert_calendar_source(session: Session, event_id: str, calendar_id: str) -> None:
    existing = session.exec(
        select(EventCalendarSource).where(
            EventCalendarSource.event_id == event_id,
            EventCalendarSource.calendar_id == calendar_id,
        )
    ).first()
    if not existing:
        session.add(EventCalendarSource(event_id=event_id, calendar_id=calendar_id))


def _upsert_event_tag(session: Session, event_id: str, tag_id: int) -> None:
    existing = session.exec(
        select(EventTag).where(
            EventTag.event_id == event_id,
            EventTag.tag_id == tag_id,
        )
    ).first()
    if not existing:
        session.add(EventTag(event_id=event_id, tag_id=tag_id))
