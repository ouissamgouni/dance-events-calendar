"""Tests for the sync scheduler module."""

import pytest
from unittest.mock import MagicMock, patch
import asyncio

from backend.services.scheduler import run_sync_loop, _run_sync


@pytest.mark.unit
class TestScheduler:
    @pytest.mark.asyncio
    async def test_sync_loop_calls_sync_all(self):
        """Verify the sync loop runs scheduled iterations."""
        mock_service = MagicMock()

        with (
            patch("backend.services.scheduler.SyncService"),
            patch(
                "backend.services.scheduler._run_sync",
                return_value=(
                    {"calendars_synced": 1, "events_upserted": 5, "events_deleted": 0},
                    60,
                ),
            ) as mock_run_sync,
        ):
            task = asyncio.create_task(run_sync_loop(mock_service))
            await asyncio.sleep(0.1)
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

            assert mock_run_sync.call_count >= 1

    @pytest.mark.asyncio
    async def test_sync_runs_in_executor_not_blocking_event_loop(self):
        """Verify sync loop work runs via run_in_executor so event loop stays free."""
        mock_service = MagicMock()

        with (
            patch("backend.services.scheduler.SyncService"),
            patch(
                "backend.services.scheduler._run_sync",
                return_value=(
                    {"calendars_synced": 0, "events_upserted": 0, "events_deleted": 0},
                    60,
                ),
            ),
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

            assert executor_called, "sync should run via run_in_executor"

    def test_run_sync_returns_stats_and_interval(self):
        """Verify _run_sync helper returns (stats, interval)."""
        with (
            patch("backend.services.scheduler._get_effective_interval", return_value=5),
            patch(
                "backend.services.scheduler._get_auto_sync_enabled_setting",
                return_value=True,
            ),
            patch("backend.services.scheduler.get_engine"),
        ):
            mock_sync = MagicMock()
            mock_sync.sync_all.return_value = {
                "calendars_synced": 2,
                "events_upserted": 10,
                "events_deleted": 1,
            }

            stats, interval = _run_sync(mock_sync)

            assert stats["calendars_synced"] == 2
            assert interval == 5 * 60
            mock_sync.sync_all.assert_called_once()

    def test_run_sync_skips_when_auto_sync_disabled(self):
        """Verify _run_sync skips sync when auto-sync setting is disabled."""
        with (
            patch("backend.services.scheduler._get_effective_interval", return_value=5),
            patch(
                "backend.services.scheduler._get_auto_sync_enabled_setting",
                return_value=False,
            ),
            patch("backend.services.scheduler.get_engine"),
        ):
            mock_sync = MagicMock()

            stats, interval = _run_sync(mock_sync)

            assert stats == {"auto_sync_enabled": False, "skipped": 1}
            assert interval == 5 * 60
            mock_sync.sync_all.assert_not_called()
