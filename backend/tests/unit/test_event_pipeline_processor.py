"""Tests for EventPipelineProcessor — queue, workers, dedup, abort, progress."""

import threading
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from backend.services.calendar.base import CalendarEvent
from backend.services.event_pipeline_processor import (
    CalendarProgress,
    EventPipelineProcessor,
    EventTask,
    LogEntry,
    ProcessedEventSummary,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_event(
    event_id: str = "ev1",
    title: str = "Test Event",
    location: str | None = None,
    description: str | None = None,
) -> CalendarEvent:
    return CalendarEvent(
        event_id=event_id,
        calendar_id="cal1",
        title=title,
        description=description,
        location=location,
        start=datetime(2026, 6, 1, 20, 0),
        end=datetime(2026, 6, 1, 22, 0),
    )


def _make_task(
    event: CalendarEvent | None = None,
    abort_event: threading.Event | None = None,
) -> EventTask:
    return EventTask(
        calendar_event=event or _make_event(),
        calendar_id="cal1",
        default_tag_ids=[],
        abort_event=abort_event or threading.Event(),
    )


def _make_progress(calendar_id: str = "cal1") -> CalendarProgress:
    return CalendarProgress(calendar_id=calendar_id, calendar_name="Test Calendar")


def _make_processor(
    progress_map: dict | None = None,
    abort_event: threading.Event | None = None,
    num_workers: int = 1,
    pipeline=None,
) -> EventPipelineProcessor:
    if progress_map is None:
        progress_map = {"cal1": _make_progress()}
    if abort_event is None:
        abort_event = threading.Event()
    if pipeline is None:
        pipeline = MagicMock()
        pipeline.process_event.return_value = {}
        pipeline.enrich.return_value = {}
        pipeline.stages = []
    return EventPipelineProcessor(
        pipeline=pipeline,
        progress_map=progress_map,
        abort_event=abort_event,
        num_workers=num_workers,
        max_queue_size=50,
    )


# ---------------------------------------------------------------------------
# Unit tests: CalendarProgress
# ---------------------------------------------------------------------------


class TestCalendarProgress:
    def test_counters_thread_safe(self):
        p = _make_progress()
        threads = [threading.Thread(target=p.inc_fetched) for _ in range(50)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert p.fetched == 50

    def test_add_log_caps_at_500(self):
        p = _make_progress()
        for i in range(600):
            p.add_log("INFO", f"msg {i}")
        assert len(p.logs) == 500
        assert p.logs[-1].message == "msg 599"  # most recent kept

    def test_add_processed_event_caps_at_500(self):
        p = _make_progress()
        for i in range(600):
            p.add_processed_event(
                ProcessedEventSummary(
                    event_id=f"e{i}",
                    title=f"t{i}",
                    start_dt="",
                    location=None,
                    action="new",
                )
            )
        assert len(p.processed_events) == 500

    def test_to_dict_structure(self):
        p = _make_progress()
        p.inc_fetched()
        p.inc_upserted()
        p.add_log("INFO", "hello")
        d = p.to_dict()
        assert d["calendar_id"] == "cal1"
        assert d["fetched"] == 1
        assert d["upserted"] == 1
        assert len(d["logs"]) == 1
        assert d["logs"][0]["level"] == "INFO"
        assert d["logs"][0]["message"] == "hello"

    def test_inc_enriched_failed_increments_error_count(self):
        p = _make_progress()
        p.inc_enriched_failed()
        assert p.enriched_failed == 1
        assert p.error_count == 1


# ---------------------------------------------------------------------------
# Integration tests: EventPipelineProcessor
# ---------------------------------------------------------------------------


class TestEventPipelineProcessor:
    def test_submit_and_drain_new_event(self):
        """A new event (no existing DB row) is upserted and enrichment skipped when no location/description."""
        progress = _make_progress()
        processor = _make_processor(progress_map={"cal1": progress})

        # Patch _upsert_and_dedup to return (mock_event, "new")
        mock_db_event = MagicMock()
        mock_db_event.event_id = "ev1"
        mock_db_event.title = "Test"
        mock_db_event.location = None

        with patch.object(
            processor, "_persist_with_dedup", return_value=(mock_db_event, "new")
        ):
            with patch(
                "backend.services.event_pipeline_processor.get_engine"
            ) as mock_engine:
                mock_session = MagicMock()
                mock_session.__enter__ = MagicMock(return_value=mock_session)
                mock_session.__exit__ = MagicMock(return_value=False)
                mock_engine.return_value = MagicMock()

                processor.start()
                processor.submit(_make_task())
                processor.stop()

        assert progress.upserted == 1
        assert progress.enriched_failed == 0

    def test_dedup_increments_deduped_counter(self):
        """When _upsert_and_dedup returns action='deduped', no enrichment is run."""
        progress = _make_progress()
        pipeline = MagicMock()
        pipeline.stages = []
        pipeline.enrich.return_value = {}
        processor = _make_processor(progress_map={"cal1": progress}, pipeline=pipeline)

        mock_canonical = MagicMock()
        mock_canonical.event_id = "canonical-1"
        mock_canonical.title = "Duplicate Event"
        mock_canonical.location = "Paris"

        with patch.object(
            processor, "_persist_with_dedup", return_value=(mock_canonical, "deduped")
        ):
            with patch("backend.services.event_pipeline_processor.get_engine"):
                processor.start()
                processor.submit(_make_task())
                processor.stop()

        assert progress.deduped == 1
        assert progress.upserted == 0
        pipeline.process_event.assert_not_called()

    def test_abort_event_drops_submissions(self):
        """After abort_event is set, submit() drops new tasks."""
        abort = threading.Event()
        processor = _make_processor(abort_event=abort)

        abort.set()
        processor.start()
        processor.submit(_make_task())  # should be dropped silently
        processor.stop()

        progress = processor._progress_map["cal1"]
        # No work done since task was dropped
        assert progress.upserted == 0
        assert progress.deduped == 0

    def test_multiple_tasks_processed_sequentially(self):
        """N tasks all result in N upserted events (with 1 worker)."""
        progress = _make_progress()
        processor = _make_processor(progress_map={"cal1": progress}, num_workers=1)

        events = [_make_event(event_id=f"ev{i}", title=f"Event {i}") for i in range(5)]
        tasks = [_make_task(event=e) for e in events]

        mock_db_event = MagicMock()
        mock_db_event.location = None

        call_count = 0

        def fake_upsert(session, task, buffer):
            nonlocal call_count
            call_count += 1
            mock_db_event.event_id = task.calendar_event.event_id
            mock_db_event.title = task.calendar_event.title
            return mock_db_event, "new"

        with patch.object(processor, "_persist_with_dedup", side_effect=fake_upsert):
            with patch("backend.services.event_pipeline_processor.get_engine"):
                processor.start()
                for task in tasks:
                    processor.submit(task)
                processor.stop()

        assert call_count == 5
        assert progress.upserted == 5

    def test_upsert_exception_increments_enriched_failed(self):
        """When upsert raises, the event is recorded as failed."""
        progress = _make_progress()
        processor = _make_processor(progress_map={"cal1": progress})

        def boom(session, task, buffer):
            raise RuntimeError("DB connection lost")

        with patch.object(processor, "_persist_with_dedup", side_effect=boom):
            with patch("backend.services.event_pipeline_processor.get_engine"):
                processor.start()
                processor.submit(_make_task())
                processor.stop()

        assert progress.enriched_failed == 1
        assert progress.error_count == 1
        # Should have an ERROR log
        error_logs = [l for l in progress.logs if l.level == "ERROR"]
        assert len(error_logs) == 1
        assert "DB connection lost" in error_logs[0].message
