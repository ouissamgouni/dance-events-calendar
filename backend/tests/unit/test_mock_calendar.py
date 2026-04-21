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
