"""Unit tests for SyncService sync logging."""

import pytest
from datetime import datetime
from unittest.mock import MagicMock, patch, PropertyMock

from backend.services.calendar.base import CalendarEvent, SyncResult
from backend.services.sync_service import SyncService


def _make_mock_calendar_service(events=None, deleted_ids=None):
    svc = MagicMock()
    svc.get_events.return_value = SyncResult(
        events=events or [],
        deleted_event_ids=deleted_ids or [],
        next_sync_token="tok-1",
    )
    return svc


def _make_calendar_setting(cal_id="cal-1", enabled=True, sync_token=None):
    from backend.db.models import CalendarSetting

    return CalendarSetting(
        calendar_id=cal_id,
        name="Test Calendar",
        enabled=enabled,
        sync_token=sync_token,
    )


def _make_event(event_id="evt-1", calendar_id="cal-1"):
    return CalendarEvent(
        event_id=event_id,
        calendar_id=calendar_id,
        title="Test Event",
        description=None,
        location="Paris",
        start=datetime(2026, 5, 1, 20, 0),
        end=datetime(2026, 5, 1, 23, 0),
        all_day=False,
    )


@pytest.mark.unit
class TestSyncService:
    def test_sync_all_creates_success_log(self):
        cal_svc = _make_mock_calendar_service(events=[_make_event()])
        sync_svc = SyncService(cal_svc)
        # Stub out the pipeline so it doesn't try to query a real DB
        sync_svc.pipeline = MagicMock()
        sync_svc.pipeline.run.return_value = MagicMock(to_dict=lambda: {})

        session = MagicMock()
        cal = _make_calendar_setting()

        # session.exec returns enabled calendars
        mock_result = MagicMock()
        mock_result.all.return_value = [cal]
        session.exec.return_value = mock_result
        session.get.return_value = None  # no existing event

        stats = sync_svc.sync_all(session, trigger="manual")

        assert stats["calendars_synced"] == 1
        assert stats["events_upserted"] == 1
        assert stats["events_deleted"] == 0

        # SyncLog was added to session
        add_calls = session.add.call_args_list
        from backend.db.models import SyncLog

        sync_logs_added = [c for c in add_calls if isinstance(c[0][0], SyncLog)]
        assert len(sync_logs_added) >= 1

        # The final SyncLog should have status=success
        final_log = sync_logs_added[-1][0][0]
        assert final_log.status == "success"
        assert final_log.trigger == "manual"
        assert final_log.calendars_synced == 1

    def test_sync_all_creates_log_with_auto_trigger_by_default(self):
        cal_svc = _make_mock_calendar_service()
        sync_svc = SyncService(cal_svc)

        session = MagicMock()
        mock_result = MagicMock()
        mock_result.all.return_value = []
        session.exec.return_value = mock_result

        sync_svc.sync_all(session)

        from backend.db.models import SyncLog

        add_calls = session.add.call_args_list
        sync_logs = [c for c in add_calls if isinstance(c[0][0], SyncLog)]
        assert sync_logs[0][0][0].trigger == "auto"

    def test_sync_calendar_collects_needs_enrichment(self):
        """New events with location/description should be in needs_enrichment."""
        event = _make_event()
        cal_svc = _make_mock_calendar_service(events=[event])
        sync_svc = SyncService(cal_svc)

        session = MagicMock()
        session.get.return_value = None  # new event

        cal = _make_calendar_setting()
        result = sync_svc.sync_calendar(session, cal)

        assert result["upserted"] == 1
        assert "evt-1" in result["needs_enrichment"]

    def test_sync_calendar_handles_deletions(self):
        cal_svc = _make_mock_calendar_service(deleted_ids=["evt-del-1"])
        sync_svc = SyncService(cal_svc)

        existing = MagicMock()
        existing.deleted_at = None
        session = MagicMock()
        session.get.return_value = existing

        cal = _make_calendar_setting()
        result = sync_svc.sync_calendar(session, cal)

        assert result["deleted"] == 1
        assert existing.deleted_at is not None

    def test_sync_sets_pending_when_fields_change(self):
        """Existing event with changed title should get review_status='pending'."""
        event = CalendarEvent(
            event_id="evt-1",
            calendar_id="cal-1",
            title="Updated Title",
            description=None,
            location="Paris",
            start=datetime(2026, 5, 1, 20, 0),
            end=datetime(2026, 5, 1, 23, 0),
            all_day=False,
        )
        cal_svc = _make_mock_calendar_service(events=[event])
        sync_svc = SyncService(cal_svc)

        existing = MagicMock()
        existing.title = "Old Title"
        existing.description = None
        existing.location = "Paris"
        existing.start = datetime(2026, 5, 1, 20, 0)
        existing.end = datetime(2026, 5, 1, 23, 0)
        existing.all_day = False
        existing.latitude = 48.86
        existing.price_min = None
        existing.links = None

        session = MagicMock()
        session.get.return_value = existing

        cal = _make_calendar_setting()
        sync_svc.sync_calendar(session, cal)

        assert existing.review_status == "pending"

    def test_sync_keeps_status_when_fields_unchanged(self):
        """Existing event with no changes should NOT get review_status reset."""
        event = CalendarEvent(
            event_id="evt-1",
            calendar_id="cal-1",
            title="Same Title",
            description=None,
            location="Paris",
            start=datetime(2026, 5, 1, 20, 0),
            end=datetime(2026, 5, 1, 23, 0),
            all_day=False,
        )
        cal_svc = _make_mock_calendar_service(events=[event])
        sync_svc = SyncService(cal_svc)

        existing = MagicMock()
        existing.title = "Same Title"
        existing.description = None
        existing.location = "Paris"
        existing.start = datetime(2026, 5, 1, 20, 0)
        existing.end = datetime(2026, 5, 1, 23, 0)
        existing.all_day = False
        existing.latitude = 48.86
        existing.price_min = None
        existing.links = None
        existing.review_status = "reviewed"

        session = MagicMock()
        session.get.return_value = existing

        cal = _make_calendar_setting()
        sync_svc.sync_calendar(session, cal)

        # review_status should not have been overwritten
        assert existing.review_status == "reviewed"

    def test_new_event_gets_pending_by_default(self):
        """New events should get review_status='pending' from model default."""
        event = _make_event()
        cal_svc = _make_mock_calendar_service(events=[event])
        sync_svc = SyncService(cal_svc)

        session = MagicMock()
        session.get.return_value = None  # new event

        cal = _make_calendar_setting()
        sync_svc.sync_calendar(session, cal)

        from backend.db.models import CachedEvent

        added = [
            c[0][0]
            for c in session.add.call_args_list
            if isinstance(c[0][0], CachedEvent)
        ]
        assert len(added) == 1
        assert added[0].review_status == "pending"

    def test_new_event_no_location_no_description_skips_enrichment(self):
        """New event without location or description should NOT be enriched."""
        event = CalendarEvent(
            event_id="evt-bare",
            calendar_id="cal-1",
            title="Bare Event",
            description=None,
            location=None,
            start=datetime(2026, 5, 1, 20, 0),
            end=datetime(2026, 5, 1, 23, 0),
            all_day=False,
        )
        cal_svc = _make_mock_calendar_service(events=[event])
        sync_svc = SyncService(cal_svc)

        session = MagicMock()
        session.get.return_value = None

        cal = _make_calendar_setting()
        result = sync_svc.sync_calendar(session, cal)

        assert "evt-bare" not in result["needs_enrichment"]

    def test_existing_event_already_enriched_skips(self):
        """Existing event with lat + price + links filled should NOT be re-enriched."""
        event = _make_event()
        cal_svc = _make_mock_calendar_service(events=[event])
        sync_svc = SyncService(cal_svc)

        existing = MagicMock()
        existing.title = "Test Event"
        existing.description = None
        existing.location = "Paris"
        existing.start = datetime(2026, 5, 1, 20, 0)
        existing.end = datetime(2026, 5, 1, 23, 0)
        existing.all_day = False
        existing.latitude = 48.86
        existing.price_min = 10.0
        existing.links = [{"url": "https://example.com"}]

        session = MagicMock()
        session.get.return_value = existing

        cal = _make_calendar_setting()
        result = sync_svc.sync_calendar(session, cal)

        assert "evt-1" not in result["needs_enrichment"]

    def test_pipeline_stage_order_is_link_price_geocoding(self):
        """Pipeline stages should run in order: link → price → geocoding."""
        cal_svc = _make_mock_calendar_service()
        sync_svc = SyncService(cal_svc)

        stage_names = [s.name for s in sync_svc.pipeline.stages]
        assert stage_names == ["link_extraction", "price_extraction", "geocoding"]
