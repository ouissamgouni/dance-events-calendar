import json
import logging
import re
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Optional
from uuid import uuid4

import yaml
from sqlmodel import Session, select

from backend.db.models import (
    CachedEvent,
    CalendarDefaultTag,
    CalendarSetting,
    EventExport,
    EventLinkClick,
    EventRating,
    EventTag,
    EventView,
    SiteSetting,
    Tag,
    TagGroup,
    TagSuggestion,
    User,
    UserEventAttendance,
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

        # Check if this scenario uses a mock calendar service.
        # If so, skip pre-seeding mock-sync-events.yaml — those events must
        # enter the DB via the sync pipeline so dedup/enrichment fire on
        # first encounter. Scenarios that need events to exist regardless
        # of sync should use db-events.yaml (always pre-seeded below).
        from backend.config.loader import get_calendar_service_type

        uses_mock_calendar = get_calendar_service_type() == "mock"

        self._seed_tags(scenario_dir / "tags.yaml")
        self._seed_calendars(scenario_dir / "calendars.yaml")
        self._seed_calendar_default_tags(scenario_dir / "calendars.yaml")
        if uses_mock_calendar:
            logger.info(
                "Skipping mock-sync-events pre-seed (calendar_service=mock) — events enter DB via sync"
            )
        else:
            self._seed_events(scenario_dir / "mock-sync-events.yaml")
            self._seed_event_tags(scenario_dir / "mock-sync-events.yaml")
            self._seed_tag_suggestions(scenario_dir / "mock-sync-events.yaml")
        # db-events.yaml is always seeded directly into the DB (bypasses sync).
        # Only create this file in scenarios that need events available before sync fires.
        self._seed_events(scenario_dir / "db-events.yaml")
        self._seed_event_tags(scenario_dir / "db-events.yaml")
        self._seed_tag_suggestions(scenario_dir / "db-events.yaml")
        self._seed_tracking(scenario_dir / "db-tracking.yaml")
        self._seed_users(scenario_dir / "mock-users.yaml")
        # Attendances must come AFTER users (FK on user_id) and after events.
        self._seed_attendances(scenario_dir / "db-events.yaml")
        self._seed_ratings(scenario_dir / "db-events.yaml")
        self._seed_site_settings(scenario_dir / "settings.yaml")
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
            scope = group_data.get("scope", "event")
            if scope not in ("event", "review"):
                logger.warning(
                    "Tag group %s has invalid scope %r; defaulting to 'event'",
                    slug,
                    scope,
                )
                scope = "event"

            if group:
                group.label = label
                group.ordinal = ordinal
                group.allow_multiple = allow_multiple
                group.color = color
                group.enabled = enabled
                group.scope = scope
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
                    scope=scope,
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
                tag_is_hero = tag_data.get("is_hero_filter", False)
                tag_hero_ordinal = tag_data.get("hero_ordinal", None)

                if tag:
                    tag.label = tag_label
                    tag.ordinal = tag_ordinal
                    tag.color = tag_color
                    tag.enabled = tag_enabled
                    tag.is_hero_filter = tag_is_hero
                    tag.hero_ordinal = tag_hero_ordinal
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
                            is_hero_filter=tag_is_hero,
                            hero_ordinal=tag_hero_ordinal,
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

    def _seed_calendar_default_tags(self, path: Path):
        """Seed CalendarDefaultTag rows from 'default_tags' lists in calendars.yaml.

        Each tag is referenced as 'group_slug:tag_slug', e.g. 'dance-style:salsa'.
        Existing rows for a calendar are replaced when the calendar has a 'default_tags' key.
        Calendars without a 'default_tags' key are left untouched.
        """
        if not path.exists():
            return

        with open(path) as f:
            data = yaml.safe_load(f) or {}

        calendars_data = data.get("calendars", [])
        has_defaults = any("default_tags" in c for c in calendars_data)
        if not has_defaults:
            return

        tag_lookup = self._build_tag_lookup()
        if not tag_lookup:
            logger.warning("No tags in DB – skipping calendar default tag seeding")
            return

        # Flush so CalendarSetting rows are visible
        self.session.flush()

        for cal_data in calendars_data:
            cal_id = cal_data["id"]
            tag_slugs = cal_data.get("default_tags")
            if tag_slugs is None:
                continue

            # Delete existing default tags for this calendar
            existing = self.session.exec(
                select(CalendarDefaultTag).where(
                    CalendarDefaultTag.calendar_id == cal_id
                )
            ).all()
            for row in existing:
                self.session.delete(row)

            for slug in tag_slugs:
                tag_id = tag_lookup.get(slug)
                if not tag_id:
                    logger.warning(
                        "Unknown tag slug '%s' for calendar %s default tags",
                        slug,
                        cal_id,
                    )
                    continue
                self.session.add(CalendarDefaultTag(calendar_id=cal_id, tag_id=tag_id))
                logger.info("Set default tag '%s' for calendar %s", slug, cal_id)

    def _seed_events(self, path: Path):
        if not path.exists():
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

    def _seed_site_settings(self, path: Path) -> None:
        """Pre-seed SiteSetting key/value rows from scenario settings.yaml.

        Booleans are stored as 'true'/'false' strings to match the convention
        used by api/routes/settings.py. Other values are stored verbatim
        (already-string) or JSON-encoded.

        Expected structure:
          settings:
            show_ratings: true
            some_other_flag: false
        """
        if not path.exists():
            return

        with open(path) as f:
            data = yaml.safe_load(f) or {}

        items = data.get("settings", {}) or {}
        if not isinstance(items, dict):
            logger.warning(
                "Invalid settings.yaml at %s: 'settings' must be a mapping", path
            )
            return

        for key, value in items.items():
            if isinstance(value, bool):
                stored = "true" if value else "false"
            elif isinstance(value, (int, float, str)):
                stored = str(value)
            else:
                stored = json.dumps(value)
            row = self.session.get(SiteSetting, key)
            if row:
                row.value = stored
                self.session.add(row)
            else:
                self.session.add(SiteSetting(key=key, value=stored))
            logger.info("Seeded site setting %s=%s", key, stored)

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
        """Assign tags to events based on 'tags' list in mock-sync-events.yaml or db-events.yaml.

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
        """Create tag suggestions from 'tag_suggestions' list in mock-sync-events.yaml or db-events.yaml."""
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

    def _seed_users(self, path: Path) -> None:
        """Pre-create mock User rows from scenarios/<name>/mock-users.yaml.

        Lets a scenario expose named "Sign in as <Name>" buttons on /login
        and lets multi-user features (sharing, dedup, GDPR) be exercised
        before any user has actually logged in. Idempotent.

        Expected structure:
          users:
            - email: alice@example.com
              name: Alice
            - email: admin@example.com
              name: Admin
        """
        if not path.exists():
            return

        with open(path) as f:
            data = yaml.safe_load(f) or {}

        for entry in data.get("users", []) or []:
            if not isinstance(entry, dict):
                continue
            email = (entry.get("email") or "").strip().lower()
            if not email:
                continue
            provider_subject = f"mock|{email}"
            existing = self.session.exec(
                select(User).where(User.provider_subject == provider_subject)
            ).first()
            if existing:
                continue
            self.session.add(
                User(
                    email=email,
                    display_name=entry.get("name") or email.split("@", 1)[0],
                    provider="google",
                    provider_subject=provider_subject,
                )
            )
            logger.info("Created mock user: %s", email)

    def _seed_tracking(self, path: Path) -> None:
        """Seed EventView, EventLinkClick, and EventExport rows from db-tracking.yaml.

        Expected structure:
          views:
            - event_id: evt-001
              device_id: seed-device-fr
              source: explorer-list
              country: France
              city: Paris
          link_clicks:
            - event_id: evt-001
              device_id: seed-device-fr
              url: https://example.com/tickets
              country: France
          exports:
            - device_id: seed-device-fr
              format: ics
              event_count: 5
        """
        if not path.exists():
            return

        with open(path) as f:
            data = yaml.safe_load(f) or {}

        for row in data.get("views", []):
            self.session.add(
                EventView(
                    event_id=row["event_id"],
                    device_id=row.get("device_id"),
                    source=row.get("source"),
                    country=row.get("country"),
                    city=row.get("city"),
                )
            )
        views_count = len(data.get("views", []))
        if views_count:
            logger.info("Seeded %d EventView rows", views_count)

        for row in data.get("link_clicks", []):
            self.session.add(
                EventLinkClick(
                    event_id=row["event_id"],
                    device_id=row.get("device_id"),
                    url=row["url"],
                    country=row.get("country"),
                    city=row.get("city"),
                )
            )
        clicks_count = len(data.get("link_clicks", []))
        if clicks_count:
            logger.info("Seeded %d EventLinkClick rows", clicks_count)

        for row in data.get("exports", []):
            self.session.add(
                EventExport(
                    device_id=row.get("device_id"),
                    format=row["format"],
                    event_count=row.get("event_count", 0),
                )
            )
        exports_count = len(data.get("exports", []))
        if exports_count:
            logger.info("Seeded %d EventExport rows", exports_count)

    def _seed_attendances(self, path: Path) -> None:
        """Pre-seed UserEventAttendance rows from db-events.yaml.

        Lets scenarios test "Who's going" UI states (e.g. large attendee
        lists, mixed public/private breakdowns) without driving the UI.
        Idempotent: existing (event_id, user_id, device_id) rows are skipped.

        Expected structure (under db-events.yaml):
          attendances:
            - event_id: evt-share-003
              email: alice@example.com   # required if no device_id
              share_publicly: true       # default false
            - event_id: evt-share-003
              device_id: seed-anon-1     # anonymous device-only attendance
        """
        if not path.exists():
            return

        with open(path) as f:
            data = yaml.safe_load(f) or {}

        rows = data.get("attendances") or []
        if not rows:
            return

        seeded = 0
        for entry in rows:
            if not isinstance(entry, dict):
                continue
            event_id = entry.get("event_id")
            if not event_id:
                continue
            email = (entry.get("email") or "").strip().lower() or None
            device_id = entry.get("device_id")
            share_publicly = bool(entry.get("share_publicly", False))

            user_id = None
            if email:
                user = self.session.exec(
                    select(User).where(User.email == email)
                ).first()
                if not user:
                    logger.warning(
                        "Skipping attendance: user %s not found (seed users first)",
                        email,
                    )
                    continue
                user_id = user.id

            if user_id is None and not device_id:
                logger.warning(
                    "Skipping attendance for %s: needs email or device_id",
                    event_id,
                )
                continue

            # Idempotency check.
            existing_q = select(UserEventAttendance).where(
                UserEventAttendance.event_id == event_id
            )
            if user_id is not None:
                existing_q = existing_q.where(UserEventAttendance.user_id == user_id)
            else:
                existing_q = existing_q.where(
                    UserEventAttendance.device_id == device_id,
                    UserEventAttendance.user_id.is_(None),
                )
            if self.session.exec(existing_q).first():
                continue

            self.session.add(
                UserEventAttendance(
                    event_id=event_id,
                    user_id=user_id,
                    device_id=device_id or f"seed-attend-{event_id}-{email or 'anon'}",
                    share_publicly=share_publicly,
                )
            )
            seeded += 1
        if seeded:
            logger.info("Seeded %d UserEventAttendance rows", seeded)

    def _seed_ratings(self, path: Path) -> None:
        """Pre-seed EventRating rows from db-events.yaml `ratings:` list.

        Each entry can specify:
          - event_id (required)
          - email (optional, looked up to a user_id)
          - stars (1..5, required)
          - comment (optional)
          - review_tag_slugs (list of "review-tags:slug")
          - status: pending | approved | rejected (default approved)
          - is_anonymous: bool
          - admin_notes: str (optional)
        Idempotent: skips if a row already exists for the same (event_id, user_id|email|comment-hash).
        """
        if not path.exists():
            return
        with open(path) as f:
            data = yaml.safe_load(f) or {}
        rows = data.get("ratings") or []
        if not rows:
            return

        tag_lookup = self._build_tag_lookup()
        seeded = 0
        for entry in rows:
            if not isinstance(entry, dict):
                continue
            event_id = entry.get("event_id")
            stars = entry.get("stars")
            if not event_id or not stars:
                continue
            email = (entry.get("email") or "").strip().lower() or None
            user_id = None
            if email:
                user = self.session.exec(
                    select(User).where(User.email == email)
                ).first()
                if not user:
                    logger.warning(
                        "Skipping rating: user %s not found (seed users first)",
                        email,
                    )
                    continue
                user_id = user.id

            # Idempotency: same (event_id, user_id) → skip.
            if user_id is not None:
                existing = self.session.exec(
                    select(EventRating).where(
                        EventRating.event_id == event_id,
                        EventRating.user_id == user_id,
                    )
                ).first()
                if existing:
                    continue

            review_tag_ids: list[int] = []
            for slug in entry.get("review_tag_slugs") or []:
                tid = tag_lookup.get(slug)
                if tid:
                    review_tag_ids.append(tid)
                else:
                    logger.warning("Unknown review tag slug '%s'", slug)

            status = entry.get("status") or "approved"
            now = datetime.utcnow()
            rating = EventRating(
                id=uuid4(),
                event_id=event_id,
                user_id=user_id,
                stars=int(stars),
                comment=entry.get("comment"),
                review_tag_ids=review_tag_ids,
                is_anonymous=bool(entry.get("is_anonymous", False)),
                status=status,
                admin_notes=entry.get("admin_notes"),
                reviewed_at=now if status != "pending" else None,
                reviewed_by=("seed" if status != "pending" else None),
                created_at=now,
            )
            self.session.add(rating)

            seeded += 1
        if seeded:
            logger.info("Seeded %d EventRating rows", seeded)
