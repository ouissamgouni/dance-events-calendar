import copy
import logging
import threading
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Callable

logger = logging.getLogger(__name__)


def _utcnow_naive() -> datetime:
    """Return UTC now as naive datetime for compatibility with existing DB models."""
    return datetime.now(UTC).replace(tzinfo=None)


class SyncJobStatus:
    IDLE = "idle"
    RUNNING = "running"
    ABORT_REQUESTED = "abort_requested"
    ABORTED = "aborted"
    COMPLETED = "completed"
    WARNING = "warning"
    FAILED = "failed"


@dataclass
class SyncJobRecord:
    job_id: str
    status: str = SyncJobStatus.RUNNING
    started_at: datetime = field(default_factory=_utcnow_naive)
    finished_at: datetime | None = None
    heartbeat_at: datetime = field(default_factory=_utcnow_naive)
    mode: str = "incremental"
    since_date: str | None = None
    calendar_ids: list[str] = field(default_factory=list)
    abort_requested: bool = False
    warning_message: str | None = None
    error_message: str | None = None
    totals: dict[str, int] = field(
        default_factory=lambda: {
            "calendars_synced": 0,
            "events_fetched": 0,
            "events_upserted": 0,
            "events_deduped": 0,
            "events_deleted": 0,
            "events_enriched": 0,
            "events_failed": 0,
        }
    )
    stage_totals: dict[str, dict[str, int]] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)
    calendar_statuses: dict[str, dict] = field(default_factory=dict)
    # Capped, merged job-level log buffer for the JobDetailDrawer Logs tab.
    # Items: {"timestamp": iso, "level": str, "message": str, "calendar_id": str|None}.
    recent_logs: list[dict[str, Any]] = field(default_factory=list)
    last_persisted_at: datetime | None = field(default=None, repr=False)


