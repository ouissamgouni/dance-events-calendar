"""Tests for CalendarSyncWorker — fetch, 410 fallback, delete reconciliation."""

import threading
from datetime import datetime
from unittest.mock import MagicMock, call, patch

import pytest

from backend.services.calendar.base import CalendarEvent, SyncResult
from backend.services.calendar_sync_worker import CalendarSyncWorker
from backend.services.event_pipeline_processor import CalendarProgress


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_cal(calendar_id: str = "cal1", sync_token: str | None = None):
    cal = MagicMock()
    cal.calendar_id = calendar_id
    cal.sync_token = sync_token
    return cal


def _make_event(event_id: str = "ev1", title: str = "Test") -> CalendarEvent:
    return CalendarEvent(
        event_id=event_id,
        calendar_id="cal1",
        title=title,
        description=None,
        location=None,
        start=datetime(2026, 6, 1, 20, 0),
        end=datetime(2026, 6, 1, 22, 0),
    )


def _make_worker(
    cal=None,
    calendar_name: str = "Test Cal",
    events: list | None = None,
    deleted_ids: list | None = None,
    next_sync_token: str | None = "new-token",
    time_min=None,
    abort_event: threading.Event | None = None,
    engine=None,
) -> CalendarSyncWorker:
    if cal is None:
        cal = _make_cal()
    if abort_event is None:
        abort_event = threading.Event()
    if engine is None:
        engine = MagicMock()

    sync_result = SyncResult(
        events=events or [],
        deleted_event_ids=deleted_ids or [],
        next_sync_token=next_sync_token,
    )

    calendar_service = MagicMock()
    calendar_service.get_events.return_value = sync_result

    processor = MagicMock()
    progress = CalendarProgress(
        calendar_id=cal.calendar_id, calendar_name=calendar_name
    )

    return (
        CalendarSyncWorker(
            cal=cal,
            calendar_name=calendar_name,
            calendar_service=calendar_service,
            processor=processor,
            progress=progress,
            time_min=time_min,
            abort_event=abort_event,
            engine=engine,
        ),
        calendar_service,
        processor,
        progress,
    )


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestCalendarSyncWorker:
    def test_submits_all_events_to_processor(self):
        """Worker submits every fetched event to the pipeline processor."""
        events = [_make_event("ev1"), _make_event("ev2"), _make_event("ev3")]
        worker, svc, proc, progress = _make_worker(events=events)

        with patch.object(worker, "_load_default_tag_ids", return_value=[]):
            with patch.object(worker, "_reconcile_deletes", return_value=0):
                with patch.object(worker, "_save_sync_token"):
                    worker.run()

        assert proc.submit.call_count == 3
        assert progress.fetched == 3
        assert progress.status == "completed"

    def test_410_fallback_clears_token_and_resyncs(self):
        """When sync token is present but result has no next_sync_token, worker retries without token."""
        cal = _make_cal(sync_token="old-token")
        abort_event = threading.Event()
        engine = MagicMock()

        # First call (with old token): returns empty with next_sync_token=None → 410 signal
        first_result = SyncResult(events=[], deleted_event_ids=[], next_sync_token=None)
        # Second call (without token): returns real events
        second_result = SyncResult(
            events=[_make_event("ev1")],
            deleted_event_ids=[],
            next_sync_token="new-token",
        )
        calendar_service = MagicMock()
        calendar_service.get_events.side_effect = [first_result, second_result]

        processor = MagicMock()
        progress = CalendarProgress(calendar_id="cal1", calendar_name="Cal")

        worker = CalendarSyncWorker(
            cal=cal,
            calendar_name="Cal",
            calendar_service=calendar_service,
            processor=processor,
            progress=progress,
            time_min=None,
            abort_event=abort_event,
            engine=engine,
        )

        # Mock the DB session used to clear the sync token
        mock_cal_obj = MagicMock()
        mock_session = MagicMock()
        mock_session.__enter__ = MagicMock(return_value=mock_session)
        mock_session.__exit__ = MagicMock(return_value=False)
        mock_session.get.return_value = mock_cal_obj

        with patch(
            "backend.services.calendar_sync_worker.Session", return_value=mock_session
        ):
            with patch.object(worker, "_load_default_tag_ids", return_value=[]):
                with patch.object(worker, "_reconcile_deletes", return_value=0):
                    with patch.object(worker, "_save_sync_token"):
                        worker.run()

        # Should have called get_events twice (initial + retry)
        assert calendar_service.get_events.call_count == 2
        # Event from second result should be submitted
        assert processor.submit.call_count == 1

    def test_deleted_events_are_reconciled(self):
        """Worker calls _reconcile_deletes with the deleted event IDs from the API."""
        worker, svc, proc, progress = _make_worker(
            events=[],
            deleted_ids=["del1", "del2"],
        )

        with patch.object(worker, "_load_default_tag_ids", return_value=[]):
            with patch.object(worker, "_reconcile_deletes", return_value=2) as mock_del:
                with patch.object(worker, "_save_sync_token"):
                    worker.run()

        mock_del.assert_called_once_with(["del1", "del2"])

    def test_sync_token_saved_after_fetch(self):
        """Worker saves the next_sync_token to DB after all events are submitted."""
        worker, svc, proc, progress = _make_worker(next_sync_token="fresh-token")

        with patch.object(worker, "_load_default_tag_ids", return_value=[]):
            with patch.object(worker, "_reconcile_deletes", return_value=0):
                with patch.object(worker, "_save_sync_token") as mock_save:
                    worker.run()

        mock_save.assert_called_once_with("fresh-token")

    def test_abort_stops_event_submission(self):
        """When abort_event is set, the worker stops submitting events mid-loop."""
        abort_event = threading.Event()
        events = [_make_event(f"ev{i}") for i in range(10)]
        worker, svc, proc, progress = _make_worker(
            events=events,
            abort_event=abort_event,
        )

        # Set abort after 3rd submit
        original_submit = proc.submit.side_effect

        call_count = 0

        def counting_submit(task):
            nonlocal call_count
            call_count += 1
            if call_count >= 3:
                abort_event.set()

        proc.submit.side_effect = counting_submit

        with patch.object(worker, "_load_default_tag_ids", return_value=[]):
            with patch.object(worker, "_reconcile_deletes", return_value=0):
                with patch.object(worker, "_save_sync_token"):
                    worker.run()

        # Worker should have stopped submitting after abort was set
        assert proc.submit.call_count < 10
        assert progress.status == "warning"

    def test_failed_fetch_sets_status_failed(self):
        """When calendar_service.get_events raises, worker marks progress as failed."""
        cal = _make_cal()
        abort_event = threading.Event()
        engine = MagicMock()

        calendar_service = MagicMock()
        calendar_service.get_events.side_effect = RuntimeError("API error")

        processor = MagicMock()
        progress = CalendarProgress(calendar_id="cal1", calendar_name="Cal")

        worker = CalendarSyncWorker(
            cal=cal,
            calendar_name="Cal",
            calendar_service=calendar_service,
            processor=processor,
            progress=progress,
            time_min=None,
            abort_event=abort_event,
            engine=engine,
        )

        with patch.object(worker, "_load_default_tag_ids", return_value=[]):
            worker.run()

        assert progress.status == "failed"
        assert "API error" in (progress.error or "")
        error_logs = [l for l in progress.logs if l.level == "ERROR"]
        assert len(error_logs) >= 1
