"""Tests for the sync scheduler module (job-service based)."""

import asyncio
from unittest.mock import MagicMock, patch

import pytest

from backend.services.scheduler import (
    _trigger_scheduled_sync,
    run_notification_dispatch_once,
    run_sync_loop,
)


@pytest.mark.unit
class TestScheduler:
    @pytest.mark.asyncio
    async def test_sync_loop_invokes_trigger(self):
        """Verify the sync loop calls `_trigger_scheduled_sync` at least once."""
        mock_service = MagicMock()
        with patch(
            "backend.services.scheduler._trigger_scheduled_sync",
            return_value=({"started": True, "job_id": "abc"}, 60),
        ) as mock_trigger:
            task = asyncio.create_task(run_sync_loop(mock_service))
            await asyncio.sleep(0.1)
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

            assert mock_trigger.call_count >= 1

    @pytest.mark.asyncio
    async def test_sync_runs_in_executor(self):
        mock_service = MagicMock()
        with patch(
            "backend.services.scheduler._trigger_scheduled_sync",
            return_value=({"started": True}, 60),
        ):
            loop = asyncio.get_running_loop()
            original_executor = loop.run_in_executor
            executor_called = False

            async def tracking_executor(executor, func, *args):
                nonlocal executor_called
                executor_called = True
                return await original_executor(executor, func, *args)

            with patch.object(loop, "run_in_executor", side_effect=tracking_executor):
                task = asyncio.create_task(run_sync_loop(mock_service))
                await asyncio.sleep(0.2)
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

            assert executor_called, "trigger should run via run_in_executor"

    def test_trigger_starts_job_when_enabled(self):
        with (
            patch("backend.services.scheduler._get_effective_interval", return_value=5),
            patch(
                "backend.services.scheduler._get_auto_sync_enabled_setting",
                return_value=True,
            ),
            patch(
                "backend.services.scheduler._get_since_date_setting",
                return_value=None,
            ),
            patch(
                "backend.services.scheduler._get_auto_sync_mode_setting",
                return_value="incremental",
            ),
            patch("backend.services.scheduler.get_engine"),
            patch("backend.services.scheduler.get_sync_job_service") as mock_get_svc,
            patch("backend.api.routes.admin._run_sync_job_worker"),
        ):
            mock_svc = MagicMock()
            mock_svc.start_job.return_value = {"job_id": "abc-123"}
            mock_get_svc.return_value = mock_svc

            stats, interval = _trigger_scheduled_sync(MagicMock())

            assert stats == {
                "job_id": "abc-123",
                "started": True,
                "since_date": None,
                "mode": "incremental",
            }
            assert interval == 5 * 60
            mock_svc.start_job.assert_called_once()

    def test_trigger_skips_when_auto_sync_disabled(self):
        with (
            patch("backend.services.scheduler._get_effective_interval", return_value=5),
            patch(
                "backend.services.scheduler._get_auto_sync_enabled_setting",
                return_value=False,
            ),
            patch("backend.services.scheduler.get_engine"),
            patch("backend.services.scheduler.get_sync_job_service") as mock_get_svc,
        ):
            stats, interval = _trigger_scheduled_sync(MagicMock())

            assert stats == {"auto_sync_enabled": False, "skipped": 1}
            assert interval == 5 * 60
            mock_get_svc.assert_not_called()

    def test_trigger_skips_when_job_already_running(self):
        with (
            patch("backend.services.scheduler._get_effective_interval", return_value=5),
            patch(
                "backend.services.scheduler._get_auto_sync_enabled_setting",
                return_value=True,
            ),
            patch("backend.services.scheduler.get_engine"),
            patch("backend.services.scheduler.get_sync_job_service") as mock_get_svc,
            patch("backend.api.routes.admin._run_sync_job_worker"),
        ):
            mock_svc = MagicMock()
            mock_svc.start_job.side_effect = RuntimeError(
                "A sync job is already running"
            )
            mock_get_svc.return_value = mock_svc

            stats, interval = _trigger_scheduled_sync(MagicMock())

            assert stats["skipped"] == 1
            assert stats["reason"] == "job_already_running"
            assert interval == 5 * 60

    def test_notification_dispatch_merges_subtask_stats(self):
        with (
            patch(
                "backend.services.reminder_service.run_once",
                return_value={"reminders": 2, "emailed": 1, "pushed": 1},
            ),
            patch(
                "backend.services.scheduler.sweep_fanout_jobs",
                return_value={"jobs": 1, "failed": 0},
            ),
            patch(
                "backend.services.review_prompt_service.run_once",
                return_value={"prompts": 1, "emailed": 1, "pushed": 0},
            ),
            patch(
                "backend.services.event_asset_prompts.run_ticket_prompts",
                return_value={"prompts": 2, "emailed": 2, "pushed": 0},
            ),
            patch(
                "backend.services.event_asset_prompts.run_memories_prompts",
                return_value={"prompts": 0},
            ),
            patch(
                "backend.services.milestone_notification_service.run_once",
                return_value={"milestones": 1, "emailed": 1, "pushed": 0},
            ),
            patch(
                "backend.services.interest_notification_service.run_once",
                return_value={"candidates": 4, "created": 1},
            ),
            patch(
                "backend.services.activity_email.run_once",
                return_value={"digests": 3, "pushed": 2},
            ),
            patch(
                "backend.services.recurrence_extension.run_once",
                return_value={"series_extended": 1, "occurrences_created": 4},
            ),
            patch(
                "backend.services.event_images.run_sweep_once",
                return_value={"removed": 2},
            ),
            patch(
                "backend.services.event_assets.run_sweep_once",
                return_value={"removed": 1},
            ),
            patch(
                "backend.services.data_retention.run_once",
                return_value={"event_views": 3},
            ),
        ):
            stats = run_notification_dispatch_once()

        assert stats == {
            "reminders": {"reminders": 2, "emailed": 1, "pushed": 1},
            "fanout": {"jobs": 1, "failed": 0},
            "review_prompt": {"prompts": 1, "emailed": 1, "pushed": 0},
            "ticket_prompt": {"prompts": 2, "emailed": 2, "pushed": 0},
            "memories_prompt": {"prompts": 0},
            "milestone": {"milestones": 1, "emailed": 1, "pushed": 0},
            "interest": {"candidates": 4, "created": 1},
            "activity": {"digests": 3, "pushed": 2},
            "recurrence": {"series_extended": 1, "occurrences_created": 4},
            "suggestion_images": {"removed": 2},
            "event_tickets": {"removed": 1},
            "data_retention": {"event_views": 3},
        }

    def test_notification_dispatch_is_resilient_when_subtask_raises(self):
        with (
            patch(
                "backend.services.reminder_service.run_once",
                side_effect=RuntimeError("reminders blew up"),
            ),
            patch(
                "backend.services.scheduler.sweep_fanout_jobs",
                return_value={"jobs": 0, "failed": 0},
            ),
            patch(
                "backend.services.review_prompt_service.run_once",
                return_value={"prompts": 0},
            ),
            patch(
                "backend.services.event_asset_prompts.run_ticket_prompts",
                return_value={"prompts": 0},
            ),
            patch(
                "backend.services.event_asset_prompts.run_memories_prompts",
                return_value={"prompts": 0},
            ),
            patch(
                "backend.services.milestone_notification_service.run_once",
                return_value={"milestones": 0, "emailed": 0, "pushed": 0},
            ),
            patch(
                "backend.services.interest_notification_service.run_once",
                return_value={"candidates": 0, "created": 0},
            ),
            patch(
                "backend.services.activity_email.run_once",
                return_value={"digests": 1},
            ),
            patch(
                "backend.services.recurrence_extension.run_once",
                return_value={"series_extended": 0, "occurrences_created": 0},
            ),
            patch(
                "backend.services.event_images.run_sweep_once",
                return_value={"removed": 0},
            ),
            patch(
                "backend.services.event_assets.run_sweep_once",
                return_value={"removed": 0},
            ),
            patch(
                "backend.services.data_retention.run_once",
                return_value={},
            ),
        ):
            stats = run_notification_dispatch_once()

        assert stats["reminders"] == {"error": True}
        assert stats["review_prompt"] == {"prompts": 0}
        assert stats["interest"] == {"candidates": 0, "created": 0}
        assert stats["activity"] == {"digests": 1}


