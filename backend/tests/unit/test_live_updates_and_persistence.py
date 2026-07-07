"""Critical unit tests for the live-update + persistence layer added in
Phases 0/3 of the trades-exporter alignment.

Covers:
- ``JobLogHandler`` routes records to the right CalendarProgress based on the
  thread-local context, falls back to a global callback otherwise, and never
  raises (to avoid cascading [Errno 9] errors).
- ``SyncJobService`` persistence hooks (start/finalize/heartbeat) are best-effort
  and don't crash the worker when the DB is unavailable.
- ``SyncJobService.list_jobs`` and ``get_job`` correctly merge in-memory state
  with persisted history, with in-memory always shadowing DB for the same id.
- Heartbeat persistence is throttled by ``_PERSIST_THROTTLE_SECONDS``.
- ``prune_old_jobs`` is a best-effort no-op when the DB is unavailable.
"""

from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timedelta, timezone

import pytest

from backend.services.event_pipeline_processor import (
    CalendarProgress,
    JobLogHandler,
    get_current_calendar_id,
    set_current_calendar_id,
)
from backend.services.sync_job_service import (
    SyncJobRecord,
    SyncJobService,
    SyncJobStatus,
)


# ---------------------------------------------------------------------------
# JobLogHandler
# ---------------------------------------------------------------------------


@pytest.mark.unit
class TestJobLogHandler:
    def setup_method(self) -> None:
        # Reset any leaked thread-local from a previous test.
        set_current_calendar_id(None)

    def teardown_method(self) -> None:
        set_current_calendar_id(None)

    def _make_logger(self, handler: logging.Handler) -> logging.Logger:
        """Build an isolated logger so other tests' handlers don't interfere."""
        name = f"test_job_log_handler.{id(handler)}"
        log = logging.getLogger(name)
        log.handlers.clear()
        log.addHandler(handler)
        log.setLevel(logging.DEBUG)
        log.propagate = False
        return log

    def test_routes_record_to_progress_by_thread_local(self) -> None:
        cal_a = CalendarProgress(calendar_id="A", calendar_name="A")
        cal_b = CalendarProgress(calendar_id="B", calendar_name="B")
        handler = JobLogHandler({"A": cal_a, "B": cal_b})
        handler.setFormatter(logging.Formatter("%(message)s"))
        log = self._make_logger(handler)

        set_current_calendar_id("A")
        log.warning("from-A")
        set_current_calendar_id("B")
        log.error("from-B")

        assert [(e.level, e.message) for e in cal_a.logs] == [("WARNING", "from-A")]
        assert [(e.level, e.message) for e in cal_b.logs] == [("ERROR", "from-B")]

    def test_falls_back_to_global_when_no_thread_local(self) -> None:
        cal_a = CalendarProgress(calendar_id="A", calendar_name="A")
        captured: list[tuple[str, str]] = []
        handler = JobLogHandler(
            {"A": cal_a},
            global_log_callback=lambda level, msg: captured.append((level, msg)),
        )
        handler.setFormatter(logging.Formatter("%(message)s"))
        log = self._make_logger(handler)

        # No set_current_calendar_id() ⇒ thread-local is None.
        log.warning("orphan")

        assert cal_a.logs == []
        assert captured == [("WARNING", "orphan")]

    def test_unknown_calendar_falls_back_to_global(self) -> None:
        cal_a = CalendarProgress(calendar_id="A", calendar_name="A")
        captured: list[tuple[str, str]] = []
        handler = JobLogHandler(
            {"A": cal_a},
            global_log_callback=lambda level, msg: captured.append((level, msg)),
        )
        handler.setFormatter(logging.Formatter("%(message)s"))
        log = self._make_logger(handler)

        set_current_calendar_id("UNKNOWN")
        log.info("stray")

        assert cal_a.logs == []
        assert captured == [("INFO", "stray")]

    def test_emit_swallows_exceptions(self) -> None:
        # Simulate a crashing progress.add_log to verify emit() never raises.
        class ExplodingProgress:
            def add_log(self, level, message):
                raise OSError(9, "Bad file descriptor")

        handler = JobLogHandler({"A": ExplodingProgress()})  # type: ignore[arg-type]
        handler.setFormatter(logging.Formatter("%(message)s"))
        log = self._make_logger(handler)

        set_current_calendar_id("A")
        # Should NOT raise — the whole point of the try/except in emit().
        log.warning("boom")

    def test_thread_local_isolation_between_threads(self) -> None:
        # set_current_calendar_id in one thread must not leak into another.
        results: dict[str, str | None] = {}
        ev = threading.Event()

        def reader(name: str) -> None:
            ev.wait()
            results[name] = get_current_calendar_id()

        t = threading.Thread(target=reader, args=("worker",))
        t.start()

        set_current_calendar_id("MAIN")
        ev.set()
        t.join()

        assert results["worker"] is None
        assert get_current_calendar_id() == "MAIN"


