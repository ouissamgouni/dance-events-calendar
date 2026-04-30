"""Unit tests for SyncService sync logging."""

import pytest
from datetime import datetime
from unittest.mock import MagicMock, patch, PropertyMock

from backend.services.calendar.base import CalendarEvent, SyncResult
from backend.services.sync_service import SyncService, compute_content_hash


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


def _make_event(
    event_id="evt-1", calendar_id="cal-1", title="Test Event", location="Paris"
):
    return CalendarEvent(
        event_id=event_id,
        calendar_id=calendar_id,
        title=title,
        description=None,
        location=location,
        start=datetime(2026, 5, 1, 20, 0),
        end=datetime(2026, 5, 1, 23, 0),
        all_day=False,
    )


def _make_exec_result(all_result=None, first_result=None):
    """Return a mock for session.exec(...) that handles both .all() and .first()."""
    result = MagicMock()
    result.all.return_value = all_result if all_result is not None else []
    result.first.return_value = first_result
    return result


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

        exec_calls = iter(
            [
                _make_exec_result(
                    all_result=[cal]
                ),  # enabled calendars query (sync_all)
                _make_exec_result(all_result=[]),  # CalendarDefaultTag (sync_calendar)
                _make_exec_result(
                    first_result=None
                ),  # content hash lookup (sync_calendar)
                _make_exec_result(first_result=None),  # EventCalendarSource check
            ]
        )
        session.exec.side_effect = lambda *a, **kw: next(exec_calls)
        session.get.return_value = None  # no Google-ID match

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
        session.get.return_value = None  # no Google-ID match
        session.exec.return_value = _make_exec_result(
            first_result=None
        )  # no hash match

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
        session.get.return_value = None  # no Google-ID match
        session.exec.return_value = _make_exec_result(
            first_result=None
        )  # no hash match

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
        session.get.return_value = None  # no Google-ID match
        session.exec.return_value = _make_exec_result(
            first_result=None
        )  # no hash match

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


@pytest.mark.unit
class TestComputeContentHash:
    def test_hash_is_deterministic(self):
        start = datetime(2026, 5, 1, 20, 0)
        h1 = compute_content_hash("Salsa Night", start, "Paris")
        h2 = compute_content_hash("Salsa Night", start, "Paris")
        assert h1 == h2

    def test_hash_normalizes_title_case_and_whitespace(self):
        start = datetime(2026, 5, 1, 20, 0)
        h1 = compute_content_hash("Salsa Night", start, "Paris")
        h2 = compute_content_hash("  SALSA NIGHT  ", start, "Paris")
        assert h1 == h2

    def test_hash_normalizes_location_case_and_whitespace(self):
        start = datetime(2026, 5, 1, 20, 0)
        h1 = compute_content_hash("Salsa Night", start, "Paris")
        h2 = compute_content_hash("Salsa Night", start, "  PARIS  ")
        assert h1 == h2

    def test_hash_differs_for_different_title(self):
        start = datetime(2026, 5, 1, 20, 0)
        h1 = compute_content_hash("Salsa Night", start, "Paris")
        h2 = compute_content_hash("Bachata Night", start, "Paris")
        assert h1 != h2

    def test_hash_differs_for_different_start(self):
        h1 = compute_content_hash("Salsa Night", datetime(2026, 5, 1, 20, 0), "Paris")
        h2 = compute_content_hash("Salsa Night", datetime(2026, 5, 2, 20, 0), "Paris")
        assert h1 != h2

    def test_hash_differs_for_different_location(self):
        start = datetime(2026, 5, 1, 20, 0)
        h1 = compute_content_hash("Salsa Night", start, "Paris")
        h2 = compute_content_hash("Salsa Night", start, "Berlin")
        assert h1 != h2

    def test_hash_treats_none_location_as_empty(self):
        start = datetime(2026, 5, 1, 20, 0)
        h1 = compute_content_hash("Salsa Night", start, None)
        h2 = compute_content_hash("Salsa Night", start, "")
        assert h1 == h2


