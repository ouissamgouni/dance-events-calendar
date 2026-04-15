import json
import logging
import re
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Optional

import yaml
from sqlmodel import Session, select

from backend.db.models import CachedEvent, CalendarSetting, SiteSetting

WEEKDAYS = {"Mon": 0, "Tue": 1, "Wed": 2, "Thu": 3, "Fri": 4, "Sat": 5, "Sun": 6}
RELATIVE_RE = re.compile(
    r"^w(-?\d+)\s+(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d{2}):(\d{2})$"
)


def resolve_relative_dt(
    value: str, reference_monday: date, base_week: int = 0
) -> Optional[datetime]:
    """Parse 'wN Day HH:MM' into an absolute datetime.

    Returns None if *value* is not in relative format.
    """
    m = RELATIVE_RE.match(value)
    if not m:
        return None
    week_offset = int(m.group(1))
    weekday = WEEKDAYS[m.group(2)]
    hour = int(m.group(3))
    minute = int(m.group(4))
    target_date = reference_monday + timedelta(
        weeks=base_week + week_offset, days=weekday
    )
    return datetime(target_date.year, target_date.month, target_date.day, hour, minute)


logger = logging.getLogger(__name__)

# Top-level scenarios/ directory (project root)
SCENARIOS_DIR = Path(__file__).parents[2] / "scenarios"
DEFAULT_SCENARIO = SCENARIOS_DIR / "calendar-service-mock"


class DatabaseSeeder:
    def __init__(self, session: Session):
        self.session = session

    def seed(self, scenario_dir: Optional[Path] = None):
        scenario_dir = scenario_dir or DEFAULT_SCENARIO
        logger.info("Seeding from %s", scenario_dir)

        self._seed_calendars(scenario_dir / "calendars.yaml")
        self._seed_events(scenario_dir / "events.yaml")
        self._ingest_test_plans(scenario_dir)
        self.session.commit()
        logger.info("Seeding complete")

    def _seed_calendars(self, path: Path):
        if not path.exists():
            logger.warning("No calendars.yaml found at %s", path)
            return

        with open(path) as f:
            data = yaml.safe_load(f)

        for cal_data in data.get("calendars", []):
            cal_id = cal_data["id"]
            existing = self.session.get(CalendarSetting, cal_id)
            if existing:
                existing.name = cal_data["name"]
                existing.color = cal_data.get("color", existing.color)
                self.session.add(existing)
                logger.info("Updated calendar: %s", cal_data["name"])
            else:
                self.session.add(
                    CalendarSetting(
                        calendar_id=cal_id,
                        name=cal_data["name"],
                        enabled=cal_data.get("enabled", True),
                        color=cal_data.get("color"),
                    )
                )
                logger.info("Created calendar: %s", cal_data["name"])

    def _seed_events(self, path: Path):
        if not path.exists():
            logger.warning("No events.yaml found at %s", path)
            return

        with open(path) as f:
            data = yaml.safe_load(f)

        base_week = data.get("base_week", 0)
        today = date.today()
        reference_monday = today - timedelta(days=today.weekday())
        if base_week != 0:
            logger.info(
                "base_week=%d, reference Monday=%s", base_week, reference_monday
            )

        for evt_data in data.get("events", []):
            evt_id = evt_data["id"]
            start = evt_data["start"]
            end = evt_data["end"]
            if isinstance(start, str):
                resolved = resolve_relative_dt(start, reference_monday, base_week)
                start = resolved if resolved else datetime.fromisoformat(start)
            if isinstance(end, str):
                resolved = resolve_relative_dt(end, reference_monday, base_week)
                end = resolved if resolved else datetime.fromisoformat(end)

            existing = self.session.get(CachedEvent, evt_id)
            if existing:
                existing.title = evt_data["title"]
                existing.description = evt_data.get("description")
                existing.location = evt_data.get("location")
                existing.latitude = evt_data.get("latitude", existing.latitude)
                existing.longitude = evt_data.get("longitude", existing.longitude)
                existing.start = start
                existing.end = end
                existing.all_day = evt_data.get("all_day", False)
                existing.updated_at = datetime.utcnow()
                existing.deleted_at = None
                existing.review_status = "reviewed"
                self.session.add(existing)
                logger.info("Updated event: %s", evt_data["title"])
            else:
                self.session.add(
                    CachedEvent(
                        event_id=evt_id,
                        calendar_id=evt_data["calendar_id"],
                        title=evt_data["title"],
                        description=evt_data.get("description"),
                        location=evt_data.get("location"),
                        latitude=evt_data.get("latitude"),
                        longitude=evt_data.get("longitude"),
                        start=start,
                        end=end,
                        all_day=evt_data.get("all_day", False),
                        review_status="reviewed",
                    )
                )
                logger.info("Created event: %s", evt_data["title"])

    def _ingest_test_plans(self, scenario_dir: Path) -> None:
        """Read test_plan.yaml from the scenario directory and persist to SiteSetting."""
        plans: list[dict[str, Any]] = []

        test_plan_path = scenario_dir / "test_plan.yaml"
        if test_plan_path.exists():
            with open(test_plan_path) as f:
                raw = yaml.safe_load(f) or {}
            content = raw.get("test_plan", raw)
            if content:
                content["scenario"] = scenario_dir.name
                plans.append(content)

        # Upsert into SiteSetting
        row = self.session.get(SiteSetting, "qa_test_plans")
        value = json.dumps(plans) if plans else ""
        if row:
            row.value = value
            self.session.add(row)
        else:
            self.session.add(SiteSetting(key="qa_test_plans", value=value))

        if plans:
            names = [p.get("scenario", "?") for p in plans]
            logger.info("Ingested %d QA test plan(s): %s", len(plans), names)