# ---------------------------------------------------------------------------
# SyncJobService persistence + merging
# ---------------------------------------------------------------------------


def _wait_until(predicate, timeout: float = 2.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


def _track_worker_threads(monkeypatch: pytest.MonkeyPatch) -> list[threading.Thread]:
    """Patch ``threading.Thread`` so every thread spawned by
    ``SyncJobService.start_job`` during the test is recorded.

    ``_run_worker`` keeps running (heartbeat -> status flip -> persist ->
    prune) after the status a test asserts on has already changed. Without
    joining it, a slow CI runner can let that thread survive into the *next*
    test, where it picks up whatever ``get_engine`` that test has
    monkeypatched and silently corrupts its call-count assertions. Callers
    must join the returned threads before the test returns.
    """
    threads: list[threading.Thread] = []
    real_thread = threading.Thread

    def tracking_thread(*args, **kwargs):
        thread = real_thread(*args, **kwargs)
        threads.append(thread)
        return thread

    monkeypatch.setattr(threading, "Thread", tracking_thread)
    return threads


@pytest.mark.unit
class TestSyncJobServicePersistence:
    """All of these run without a real DB engine — _persist_record's
    try/except swallows the failure and falls back to in-memory only.
    """

    def test_persist_record_is_best_effort_no_db(self, monkeypatch) -> None:
        service = SyncJobService()
        threads = _track_worker_threads(monkeypatch)

        def worker(job_id, svc):
            svc.heartbeat(job_id)
            return {"status": SyncJobStatus.COMPLETED}

        started = service.start_job(worker=worker)
        job_id = started["job_id"]

        assert _wait_until(
            lambda: service.get_job(job_id)["status"] == SyncJobStatus.COMPLETED
        )
        # Job is still retrievable even though no DB row was actually written.
        assert service.get_job(job_id)["job_id"] == job_id

        # Wait for the worker thread's post-status-flip persist/prune tail to
        # finish so it can't leak into a later test (see _track_worker_threads).
        for thread in threads:
            thread.join(timeout=2.0)

    def test_heartbeat_persist_is_throttled(self, monkeypatch) -> None:
        """The first heartbeat opens a session; subsequent ones within
        ``_PERSIST_THROTTLE_SECONDS`` short-circuit before touching the DB.
        """
        service = SyncJobService()

        # Count actual DB-engine acquisitions to measure throttle effectiveness.
        engine_acquires: list[int] = []

        def fake_get_engine():
            engine_acquires.append(1)
            raise RuntimeError("no DB in unit test")

        monkeypatch.setattr(
            "backend.db.database.get_engine", fake_get_engine, raising=False
        )

        # Pre-seed an in-memory record so heartbeat() finds it.
        record = SyncJobRecord(
            job_id="j-throttle",
            mode="incremental",
        )
        with service._lock:
            service._jobs[record.job_id] = record

        # Burst of heartbeats — only the first should attempt persistence.
        for _ in range(10):
            service.heartbeat(record.job_id)

        # First call attempts DB; remaining 9 are throttled.
        assert len(engine_acquires) == 1

    def test_list_jobs_in_memory_only(self, monkeypatch) -> None:
        service = SyncJobService()
        threads = _track_worker_threads(monkeypatch)

        def worker(job_id, svc):
            return {"status": SyncJobStatus.COMPLETED}

        ids = []
        for _ in range(3):
            r = service.start_job(worker=worker)
            ids.append(r["job_id"])
            assert _wait_until(
                lambda jid=r["job_id"]: (
                    service.get_job(jid)["status"] == SyncJobStatus.COMPLETED
                )
            )
        for thread in threads:
            thread.join(timeout=2.0)

        result = service.list_jobs(limit=10)
        returned_ids = [j["job_id"] for j in result["items"]]
        assert set(ids).issubset(set(returned_ids))
        # Newest first.
        started_at = [j["started_at"] for j in result["items"]]
        assert started_at == sorted(started_at, reverse=True)

    def test_get_job_falls_back_to_db_lookup(self, monkeypatch) -> None:
        """When job_id is not in memory, get_job calls get_job_persisted."""
        service = SyncJobService()
        sentinel = {
            "job_id": "from-db",
            "status": SyncJobStatus.COMPLETED,
            "started_at": "2025-01-01T00:00:00+00:00",
            "finished_at": "2025-01-01T00:01:00+00:00",
            "totals": {},
            "stage_totals": {},
            "calendar_statuses": {},
            "metadata": {},
        }
        monkeypatch.setattr(
            service,
            "get_job_persisted",
            lambda jid: sentinel if jid == "from-db" else None,
        )

        with pytest.raises(KeyError):
            service.get_job("does-not-exist")

        assert service.get_job("from-db") == sentinel

    def test_list_jobs_merges_in_memory_and_db(self, monkeypatch) -> None:
        """In-memory jobs shadow DB rows with the same id; otherwise merged
        and sorted newest-first."""
        service = SyncJobService()

        # Seed in-memory: job "shared" + "memonly".
        now = datetime.now(timezone.utc)
        mem_shared = SyncJobRecord(
            job_id="shared",
            mode="incremental",
            started_at=now,
            status=SyncJobStatus.RUNNING,
        )
        mem_only = SyncJobRecord(
            job_id="memonly",
            mode="incremental",
            started_at=now - timedelta(seconds=5),
            status=SyncJobStatus.COMPLETED,
        )
        with service._lock:
            service._jobs[mem_shared.job_id] = mem_shared
            service._jobs[mem_only.job_id] = mem_only
            service._history = [mem_shared.job_id, mem_only.job_id]

        # Fake DB returns: "shared" (stale view) + "dbonly".
        db_items = [
            {
                "job_id": "shared",
                "status": SyncJobStatus.COMPLETED,  # stale!
                "started_at": now - timedelta(seconds=1),
                "finished_at": None,
                "totals": {},
                "stage_totals": {},
                "calendar_statuses": {},
                "metadata": {},
            },
            {
                "job_id": "dbonly",
                "status": SyncJobStatus.COMPLETED,
                "started_at": now - timedelta(seconds=10),
                "finished_at": now - timedelta(seconds=9),
                "totals": {},
                "stage_totals": {},
                "calendar_statuses": {},
                "metadata": {},
            },
        ]

        monkeypatch.setattr(
            service,
            "list_jobs_persisted",
            lambda limit, offset: {"items": db_items, "total": len(db_items)},
        )

        result = service.list_jobs(limit=10)
        ids = [j["job_id"] for j in result["items"]]

        # All three appear, no duplicate "shared".
        assert sorted(ids) == ["dbonly", "memonly", "shared"]

        # In-memory "shared" wins over DB "shared" (status=RUNNING).
        shared = next(j for j in result["items"] if j["job_id"] == "shared")
        assert shared["status"] == SyncJobStatus.RUNNING

        # Sorted newest first: shared (now) > memonly (-5s) > dbonly (-10s).
        assert ids == ["shared", "memonly", "dbonly"]

    def test_prune_old_jobs_is_best_effort_no_db(self) -> None:
        service = SyncJobService()
        # Should not raise when DB is unavailable.
        result = service.prune_old_jobs(max_rows=5, max_age_days=1)
        assert result == 0
