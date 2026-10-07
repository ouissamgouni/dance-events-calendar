import hashlib
import json
import os
from datetime import date, datetime, timedelta, timezone
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


OVERRIDES_FILENAME = ".mock-source-overrides.json"
EDITABLE_FIELDS = ("title", "description", "location", "start", "end", "all_day")


def _naive_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)


class MockCalendarService(BaseCalendarService):
    """Reads calendars and events from YAML seed files. Deterministic, no Google creds needed.

    QA can emulate an organiser editing or deleting an event in Google
    through ``edit_source_event`` / ``delete_source_event``. Those land in an
    untracked overlay file next to the YAML (``.mock-source-overrides.json``),
    so the scenario files stay untouched and edits survive restarts.

    Sync tokens behave like Google's: a full fetch (no or unknown token)
    returns every live event; a fetch with the latest token returns only the
    events edited or deleted since that token was issued. Editing the YAML
    itself changes its fingerprint, which invalidates old tokens and forces a
    full fetch.
    """

    def __init__(self, scenario_dir: Optional[str] = None):
        if scenario_dir is None:
            scenario_dir = os.getenv("SCENARIO_DIR")
        if scenario_dir is None:
            raise ValueError(
                "MockCalendarService requires a scenario_dir argument or "
                "SCENARIO_DIR environment variable"
            )
        self.scenario_dir = Path(scenario_dir)

    @property
    def _events_file(self) -> Path:
        return self.scenario_dir / "mock-sync-events.yaml"

    @property
    def _overrides_file(self) -> Path:
        return self.scenario_dir / OVERRIDES_FILENAME

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

    # --- Source state -------------------------------------------------------

    def _fingerprint(self) -> str:
        if not self._events_file.exists():
            return "none"
        return hashlib.sha256(self._events_file.read_bytes()).hexdigest()[:12]

    def _base_events(self) -> dict[str, dict]:
        if not self._events_file.exists():
            return {}
        with open(self._events_file) as f:
            data = yaml.safe_load(f) or {}

        base_week = data.get("base_week", 0)
        today = date.today()
        reference_monday = today - timedelta(days=today.weekday())

        events: dict[str, dict] = {}
        for e in data.get("events", []):
            start = e["start"]
            end = e["end"]
            if isinstance(start, str):
                resolved = resolve_relative_dt(start, reference_monday, base_week)
                start = resolved if resolved else datetime.fromisoformat(start)
            if isinstance(end, str):
                resolved = resolve_relative_dt(end, reference_monday, base_week)
                end = resolved if resolved else datetime.fromisoformat(end)
            events[e["id"]] = {
                "event_id": e["id"],
                "calendar_id": e.get("calendar_id"),
                "title": e["title"],
                "description": e.get("description"),
                "location": e.get("location"),
                "start": start,
                "end": end,
                "all_day": e.get("all_day", False),
            }
        return events

    def _load_overrides(self) -> dict:
        if not self._overrides_file.exists():
            return {"version": 0, "events": {}}
        return json.loads(self._overrides_file.read_text())

    def _save_overrides(self, data: dict) -> None:
        self._overrides_file.write_text(json.dumps(data, indent=2, sort_keys=True))

    def _current(self, event: dict, override: dict | None) -> dict:
        if not override:
            return event
        merged = dict(event)
        for field, value in (override.get("changes") or {}).items():
            if field in ("start", "end") and isinstance(value, str):
                value = datetime.fromisoformat(value)
            merged[field] = value
        return merged

    def _token(self, calendar_id: str, version: int) -> str:
        return f"mock:{calendar_id}:{self._fingerprint()}:{version}"

    def _since_version(self, calendar_id: str, sync_token: Optional[str]) -> int | None:
        """The overlay version a valid token was issued at, else None."""
        if not sync_token:
            return None
        parts = sync_token.split(":")
        if len(parts) != 4 or parts[0] != "mock" or parts[1] != calendar_id:
            return None
        if parts[2] != self._fingerprint() or not parts[3].isdigit():
            return None
        return int(parts[3])

    def get_events(
        self,
        calendar_id: str,
        sync_token: Optional[str] = None,
        time_min: Optional[datetime] = None,
    ) -> SyncResult:
        if not self._events_file.exists():
            return SyncResult(events=[], deleted_event_ids=[], next_sync_token=None)

        overrides = self._load_overrides()
        since = self._since_version(calendar_id, sync_token)
        events: list[CalendarEvent] = []
        deleted: list[str] = []
        for event_id, base in self._base_events().items():
            if base["calendar_id"] != calendar_id:
                continue
            override = overrides["events"].get(event_id)
            if since is not None and (override is None or override["version"] <= since):
                continue
            if override and override.get("deleted"):
                deleted.append(event_id)
                continue
            current = self._current(base, override)
            events.append(
                CalendarEvent(
                    event_id=event_id,
                    calendar_id=calendar_id,
                    title=current["title"],
                    description=current["description"],
                    location=current["location"],
                    start=current["start"],
                    end=current["end"],
                    all_day=current["all_day"],
                )
            )

        return SyncResult(
            events=events,
            deleted_event_ids=deleted,
            next_sync_token=self._token(calendar_id, overrides["version"]),
        )

    # --- QA: emulate edits made at the source -------------------------------

    def source_event(self, event_id: str) -> dict | None:
        """The event as the source currently has it, or None if unknown."""
        base = self._base_events().get(event_id)
        if base is None:
            return None
        override = self._load_overrides()["events"].get(event_id)
        current = self._current(base, override)
        return {
            **current,
            "edited": bool(override and override.get("changes")),
            "deleted": bool(override and override.get("deleted")),
        }

    def edit_source_event(self, event_id: str, changes: dict) -> dict:
        base = self._base_events().get(event_id)
        if base is None:
            raise KeyError(event_id)
        unknown = set(changes) - set(EDITABLE_FIELDS)
        if unknown:
            raise ValueError(f"Not editable at the source: {sorted(unknown)}")

        overrides = self._load_overrides()
        entry = overrides["events"].get(event_id) or {"changes": {}}
        merged_changes = dict(entry.get("changes") or {})
        for field, value in changes.items():
            if isinstance(value, datetime):
                value = _naive_utc(value).isoformat()
            merged_changes[field] = value
        current = self._current(base, {"changes": merged_changes})
        if current["end"] <= current["start"]:
            raise ValueError("End must be after start")

        overrides["version"] += 1
        overrides["events"][event_id] = {
            "changes": merged_changes,
            "deleted": False,
            "version": overrides["version"],
        }
        self._save_overrides(overrides)
        return self.source_event(event_id)

    def delete_source_event(self, event_id: str) -> None:
        if event_id not in self._base_events():
            raise KeyError(event_id)
        overrides = self._load_overrides()
        overrides["version"] += 1
        entry = overrides["events"].get(event_id) or {"changes": {}}
        entry.update(deleted=True, version=overrides["version"])
        overrides["events"][event_id] = entry
        self._save_overrides(overrides)

    def reset_source(self) -> None:
        """Forget every emulated source edit (the YAML is the source again)."""
        self._overrides_file.unlink(missing_ok=True)

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
