import time

import pytest

from backend.services.sync_job_service import SyncJobService, SyncJobStatus


def _wait_until(predicate, timeout=2.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


@pytest.fixture(autouse=True)
def _stub_cross_instance_lock(monkeypatch):
    # These are pure in-process unit tests; the Postgres advisory lock and
    # SyncJobRun persistence are implementation details covered by
    # integration tests. Stubbing them prevents leaked locks (from tests that
    # don't wait for the worker to complete) and noisy "relation does not
    # exist" DB errors from affecting subsequent tests when CI's real DB is
    # reachable.
    monkeypatch.setattr(
        SyncJobService,
        "_try_acquire_cross_instance_lock",
        staticmethod(lambda: None),
    )
    monkeypatch.setattr(
        SyncJobService,
        "_release_cross_instance_lock",
        staticmethod(lambda conn: None),
    )
    monkeypatch.setattr(
        SyncJobService,
        "_persist_record",
        lambda self, record, *, force=False: None,
    )


@pytest.mark.unit
class TestSyncJobService:
    def test_start_and_complete_job(self):
        service = SyncJobService()

        def worker(job_id, svc):
            svc.heartbeat(job_id)
            svc.update_totals(job_id, events_upserted=12)
            return {"status": SyncJobStatus.COMPLETED}

        started = service.start_job(worker=worker)
        job_id = started["job_id"]

        assert _wait_until(
            lambda: service.get_job(job_id)["status"] == SyncJobStatus.COMPLETED
        )

        job = service.get_job(job_id)
        assert job["totals"]["events_upserted"] == 12
        assert job["finished_at"] is not None

    def test_rejects_second_running_job(self):
        service = SyncJobService()

        def slow_worker(job_id, svc):
            time.sleep(0.2)
            return {"status": SyncJobStatus.COMPLETED}

        service.start_job(worker=slow_worker)

        with pytest.raises(RuntimeError):
            service.start_job(worker=slow_worker)

    def test_abort_request_transitions_to_aborted(self):
        service = SyncJobService()

        def cooperative_worker(job_id, svc):
            for _ in range(100):
                if svc.should_abort(job_id):
                    return {"status": SyncJobStatus.ABORTED}
                svc.heartbeat(job_id)
                time.sleep(0.01)
            return {"status": SyncJobStatus.COMPLETED}

        started = service.start_job(worker=cooperative_worker)
        job_id = started["job_id"]

        aborted = service.abort_job(job_id)
        assert aborted["status"] == SyncJobStatus.ABORT_REQUESTED

        assert _wait_until(
            lambda: service.get_job(job_id)["status"] == SyncJobStatus.ABORTED
        )

    def test_worker_exception_marks_failed(self):
        service = SyncJobService()

        def failing_worker(job_id, svc):
            raise RuntimeError("boom")

        started = service.start_job(worker=failing_worker)
        job_id = started["job_id"]

        assert _wait_until(
            lambda: service.get_job(job_id)["status"] == SyncJobStatus.FAILED
        )

        job = service.get_job(job_id)
        assert "boom" in (job["error_message"] or "")

    def test_get_current_returns_idle_when_empty(self):
        service = SyncJobService()
        assert service.get_current_job() is None
