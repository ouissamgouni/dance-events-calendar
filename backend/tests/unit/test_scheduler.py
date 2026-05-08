"""Tests for the sync scheduler module (job-service based)."""

import asyncio
from unittest.mock import MagicMock, patch

import pytest

from backend.services.scheduler import _trigger_scheduled_sync, run_sync_loop


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
