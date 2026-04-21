import json
import logging
import re
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Optional

import yaml
from sqlmodel import Session, select

from backend.db.models import (
    CachedEvent,
    CalendarSetting,
    EventTag,
    SiteSetting,
    Tag,
    TagGroup,
    TagSuggestion,
)

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


class DatabaseSeeder:
    def __init__(self, session: Session):
        self.session = session

    def seed(self, scenario_dir: Path):
        logger.info("Seeding from %s", scenario_dir)

        self._seed_tags(scenario_dir / "tags.yaml")
        self._seed_calendars(scenario_dir / "calendars.yaml")
        self._seed_events(scenario_dir / "events.yaml")
        self._seed_event_tags(scenario_dir / "events.yaml")
        self._seed_tag_suggestions(scenario_dir / "events.yaml")
        self._ingest_test_plans(scenario_dir)
        self.session.commit()
        logger.info("Seeding complete")

    def _seed_tags(self, path: Path):
        """Seed tag groups and tags from scenario tags.yaml.

        Expected structure:
        tag_groups:
          - slug: format
            label: Format
            ordinal: 0
            allow_multiple: true
            color: "#f472b6"
            tags:
              - slug: social
                label: Social
        """
        if not path.exists():
            logger.info("No tags.yaml found at %s", path)
            return

        with open(path) as f:
            data = yaml.safe_load(f) or {}

        groups_data = data.get("tag_groups", [])
        if not isinstance(groups_data, list):
            logger.warning(
                "Invalid tags.yaml format at %s: tag_groups must be a list", path
            )
            return

        for group_idx, group_data in enumerate(groups_data):
            slug = group_data.get("slug")
            label = group_data.get("label")
            if not slug or not label:
                logger.warning(
                    "Skipping tag group with missing slug/label: %s", group_data
                )
                continue

            group = self.session.exec(
                select(TagGroup).where(TagGroup.slug == slug)
            ).first()

            ordinal = group_data.get("ordinal", group_idx)
            allow_multiple = group_data.get("allow_multiple", True)
            color = group_data.get("color")
            enabled = group_data.get("enabled", True)

            if group:
                group.label = label
                group.ordinal = ordinal
                group.allow_multiple = allow_multiple
                group.color = color
                group.enabled = enabled
                self.session.add(group)
                logger.info("Updated tag group: %s", slug)
            else:
                group = TagGroup(
                    slug=slug,
                    label=label,
                    ordinal=ordinal,
                    allow_multiple=allow_multiple,
                    color=color,
                    enabled=enabled,
                )
                self.session.add(group)
                self.session.flush()
                logger.info("Created tag group: %s", slug)

            tags_data = group_data.get("tags", [])
            for tag_idx, tag_data in enumerate(tags_data):
                tag_slug = tag_data.get("slug")
                tag_label = tag_data.get("label")
                if not tag_slug or not tag_label:
                    logger.warning("Skipping tag with missing slug/label: %s", tag_data)
                    continue

                tag = self.session.exec(
                    select(Tag).where(Tag.group_id == group.id, Tag.slug == tag_slug)
                ).first()

                tag_ordinal = tag_data.get("ordinal", tag_idx)
                tag_color = tag_data.get("color")
                tag_enabled = tag_data.get("enabled", True)

                if tag:
                    tag.label = tag_label
                    tag.ordinal = tag_ordinal
                    tag.color = tag_color
                    tag.enabled = tag_enabled
                    self.session.add(tag)
                else:
                    self.session.add(
                        Tag(
                            group_id=group.id,
                            slug=tag_slug,
                            label=tag_label,
                            ordinal=tag_ordinal,
                            color=tag_color,
                            enabled=tag_enabled,
                        )
                    )

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
                existing.links = evt_data.get("links", existing.links)
                existing.price_min = evt_data.get("price_min", existing.price_min)
                existing.price_max = evt_data.get("price_max", existing.price_max)
                existing.price_currency = evt_data.get(
                    "price_currency", existing.price_currency
                )
                existing.price_is_free = evt_data.get(
                    "price_is_free", existing.price_is_free
                )
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
                        links=evt_data.get("links"),
                        price_min=evt_data.get("price_min"),
                        price_max=evt_data.get("price_max"),
                        price_currency=evt_data.get("price_currency"),
                        price_is_free=evt_data.get("price_is_free", False),
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

    def _build_tag_lookup(self) -> dict[str, int]:
        """Build a slug -> tag id lookup. Slugs are prefixed with group slug: 'format:social'."""
        tags = self.session.exec(select(Tag)).all()
        groups = self.session.exec(select(TagGroup)).all()
        group_map = {g.id: g.slug for g in groups}
        return {f"{group_map[t.group_id]}:{t.slug}": t.id for t in tags}

    def _seed_event_tags(self, path: Path):
        """Assign tags to events based on 'tags' list in events.yaml.

        Each tag is referenced as 'group_slug:tag_slug', e.g. 'format:social'.
        """
        if not path.exists():
            return

        with open(path) as f:
            data = yaml.safe_load(f)

        events_data = data.get("events", [])
        has_tags = any(e.get("tags") for e in events_data)
        if not has_tags:
            return

        tag_lookup = self._build_tag_lookup()
        if not tag_lookup:
            logger.warning("No tags in DB – skipping event tag seeding")
            return

        for evt_data in events_data:
            tag_slugs = evt_data.get("tags", [])
            if not tag_slugs:
                continue
            evt_id = evt_data["id"]
            for slug in tag_slugs:
                tag_id = tag_lookup.get(slug)
                if not tag_id:
                    logger.warning("Unknown tag slug '%s' for event %s", slug, evt_id)
                    continue
                existing = self.session.exec(
                    select(EventTag).where(
                        EventTag.event_id == evt_id, EventTag.tag_id == tag_id
                    )
                ).first()
                if not existing:
                    self.session.add(EventTag(event_id=evt_id, tag_id=tag_id))
                    logger.info("Tagged event %s with %s", evt_id, slug)

    def _seed_tag_suggestions(self, path: Path):
        """Create tag suggestions from 'tag_suggestions' list in events.yaml."""
        if not path.exists():
            return

        with open(path) as f:
            data = yaml.safe_load(f)

        suggestions = data.get("tag_suggestions", [])
        if not suggestions:
            return

        tag_lookup = self._build_tag_lookup()

        for sug in suggestions:
            event_id = sug["event_id"]
            tag_slug = sug.get("tag")
            free_text = sug.get("free_text")
            status = sug.get("status", "pending")
            device_id = sug.get("device_id", "seed-device")

            tag_id = tag_lookup.get(tag_slug) if tag_slug else None

            self.session.add(
                TagSuggestion(
                    event_id=event_id,
                    tag_id=tag_id,
                    free_text=free_text,
                    status=status,
                    submitter_device_id=device_id,
                )
            )
            logger.info(
                "Created tag suggestion for event %s (tag=%s, free_text=%s)",
                event_id,
                tag_slug,
                free_text,
            )