class SyncJobService:
    """In-process sync-job manager used by admin API endpoints.

    The worker function receives `(job_id, service)` so it can emit heartbeats and
    progress updates while it runs.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._jobs: dict[str, SyncJobRecord] = {}
        self._history: list[str] = []
        self._active_job_id: str | None = None

    def start_job(
        self,
        worker: Callable[[str, "SyncJobService"], dict[str, Any] | None],
        mode: str = "incremental",
        since_date: str | None = None,
        calendar_ids: list[str] | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            active = self._get_active_locked()
            if active is not None:
                raise RuntimeError("A sync job is already running")

            job_id = str(uuid.uuid4())
            record = SyncJobRecord(
                job_id=job_id,
                mode=mode,
                since_date=since_date,
                calendar_ids=list(calendar_ids or []),
            )
            self._jobs[job_id] = record
            self._history.insert(0, job_id)
            self._active_job_id = job_id

        # Persist initial record (best-effort, outside the lock).
        self._persist_record(record, force=True)

        thread = threading.Thread(
            target=self._run_worker,
            args=(job_id, worker),
            daemon=True,
        )
        thread.start()
        return self.get_job(job_id)

    def _run_worker(
        self,
        job_id: str,
        worker: Callable[[str, "SyncJobService"], dict[str, Any] | None],
    ) -> None:
        try:
            result = worker(job_id, self) or {}
            with self._lock:
                record = self._jobs.get(job_id)
                if record is None:
                    return

                if record.abort_requested:
                    record.status = SyncJobStatus.ABORTED
                else:
                    status = result.get("status")
                    if status in {
                        SyncJobStatus.COMPLETED,
                        SyncJobStatus.WARNING,
                        SyncJobStatus.FAILED,
                    }:
                        record.status = status
                    else:
                        record.status = SyncJobStatus.COMPLETED

                if "warning_message" in result:
                    record.warning_message = result.get("warning_message")
                if "error_message" in result:
                    record.error_message = result.get("error_message")
                if "totals" in result and isinstance(result["totals"], dict):
                    record.totals.update(result["totals"])
                if "stage_totals" in result and isinstance(
                    result["stage_totals"], dict
                ):
                    record.stage_totals = result["stage_totals"]
                if "calendar_statuses" in result and isinstance(
                    result["calendar_statuses"], dict
                ):
                    record.calendar_statuses = result["calendar_statuses"]

                record.heartbeat_at = _utcnow_naive()
                record.finished_at = _utcnow_naive()
                if self._active_job_id == job_id:
                    self._active_job_id = None
        except Exception as exc:
            with self._lock:
                record = self._jobs.get(job_id)
                if record is None:
                    return
                record.status = SyncJobStatus.FAILED
                record.error_message = str(exc)
                record.heartbeat_at = _utcnow_naive()
                record.finished_at = _utcnow_naive()
                if self._active_job_id == job_id:
                    self._active_job_id = None

        # Persist final state outside the lock (best-effort).
        final = self._jobs.get(job_id)
        if final is not None:
            self._persist_record(final, force=True)
            try:
                self.prune_old_jobs()
            except Exception:
                logger.debug("prune after finalization failed", exc_info=True)

    def heartbeat(self, job_id: str) -> None:
        with self._lock:
            record = self._jobs.get(job_id)
            if record:
                record.heartbeat_at = _utcnow_naive()
        # Throttled persist (every _PERSIST_THROTTLE_SECONDS).
        if record is not None:
            self._persist_record(record)

    def update_totals(self, job_id: str, **totals: int) -> None:
        with self._lock:
            record = self._jobs.get(job_id)
            if record:
                record.totals.update(totals)
                record.heartbeat_at = _utcnow_naive()

    def update_stage_totals(self, job_id: str, stage_totals: dict[str, dict[str, int]]):
        with self._lock:
            record = self._jobs.get(job_id)
            if record:
                record.stage_totals = stage_totals
                record.heartbeat_at = _utcnow_naive()

    def set_metadata(self, job_id: str, **metadata: Any) -> None:
        with self._lock:
            record = self._jobs.get(job_id)
            if record:
                record.metadata.update(metadata)
                record.heartbeat_at = _utcnow_naive()

    def update_calendar_statuses(self, job_id: str, statuses: dict[str, dict]) -> None:
        with self._lock:
            record = self._jobs.get(job_id)
            if record:
                record.calendar_statuses = statuses
                record.heartbeat_at = _utcnow_naive()

    _RECENT_LOGS_CAP = 500

    def add_recent_log(
        self,
        job_id: str,
        level: str,
        message: str,
        calendar_id: str | None = None,
    ) -> None:
        """Append a log entry to the job-level merged log buffer (capped)."""
        with self._lock:
            record = self._jobs.get(job_id)
            if record is None:
                return
            record.recent_logs.append(
                {
                    "timestamp": _utcnow_naive().isoformat(),
                    "level": level,
                    "message": message,
                    "calendar_id": calendar_id,
                }
            )
            if len(record.recent_logs) > self._RECENT_LOGS_CAP:
                record.recent_logs = record.recent_logs[-self._RECENT_LOGS_CAP :]

    def should_abort(self, job_id: str) -> bool:
        with self._lock:
            record = self._jobs.get(job_id)
            return bool(record and record.abort_requested)

    def abort_job(self, job_id: str) -> dict[str, Any]:
        with self._lock:
            record = self._jobs.get(job_id)
            if record is None:
                raise KeyError(job_id)

            if record.status not in {
                SyncJobStatus.RUNNING,
                SyncJobStatus.ABORT_REQUESTED,
            }:
                return copy.deepcopy(self._serialize(record))

            record.abort_requested = True
            record.status = SyncJobStatus.ABORT_REQUESTED
            record.heartbeat_at = _utcnow_naive()
            return copy.deepcopy(self._serialize(record))

    def get_current_job(self) -> dict[str, Any] | None:
        with self._lock:
            active = self._get_active_locked()
            if active is not None:
                return copy.deepcopy(self._serialize(active))
            if not self._history:
                return None
            latest = self._jobs[self._history[0]]
            return copy.deepcopy(self._serialize(latest))

    def get_job(self, job_id: str) -> dict[str, Any]:
        with self._lock:
            record = self._jobs.get(job_id)
            if record is not None:
                return copy.deepcopy(self._serialize(record))
        # Fall back to DB for historical jobs after restart.
        persisted = self.get_job_persisted(job_id)
        if persisted is None:
            raise KeyError(job_id)
        return persisted

    def list_jobs(self, limit: int = 20, offset: int = 0) -> dict[str, Any]:
        """List jobs combining in-memory + DB-persisted history.

        In-memory entries (active or recently finished but not yet evicted)
        always shadow DB ones with the same ``job_id``.
        """
        with self._lock:
            mem_items = [self._serialize(self._jobs[jid]) for jid in self._history]
            mem_items = copy.deepcopy(mem_items)
        mem_ids = {it["job_id"] for it in mem_items}

        db = self.list_jobs_persisted(limit=max(limit + offset + 50, 100), offset=0)
        db_items = [it for it in db.get("items", []) if it["job_id"] not in mem_ids]

        merged = mem_items + db_items
        merged.sort(key=lambda it: it.get("started_at") or "", reverse=True)
        sliced = merged[offset : offset + limit]
        return {"items": sliced, "total": len(merged)}

    def _get_active_locked(self) -> SyncJobRecord | None:
        if self._active_job_id is None:
            return None
        record = self._jobs.get(self._active_job_id)
        if record and record.status in {
            SyncJobStatus.RUNNING,
            SyncJobStatus.ABORT_REQUESTED,
        }:
            return record
        self._active_job_id = None
        return None

    @staticmethod
    def _serialize(record: SyncJobRecord) -> dict[str, Any]:
        # Roll up per-calendar stage_stats into a job-level stage_totals view
        # so the UI doesn't need to merge them.
        stage_totals: dict[str, dict[str, int]] = dict(record.stage_totals or {})
        for cal_status in record.calendar_statuses.values():
            cal_stages = cal_status.get("stage_stats") or {}
            for stage_name, stats in cal_stages.items():
                bucket = stage_totals.setdefault(
                    stage_name, {"processed": 0, "skipped": 0, "failed": 0}
                )
                bucket["processed"] = bucket.get("processed", 0) + stats.get(
                    "processed", 0
                )
                bucket["skipped"] = bucket.get("skipped", 0) + stats.get("skipped", 0)
                bucket["failed"] = bucket.get("failed", 0) + stats.get("failed", 0)

        return {
            "job_id": record.job_id,
            "status": record.status,
            "started_at": record.started_at,
            "finished_at": record.finished_at,
            "heartbeat_at": record.heartbeat_at,
            "mode": record.mode,
            "since_date": record.since_date,
            "calendar_ids": list(record.calendar_ids),
            "abort_requested": record.abort_requested,
            "warning_message": record.warning_message,
            "error_message": record.error_message,
            "totals": dict(record.totals),
            "stage_totals": stage_totals,
            "metadata": copy.deepcopy(record.metadata),
            "calendar_statuses": copy.deepcopy(record.calendar_statuses),
            "is_stale": False,
        }

    # ------------------------------------------------------------------
    # DB persistence (best-effort — logged but never raised)
    # ------------------------------------------------------------------

    _PERSIST_THROTTLE_SECONDS = 5.0

    def _persist_record(self, record: SyncJobRecord, *, force: bool = False) -> None:
        """Persist (insert or update) the SyncJobRun row for ``record``.

        Throttled to once every ``_PERSIST_THROTTLE_SECONDS`` per record
        unless ``force=True`` (used at start, finalization, and abort).
        """
        now = _utcnow_naive()
        if (
            not force
            and record.last_persisted_at is not None
            and (now - record.last_persisted_at).total_seconds()
            < self._PERSIST_THROTTLE_SECONDS
        ):
            return
        # Mark the attempt up-front so the throttle still applies even when
        # the DB is unavailable (otherwise every heartbeat would re-open a
        # session and re-fail).
        record.last_persisted_at = now

        try:
            from sqlmodel import Session

            from backend.db.database import get_engine
            from backend.db.models import SyncJobRun

            payload = self._serialize(record)
            # JSON-safe copies (datetimes stay native — handled by SA JSON encoder for our cases)
            with Session(get_engine()) as session:
                row = session.get(SyncJobRun, record.job_id)
                if row is None:
                    row = SyncJobRun(job_id=record.job_id)
                row.status = payload["status"]
                row.mode = payload["mode"]
                row.since_date = payload["since_date"]
                row.started_at = record.started_at
                row.finished_at = record.finished_at
                row.heartbeat_at = record.heartbeat_at
                row.abort_requested = record.abort_requested
                row.warning_message = record.warning_message
                row.error_message = record.error_message
                row.totals_json = dict(record.totals)
                row.stage_totals_json = payload["stage_totals"]
                row.calendar_statuses_json = payload["calendar_statuses"]
                row.metadata_json = payload["metadata"]
                session.add(row)
                session.commit()
        except Exception:
            logger.debug(
                "SyncJobService: persist failed for job %s",
                record.job_id,
                exc_info=True,
            )

    # Persisted jobs whose heartbeat is older than this are considered stale
    # (the worker process likely crashed or the backend was restarted while
    # they were running). They are reported as ``failed`` to the UI rather
    # than left looking forever-running.
    _STALE_HEARTBEAT_SECONDS = 120.0

    @staticmethod
    def _row_to_dict(row) -> dict[str, Any]:
        """Convert a SyncJobRun row to the same dict shape ``_serialize`` produces."""
        status = row.status
        finished_at = row.finished_at
        error_message = row.error_message
        is_stale = False
        # Detect orphaned/stale "running" rows (worker crashed, backend
        # restarted mid-run, etc.). Without this, jobs would appear to be
        # running forever in Sync History.
        if status in {SyncJobStatus.RUNNING, SyncJobStatus.ABORT_REQUESTED}:
            ref_ts = row.heartbeat_at or row.started_at
            if ref_ts is not None:
                age = (_utcnow_naive() - ref_ts).total_seconds()
                if age > SyncJobService._STALE_HEARTBEAT_SECONDS:
                    status = SyncJobStatus.FAILED
                    is_stale = True
                    if finished_at is None:
                        finished_at = row.heartbeat_at or row.started_at
                    if not error_message:
                        error_message = (
                            f"Job marked stale (no heartbeat for {int(age)}s)."
                        )
        return {
            "job_id": row.job_id,
            "status": status,
            "started_at": row.started_at,
            "finished_at": finished_at,
            "heartbeat_at": row.heartbeat_at,
            "mode": row.mode,
            "since_date": row.since_date,
            "calendar_ids": [],
            "abort_requested": row.abort_requested,
            "warning_message": row.warning_message,
            "error_message": error_message,
            "totals": row.totals_json or {},
            "stage_totals": row.stage_totals_json or {},
            "metadata": row.metadata_json or {},
            "calendar_statuses": row.calendar_statuses_json or {},
            "is_stale": is_stale,
        }

    def list_jobs_persisted(self, limit: int = 50, offset: int = 0) -> dict[str, Any]:
        """List jobs from DB (for history across restarts)."""
        try:
            from sqlmodel import Session, select

            from backend.db.database import get_engine
            from backend.db.models import SyncJobRun

            with Session(get_engine()) as session:
                stmt = (
                    select(SyncJobRun)
                    .order_by(SyncJobRun.started_at.desc())
                    .offset(offset)
                    .limit(limit)
                )
                rows = list(session.exec(stmt).all())
                total = session.exec(
                    select(__import__("sqlalchemy").func.count(SyncJobRun.job_id))
                ).one()
                items = [self._row_to_dict(r) for r in rows]
                return {"items": items, "total": int(total)}
        except Exception:
            logger.debug("SyncJobService: list_jobs_persisted failed", exc_info=True)
            return {"items": [], "total": 0}

    def get_job_persisted(self, job_id: str) -> dict[str, Any] | None:
        try:
            from sqlmodel import Session

            from backend.db.database import get_engine
            from backend.db.models import SyncJobRun

            with Session(get_engine()) as session:
                row = session.get(SyncJobRun, job_id)
                if row is None:
                    return None
                return self._row_to_dict(row)
        except Exception:
            logger.debug(
                "SyncJobService: get_job_persisted failed for %s", job_id, exc_info=True
            )
            return None

    def prune_old_jobs(self, *, max_rows: int = 200, max_age_days: int = 30) -> int:
        """Delete old SyncJobRun rows: keep at most ``max_rows`` and only those
        within ``max_age_days``. Returns count deleted."""
        try:
            from datetime import timedelta

            from sqlmodel import Session, select

            from backend.db.database import get_engine
            from backend.db.models import SyncJobRun

            cutoff = _utcnow_naive() - timedelta(days=max_age_days)
            deleted = 0
            with Session(get_engine()) as session:
                # Age-based pruning
                old_rows = session.exec(
                    select(SyncJobRun).where(SyncJobRun.started_at < cutoff)
                ).all()
                for r in old_rows:
                    session.delete(r)
                    deleted += 1
                # Count-based pruning (after age prune)
                ordered = session.exec(
                    select(SyncJobRun).order_by(SyncJobRun.started_at.desc())
                ).all()
                for r in ordered[max_rows:]:
                    session.delete(r)
                    deleted += 1
                session.commit()
            return deleted
        except Exception:
            logger.debug("SyncJobService: prune_old_jobs failed", exc_info=True)
            return 0

        return {
            "job_id": record.job_id,
            "status": record.status,
            "started_at": record.started_at,
            "finished_at": record.finished_at,
            "heartbeat_at": record.heartbeat_at,
            "mode": record.mode,
            "since_date": record.since_date,
            "calendar_ids": list(record.calendar_ids),
            "abort_requested": record.abort_requested,
            "warning_message": record.warning_message,
            "error_message": record.error_message,
            "totals": dict(record.totals),
            "stage_totals": stage_totals,
            "metadata": copy.deepcopy(record.metadata),
            "calendar_statuses": copy.deepcopy(record.calendar_statuses),
        }

        return {
            "job_id": record.job_id,
            "status": record.status,
            "started_at": record.started_at,
            "finished_at": record.finished_at,
            "heartbeat_at": record.heartbeat_at,
            "mode": record.mode,
            "since_date": record.since_date,
            "calendar_ids": list(record.calendar_ids),
            "abort_requested": record.abort_requested,
            "warning_message": record.warning_message,
            "error_message": record.error_message,
            "totals": dict(record.totals),
            "stage_totals": stage_totals,
            "metadata": copy.deepcopy(record.metadata),
            "calendar_statuses": copy.deepcopy(record.calendar_statuses),
        }


_sync_job_service_singleton = SyncJobService()


def get_sync_job_service() -> SyncJobService:
    return _sync_job_service_singleton