_DISPATCH_TARGETS = {
    "reminders": "backend.services.reminder_service.run_once",
    "fanout": "backend.services.scheduler.sweep_fanout_jobs",
    "review_prompt": "backend.services.review_prompt_service.run_once",
    "ticket_prompt": "backend.services.event_asset_prompts.run_ticket_prompts",
    "memories_prompt": "backend.services.event_asset_prompts.run_memories_prompts",
    "milestone": "backend.services.milestone_notification_service.run_once",
    "interest": "backend.services.interest_notification_service.run_once",
    "activity": "backend.services.activity_email.run_once",
    "recurrence": "backend.services.recurrence_extension.run_once",
    "suggestion_images": "backend.services.event_images.run_sweep_once",
    "event_tickets": "backend.services.event_assets.run_sweep_once",
    "data_retention": "backend.services.data_retention.run_once",
}
_DAILY_JOBS = {
    "milestone",
    "recurrence",
    "suggestion_images",
    "event_tickets",
    "data_retention",
}


@pytest.fixture
def dispatch_mocks(monkeypatch):
    from backend.services import scheduler

    monkeypatch.setattr(scheduler, "_dispatch_last_run", {})
    mocks = {}
    for name, target in _DISPATCH_TARGETS.items():
        mocks[name] = MagicMock(return_value={"ran": name})
        monkeypatch.setattr(target, mocks[name])
    return mocks


