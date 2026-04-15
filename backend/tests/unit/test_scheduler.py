"""Tests for the sync scheduler module."""

import pytest
from unittest.mock import MagicMock, patch, AsyncMock
import asyncio

from backend.services.scheduler import run_sync_loop


@pytest.mark.unit
class TestScheduler:
    @pytest.mark.asyncio
    async def test_sync_loop_calls_sync_all(self):
        """Verify the sync loop calls sync_all and then sleeps."""
        mock_service = MagicMock()
        call_count = 0

        with (
            patch(
                "backend.services.scheduler.get_sync_interval_minutes", return_value=1
            ),
            patch("backend.services.scheduler.get_engine") as mock_engine,
            patch("backend.services.scheduler.SyncService") as mock_sync_cls,
        ):
            mock_sync = MagicMock()
            mock_sync.sync_all.return_value = {
                "calendars_synced": 1,
                "events_upserted": 5,
                "events_deleted": 0,
            }
            mock_sync_cls.return_value = mock_sync

            async def limited_loop(svc):
                nonlocal call_count
                original = (
                    run_sync_loop.__wrapped__
                    if hasattr(run_sync_loop, "__wrapped__")
                    else run_sync_loop
                )
                # Run one iteration then cancel
                task = asyncio.create_task(original(svc))
                await asyncio.sleep(0.1)
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
                call_count = mock_sync.sync_all.call_count

            await limited_loop(mock_service)
            assert call_count >= 1
