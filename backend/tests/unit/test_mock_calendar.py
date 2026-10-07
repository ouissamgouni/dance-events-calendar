"""Unit tests for parseLinks-equivalent logic and calendar services."""

from pathlib import Path

import pytest

from backend.services.calendar.base import CalendarEvent, CalendarInfo, SyncResult
from backend.services.calendar.mock_calendar import MockCalendarService

SCENARIO_DIR = str(Path(__file__).parents[3] / "scenarios" / "calendar-service-mock")


@pytest.mark.unit
class TestMockCalendarService:
    def test_list_calendars_returns_seed_data(self):
        svc = MockCalendarService(scenario_dir=SCENARIO_DIR)
        calendars = svc.list_calendars()
        assert len(calendars) == 2
        assert all(isinstance(c, CalendarInfo) for c in calendars)
        names = {c.name for c in calendars}
        assert "Movida" in names
        assert "Bachata Events" in names

    def test_get_events_for_salsa_calendar(self):
        svc = MockCalendarService(scenario_dir=SCENARIO_DIR)
        result = svc.get_events("salsa-cal-001")
        assert isinstance(result, SyncResult)
        assert len(result.events) == 23
        assert all(isinstance(e, CalendarEvent) for e in result.events)
        assert all(e.calendar_id == "salsa-cal-001" for e in result.events)

    def test_get_events_for_bachata_calendar(self):
        svc = MockCalendarService(scenario_dir=SCENARIO_DIR)
        result = svc.get_events("bachata-cal-002")
        assert len(result.events) == 16
        assert all(e.calendar_id == "bachata-cal-002" for e in result.events)

    def test_get_events_unknown_calendar_returns_empty(self):
        svc = MockCalendarService(scenario_dir=SCENARIO_DIR)
        result = svc.get_events("nonexistent-cal")
        assert result.events == []
        assert result.deleted_event_ids == []

    def test_events_have_required_fields(self):
        svc = MockCalendarService(scenario_dir=SCENARIO_DIR)
        result = svc.get_events("salsa-cal-001")
        event = result.events[0]
        assert event.event_id
        assert event.title
        assert event.start is not None
        assert event.end is not None

    def test_requires_scenario_dir(self):
        with pytest.raises(ValueError, match="requires a scenario_dir"):
            MockCalendarService()


def _source_dir(tmp_path: Path) -> MockCalendarService:
    (tmp_path / "mock-sync-events.yaml").write_text(
        """
events:
  - {id: ev-1, calendar_id: cal, title: One, start: "2030-01-04T20:00", end: "2030-01-04T23:00"}
  - {id: ev-2, calendar_id: cal, title: Two, start: "2030-01-05T20:00", end: "2030-01-05T23:00"}
"""
    )
    return MockCalendarService(scenario_dir=str(tmp_path))


@pytest.mark.unit
class TestMockCalendarSourceEdits:
    def test_incremental_sync_returns_only_edited_events(self, tmp_path):
        svc = _source_dir(tmp_path)
        token = svc.get_events("cal").next_sync_token
        assert svc.get_events("cal", sync_token=token).events == []

        svc.edit_source_event("ev-1", {"title": "One (moved)"})
        result = svc.get_events("cal", sync_token=token)

        assert [(e.event_id, e.title) for e in result.events] == [("ev-1", "One (moved)")]
        assert svc.get_events("cal", sync_token=result.next_sync_token).events == []
        # A fresh instance (e.g. after a restart) sees the same source state.
        fresh = MockCalendarService(scenario_dir=str(tmp_path))
        assert fresh.source_event("ev-1")["title"] == "One (moved)"

    def test_deletion_is_reported_and_reset_restores_the_yaml(self, tmp_path):
        svc = _source_dir(tmp_path)
        token = svc.get_events("cal").next_sync_token

        svc.delete_source_event("ev-2")
        result = svc.get_events("cal", sync_token=token)

        assert result.events == []
        assert result.deleted_event_ids == ["ev-2"]
        svc.reset_source()
        assert {e.event_id for e in svc.get_events("cal").events} == {"ev-1", "ev-2"}

    def test_editing_the_yaml_forces_a_full_fetch(self, tmp_path):
        svc = _source_dir(tmp_path)
        token = svc.get_events("cal").next_sync_token
        path = tmp_path / "mock-sync-events.yaml"
        path.write_text(path.read_text().replace("title: Two", "title: Deux"))

        assert len(svc.get_events("cal", sync_token=token).events) == 2

    def test_rejects_end_before_start(self, tmp_path):
        from datetime import datetime

        svc = _source_dir(tmp_path)
        with pytest.raises(ValueError, match="End must be after start"):
            svc.edit_source_event("ev-1", {"end": datetime(2030, 1, 4, 19, 0)})