@pytest.mark.unit
class TestDispatchCadence:
    def test_loop_runs_daily_jobs_once_per_day(self, dispatch_mocks, monkeypatch):
        from backend.services import scheduler

        clock = [1000.0]
        monkeypatch.setattr(scheduler.time, "monotonic", lambda: clock[0])

        first = run_notification_dispatch_once(respect_cadence=True, source="tick")
        assert first == {name: {"ran": name} for name in _DISPATCH_TARGETS}

        clock[0] += 3600
        second = run_notification_dispatch_once(respect_cadence=True, source="tick")
        for name in _DISPATCH_TARGETS:
            if name in _DAILY_JOBS:
                assert second[name] == {"skipped": "not_due"}
            else:
                assert second[name] == {"ran": name}
        assert dispatch_mocks["milestone"].call_count == 1
        assert dispatch_mocks["activity"].call_count == 2

        clock[0] += 24 * 3600
        third = run_notification_dispatch_once(respect_cadence=True, source="tick")
        assert all(third[name] == {"ran": name} for name in _DAILY_JOBS)

    def test_manual_trigger_ignores_cadence_and_records_admin_source(
        self, dispatch_mocks
    ):
        run_notification_dispatch_once(respect_cadence=True, source="tick")
        stats = run_notification_dispatch_once()

        assert stats == {name: {"ran": name} for name in _DISPATCH_TARGETS}
        assert dispatch_mocks["milestone"].call_count == 2
        dispatch_mocks["activity"].assert_called_with(force=False, source="admin")

    def test_failed_daily_job_waits_for_next_day(self, dispatch_mocks):
        dispatch_mocks["recurrence"].side_effect = RuntimeError("boom")

        first = run_notification_dispatch_once(respect_cadence=True, source="tick")
        second = run_notification_dispatch_once(respect_cadence=True, source="tick")

        assert first["recurrence"] == {"error": True}
        assert second["recurrence"] == {"skipped": "not_due"}

    @pytest.mark.asyncio
    async def test_dispatch_loop_respects_cadence_and_tick_setting(
        self, monkeypatch, caplog
    ):
        import logging

        from backend.services import scheduler

        calls: list = []
        monkeypatch.setenv("SCHEDULER_TICK_MINUTES", "60")
        monkeypatch.setattr(
            scheduler,
            "run_notification_dispatch_once",
            lambda **kw: calls.append(kw) or {"ok": True},
        )
        sleeps: list = []

        async def fake_sleep(seconds):
            sleeps.append(seconds)
            raise asyncio.CancelledError

        monkeypatch.setattr(scheduler.asyncio, "sleep", fake_sleep)
        with caplog.at_level(logging.INFO, logger="backend.services.scheduler"):
            with pytest.raises(asyncio.CancelledError):
                await scheduler.run_notification_dispatch_loop()

        assert calls == [{"respect_cadence": True, "source": "tick"}]
        assert sleeps == [3600]
        messages = [r.getMessage() for r in caplog.records]
        assert any("tick=60 min" in m and "delivery debounce" in m for m in messages)
        assert any("next in 60 min" in m for m in messages)
