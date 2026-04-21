import os
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Optional

import yaml

from backend.db.seed import resolve_relative_dt
from backend.services.calendar.base import (
    BaseCalendarService,
    CalendarEvent,
    CalendarInfo,
    SyncResult,
)


class MockCalendarService(BaseCalendarService):
    """Reads calendars and events from YAML seed files. Deterministic, no Google creds needed."""

    def __init__(self, scenario_dir: Optional[str] = None):
        if scenario_dir is None:
            scenario_dir = os.getenv("SCENARIO_DIR")
        if scenario_dir is None:
            raise ValueError(
                "MockCalendarService requires a scenario_dir argument or "
                "SCENARIO_DIR environment variable"
            )
        self.scenario_dir = Path(scenario_dir)

    def list_calendars(self) -> list[CalendarInfo]:
        calendars_file = self.scenario_dir / "calendars.yaml"
        if not calendars_file.exists():
            return []

        with open(calendars_file) as f:
            data = yaml.safe_load(f)

        return [
            CalendarInfo(calendar_id=c["id"], name=c["name"])
            for c in data.get("calendars", [])
        ]

    def get_calendar_info(self, calendar_id: str):
        """Look up a calendar by ID from the YAML seed data."""
        for cal in self.list_calendars():
            if cal.calendar_id == calendar_id:
                return cal
        return None

    def get_events(
        self,
        calendar_id: str,
        sync_token: Optional[str] = None,
        time_min: Optional[datetime] = None,
    ) -> SyncResult:
        events_file = self.scenario_dir / "events.yaml"
        if not events_file.exists():
            return SyncResult(events=[], deleted_event_ids=[], next_sync_token=None)

        with open(events_file) as f:
            data = yaml.safe_load(f)

        base_week = data.get("base_week", 0)
        today = date.today()
        reference_monday = today - timedelta(days=today.weekday())

        events = []
        for e in data.get("events", []):
            if e.get("calendar_id") != calendar_id:
                continue

            start = e["start"]
            end = e["end"]
            if isinstance(start, str):
                resolved = resolve_relative_dt(start, reference_monday, base_week)
                start = resolved if resolved else datetime.fromisoformat(start)
            if isinstance(end, str):
                resolved = resolve_relative_dt(end, reference_monday, base_week)
                end = resolved if resolved else datetime.fromisoformat(end)

            events.append(
                CalendarEvent(
                    event_id=e["id"],
                    calendar_id=calendar_id,
                    title=e["title"],
                    description=e.get("description"),
                    location=e.get("location"),
                    start=start,
                    end=end,
                    all_day=e.get("all_day", False),
                )
            )

        return SyncResult(
            events=events,
            deleted_event_ids=[],
            next_sync_token="mock-sync-token",
        )

    def create_event(
        self,
        calendar_id: str,
        title: str,
        description: Optional[str],
        location: Optional[str],
        start: datetime,
        end: datetime,
        all_day: bool = False,
    ) -> str:
        import uuid

        return f"mock-created-{uuid.uuid4().hex[:8]}"