@pytest.mark.unit
class TestSyncServiceDedup:
    """Tests for cross-calendar duplicate detection and merging."""

    def _make_canonical_event(self, event_id="evt-canonical"):
        """Return a MagicMock representing an existing CachedEvent in the DB."""
        from backend.db.models import CachedEvent

        canonical = MagicMock(spec=CachedEvent)
        canonical.event_id = event_id
        canonical.deleted_at = None
        return canonical

    def test_duplicate_detected_by_content_hash(self):
        """When a new Google event matches an existing canonical by hash, it is not inserted."""
        event = _make_event(event_id="evt-new-google-id")
        cal_svc = _make_mock_calendar_service(events=[event])
        sync_svc = SyncService(cal_svc)

        canonical = self._make_canonical_event("evt-canonical")
        session = MagicMock()
        session.get.return_value = None  # no Google-ID match
        session.exec.return_value = _make_exec_result(
            first_result=canonical
        )  # hash match

        cal = _make_calendar_setting()
        result = sync_svc.sync_calendar(session, cal)

        # Duplicate is merged, NOT counted as upserted
        assert result["upserted"] == 0
        assert len(result["dedup_entries"]) == 1

    def test_duplicate_dedup_entry_has_correct_fields(self):
        """dedup_entries should record title, incoming_id, canonical_id, calendar_id."""
        event = _make_event(event_id="evt-incoming", title="Salsa Night")
        cal_svc = _make_mock_calendar_service(events=[event])
        sync_svc = SyncService(cal_svc)

        canonical = self._make_canonical_event("evt-canonical")
        session = MagicMock()
        session.get.return_value = None
        session.exec.return_value = _make_exec_result(first_result=canonical)

        cal = _make_calendar_setting(cal_id="cal-second")
        result = sync_svc.sync_calendar(session, cal)

        entry = result["dedup_entries"][0]
        assert entry["title"] == "Salsa Night"
        assert entry["incoming_id"] == "evt-incoming"
        assert entry["canonical_id"] == "evt-canonical"
        assert entry["calendar_id"] == "cal-second"

    def test_duplicate_applies_default_tags_to_canonical(self):
        """On dedup, CalendarDefaultTags from the incoming calendar are applied to canonical."""
        from backend.db.models import Tag, CalendarDefaultTag, EventTag

        event = _make_event(event_id="evt-incoming")
        cal_svc = _make_mock_calendar_service(events=[event])
        sync_svc = SyncService(cal_svc)

        canonical = self._make_canonical_event("evt-canonical")

        # Session returns one default tag for the calendar
        default_tag_row = MagicMock()
        default_tag_row.tag_id = 42

        session = MagicMock()
        session.get.return_value = None  # no Google-ID match

        # First exec call → CalendarDefaultTag.all() returns [default_tag_row]
        # Second exec call → CachedEvent.first() returns canonical
        # Third exec call → EventCalendarSource.first() returns None (not yet recorded)
        # Fourth exec call → EventTag.first() returns None (tag not yet applied)
        exec_calls = [
            _make_exec_result(all_result=[default_tag_row]),  # default tags
            _make_exec_result(first_result=canonical),  # hash lookup
            _make_exec_result(first_result=None),  # EventCalendarSource check
            _make_exec_result(first_result=None),  # EventTag check
        ]
        session.exec.side_effect = exec_calls

        cal = _make_calendar_setting(cal_id="cal-second")
        sync_svc.sync_calendar(session, cal)

        added_event_tags = [
            c[0][0] for c in session.add.call_args_list if isinstance(c[0][0], EventTag)
        ]
        assert any(
            et.event_id == "evt-canonical" and et.tag_id == 42
            for et in added_event_tags
        )

    def test_no_duplicate_when_hash_not_found(self):
        """When no canonical event matches the hash, a new CachedEvent is created."""
        from backend.db.models import CachedEvent

        event = _make_event(event_id="evt-brand-new")
        cal_svc = _make_mock_calendar_service(events=[event])
        sync_svc = SyncService(cal_svc)

        session = MagicMock()
        session.get.return_value = None  # no Google-ID match
        session.exec.return_value = _make_exec_result(
            first_result=None
        )  # no hash match

        cal = _make_calendar_setting()
        result = sync_svc.sync_calendar(session, cal)

        assert result["upserted"] == 1
        assert result["dedup_entries"] == []

        added_events = [
            c[0][0]
            for c in session.add.call_args_list
            if isinstance(c[0][0], CachedEvent)
        ]
        assert any(e.event_id == "evt-brand-new" for e in added_events)

    def test_sync_all_persists_dedup_log_on_sync_log(self):
        """sync_all() should write accumulated dedup_entries to SyncLog.dedup_log."""
        from backend.db.models import SyncLog

        canonical = self._make_canonical_event("evt-canonical")
        event = _make_event(event_id="evt-incoming")
        cal_svc = _make_mock_calendar_service(events=[event])
        sync_svc = SyncService(cal_svc)
        sync_svc.pipeline = MagicMock()
        sync_svc.pipeline.run.return_value = MagicMock(to_dict=lambda: {})

        cal = _make_calendar_setting()

        session = MagicMock()
        # sync_all: session.exec for enabled calendars list
        enabled_result = MagicMock()
        enabled_result.all.return_value = [cal]

        exec_calls = iter(
            [
                enabled_result,  # enabled calendars query
                _make_exec_result(all_result=[]),  # CalendarDefaultTag
                _make_exec_result(first_result=canonical),  # content hash lookup
                _make_exec_result(first_result=None),  # EventCalendarSource check
            ]
        )
        session.exec.side_effect = lambda *a, **kw: next(exec_calls)
        session.get.return_value = None  # no Google-ID match

        sync_svc.sync_all(session, trigger="manual")

        added_sync_logs = [
            c[0][0] for c in session.add.call_args_list if isinstance(c[0][0], SyncLog)
        ]
        final_log = added_sync_logs[-1]
        assert final_log.dedup_log is not None
        assert len(final_log.dedup_log) == 1
        assert final_log.dedup_log[0]["incoming_id"] == "evt-incoming"
        assert final_log.dedup_log[0]["canonical_id"] == "evt-canonical"

    def test_no_duplicate_for_known_google_id(self):
        """An event with a known Google ID is always updated in-place, not deduped."""
        from backend.db.models import CachedEvent

        event = _make_event(event_id="evt-known")
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
        existing.links = []

        session = MagicMock()
        session.get.return_value = existing  # Google-ID match → normal upsert
        session.exec.return_value = _make_exec_result(first_result=None)

        cal = _make_calendar_setting()
        result = sync_svc.sync_calendar(session, cal)

        assert result["upserted"] == 1
        assert result["dedup_entries"] == []
