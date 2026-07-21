import json
import hashlib
import logging
import re
from datetime import date, datetime, timedelta
from itertools import cycle
from pathlib import Path
from typing import Any, Optional
from uuid import uuid4

import yaml
from sqlmodel import Session, delete, select

from backend.db.models import (
    BlockedEvent,
    CachedEvent,
    CalendarDefaultTag,
    CalendarSetting,
    EventExport,
    EventLinkClick,
    EventPromoCode,
    EventRating,
    EventTag,
    EventView,
    OrganizerClaim,
    OrganizerClaimEvent,
    SiteSetting,
    Tag,
    TagGroup,
    TagSuggestion,
    TagSynonym,
    User,
    UserEventAttendance,
    UserFollow,
    UserInterestProfile,
    UserInterestProfileTag,
    UserSavedEvent,
)
from backend.services.follows import (
    ensure_approved_follow_with_subscription,
    ensure_calendar_subscription,
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


def _seed_device_id(prefix: str, event_id: str, identity: str) -> str:
    digest = hashlib.sha1(f"{event_id}:{identity}".encode("utf-8")).hexdigest()[:16]
    return f"{prefix}-{digest}"


def scenario_file_with_default(scenario_dir: Path, filename: str) -> Path:
    path = scenario_dir / filename
    if path.exists():
        return path
    default_path = SCENARIOS_DIR / "default" / filename
    if (
        default_path.exists()
        and scenario_dir.resolve() != default_path.parent.resolve()
    ):
        logger.info("Using default scenario %s for %s", filename, scenario_dir.name)
        return default_path
    return path


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

        self._seed_tags(scenario_file_with_default(scenario_dir, "tags.yaml"))
        self._ensure_system_tag_groups()
        self._seed_tag_synonyms_defaults()
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
        self._seed_users(scenario_file_with_default(scenario_dir, "mock-users.yaml"))
        self._seed_generated_events(scenario_dir / "generated-events.yaml")
        # Follows must come AFTER users (FK on follower_id/followee_id).
        self._seed_follows(scenario_dir / "db-follows.yaml")
        # Interest profiles must come AFTER users + tags (FKs on both).
        self._seed_interest_profiles(scenario_dir / "db-interest-profiles.yaml")
        # Attendances/saves must come AFTER users (FK on user_id) and after events.
        self._seed_attendances(scenario_dir / "db-events.yaml")
        self._seed_attendances(scenario_dir / "db-attendances.yaml")
        self._seed_user_saved_events(scenario_dir / "db-events.yaml")
        self._seed_user_saved_events(scenario_dir / "db-saves.yaml")
        self._seed_ratings(scenario_dir / "db-events.yaml")
        self._seed_promo_codes(scenario_dir / "db-promo-codes.yaml")
        self._seed_organizer_claims(scenario_dir / "db-organizer-claims.yaml")
        self._seed_site_settings(
            scenario_file_with_default(scenario_dir, "settings.yaml")
        )
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
            onboarding_eligible: true
            color: "#f472b6"
            tags:
              - slug: social
                label: Social
                # Optional: explicit synonyms for the heuristic tag suggester.
                # When present, this list is the authoritative set for the
                # tag — existing rows in `tag_synonyms` for this tag are
                # wiped and replaced. Omit the key (or set null) to leave
                # existing rows untouched.
                synonyms: ["soiree", "fiesta"]
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

            with self.session.no_autoflush:
                group = self.session.exec(
                    select(TagGroup).where(TagGroup.slug == slug)
                ).first()

            ordinal = group_data.get("ordinal", group_idx)
            allow_multiple = group_data.get("allow_multiple", True)
            color = group_data.get("color")
            enabled = group_data.get("enabled", True)
            onboarding_eligible = group_data.get("onboarding_eligible", False)
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
                group.onboarding_eligible = onboarding_eligible
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
                    onboarding_eligible=onboarding_eligible,
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

                with self.session.no_autoflush:
                    tag = self.session.exec(
                        select(Tag).where(
                            Tag.group_id == group.id, Tag.slug == tag_slug
                        )
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
                    tag = Tag(
                        group_id=group.id,
                        slug=tag_slug,
                        label=tag_label,
                        ordinal=tag_ordinal,
                        color=tag_color,
                        enabled=tag_enabled,
                        is_hero_filter=tag_is_hero,
                        hero_ordinal=tag_hero_ordinal,
                    )
                    self.session.add(tag)
                    self.session.flush()

                # Optional per-tag synonyms (scenario-driven, fully reproducible).
                # When `synonyms:` is provided, it is treated as the authoritative
                # set for this tag — existing DB rows for this tag are replaced.
                # Omit the key (or pass null) to leave existing rows untouched.
                if "synonyms" in tag_data:
                    raw_syns = tag_data.get("synonyms") or []
                    if not isinstance(raw_syns, list):
                        logger.warning(
                            "Tag %s/%s: `synonyms` must be a list; got %r",
                            slug,
                            tag_slug,
                            type(raw_syns).__name__,
                        )
                    else:
                        # Wipe & rewrite: scenarios stay deterministic across reseeds.
                        self.session.exec(
                            delete(TagSynonym).where(TagSynonym.tag_id == tag.id)
                        )
                        # Force deletes out before reinserting the authoritative
                        # synonym set, otherwise a later autoflush can try to
                        # insert duplicates before the old rows are removed.
                        self.session.flush()
                        seen: set[str] = set()
                        for raw in raw_syns:
                            term = (str(raw) or "").strip().lower()
                            if not term or term in seen:
                                continue
                            seen.add(term)
                            self.session.add(TagSynonym(tag_id=tag.id, term=term))

    def _ensure_system_tag_groups(self) -> None:
        """Idempotently guarantee the tag groups the app depends on.

        ``reach`` and ``dance-style`` are consumed by the interest-profiles
        code (see ``services.interest_notification_service``) and the
        onboarding UI. Scenarios that ship a truncated ``tags.yaml`` (or
        none at all) must still get these two groups so the app boots into
        a usable state. Existing rows are left untouched — this only
        creates what's missing.
        """
        # (group_slug, group_kwargs, [(tag_slug, tag_kwargs), ...])
        system_groups: list[tuple[str, dict, list[tuple[str, dict]]]] = [
            (
                "reach",
                dict(
                    label="Reach",
                    ordinal=30,
                    allow_multiple=True,
                    onboarding_eligible=True,
                    color="#a78bfa",
                    enabled=True,
                    scope="event",
                ),
                [
                    ("local", dict(label="Local", ordinal=0)),
                    ("regional", dict(label="Regional", ordinal=1)),
                    ("international", dict(label="International", ordinal=2)),
                ],
            ),
            (
                "dance-style",
                dict(
                    label="Dance Style",
                    ordinal=50,
                    allow_multiple=True,
                    onboarding_eligible=True,
                    color="#fb923c",
                    enabled=True,
                    scope="event",
                ),
                [
                    (
                        "salsa",
                        dict(
                            label="Salsa",
                            ordinal=0,
                            is_hero_filter=True,
                            hero_ordinal=1,
                        ),
                    ),
                    (
                        "bachata",
                        dict(
                            label="Bachata",
                            ordinal=1,
                            is_hero_filter=True,
                            hero_ordinal=2,
                        ),
                    ),
                    ("kizomba", dict(label="Kizomba", ordinal=2)),
                    ("semba", dict(label="Semba", ordinal=3)),
                    ("zouk", dict(label="Zouk", ordinal=4)),
                    ("rueda", dict(label="Rueda", ordinal=5)),
                    ("cha-cha", dict(label="Cha-Cha", ordinal=6)),
                    ("son", dict(label="Son", ordinal=7)),
                ],
            ),
        ]

        for group_slug, group_kwargs, tag_specs in system_groups:
            with self.session.no_autoflush:
                group = self.session.exec(
                    select(TagGroup).where(TagGroup.slug == group_slug)
                ).first()
            if not group:
                group = TagGroup(slug=group_slug, **group_kwargs)
                self.session.add(group)
                self.session.flush()
                logger.info("Created system tag group: %s", group_slug)
            for tag_slug, tag_kwargs in tag_specs:
                with self.session.no_autoflush:
                    existing = self.session.exec(
                        select(Tag).where(
                            Tag.group_id == group.id, Tag.slug == tag_slug
                        )
                    ).first()
                if existing:
                    continue
                self.session.add(Tag(group_id=group.id, slug=tag_slug, **tag_kwargs))
                self.session.flush()
                logger.info("Created system tag: %s/%s", group_slug, tag_slug)

    def _seed_tag_synonyms_defaults(self) -> None:
        """Idempotently seed default heuristic synonyms from the static map.

        For each tag whose slug appears in
        :data:`backend.services.tag_synonyms.TAG_SYNONYMS` and which currently
        has zero rows in ``tag_synonyms``, bulk-insert the default terms. This
        runs after ``_seed_tags`` so all tag ids exist; admin-edited tags keep
        their custom set untouched.
        """
        from backend.services.tag_synonyms import TAG_SYNONYMS

        tags = self.session.exec(select(Tag)).all()
        for tag in tags:
            defaults = TAG_SYNONYMS.get(tag.slug)
            if not defaults:
                continue
            existing = self.session.exec(
                select(TagSynonym).where(TagSynonym.tag_id == tag.id)
            ).first()
            if existing:
                continue
            for term in defaults:
                normalised = (term or "").strip().lower()
                if not normalised:
                    continue
                self.session.add(TagSynonym(tag_id=tag.id, term=normalised))
        self.session.flush()

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
            # Flush deletes before inserts so SQLAlchemy's unit-of-work doesn't
            # reorder the new INSERTs ahead of the DELETEs and trip the
            # uq_calendar_default_tag unique constraint.
            if existing:
                self.session.flush()

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
                if "is_hidden" in evt_data:
                    existing.is_hidden = evt_data["is_hidden"]
                if "show_price_override" in evt_data:
                    existing.show_price_override = evt_data["show_price_override"]
                if "show_promo_override" in evt_data:
                    existing.show_promo_override = evt_data["show_promo_override"]
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
                        is_hidden=evt_data.get("is_hidden", False),
                        show_price_override=evt_data.get("show_price_override"),
                        show_promo_override=evt_data.get("show_promo_override"),
                    )
                )
                logger.info("Created event: %s", evt_data["title"])

            # Insert a BlockedEvent row if the scenario marks this event blocked.
            # This prevents sync from re-inserting it and seeds the is_blocked state.
            if evt_data.get("is_blocked", False):
                if not self.session.get(BlockedEvent, evt_id):
                    self.session.add(BlockedEvent(event_id=evt_id))
                    logger.info("Blocked event: %s", evt_id)

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
            source = sug.get("source", "user")
            confidence = sug.get("confidence")
            matched_terms = sug.get("matched_terms")

            tag_id = tag_lookup.get(tag_slug) if tag_slug else None

            self.session.add(
                TagSuggestion(
                    event_id=event_id,
                    tag_id=tag_id,
                    free_text=free_text,
                    status=status,
                    submitter_device_id=device_id,
                    source=source,
                    confidence=confidence,
                    matched_terms=matched_terms,
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
          # Scenario-level default. When true (the default), mock users
          # without an explicit ``onboarded_at`` are auto-stamped as
          # already-onboarded at the current server-side onboarding
          # version, so non-onboarding scenarios don't accidentally
          # trip the OnboardingGate redirect. Scenarios that exercise
          # the onboarding flow (e.g. scenarios/onboarding,
          # interest-onboarding-international) should set
          # ``auto_onboard: false`` at the top level.
          auto_onboard: true
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

        # Scenario-wide onboarding default (Phase G). Individual entries
        # may still override by setting ``onboarded_at`` explicitly.
        auto_onboard_default = bool(data.get("auto_onboard", True))
        from backend.config.loader import get_current_onboarding_version

        current_onboarding_version = get_current_onboarding_version()

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
                avatar_url = entry.get("avatar_url")
                if avatar_url and not existing.avatar_url:
                    existing.avatar_url = avatar_url
                    self.session.add(existing)
                    logger.info("Updated mock user avatar: %s", email)
                continue
            user_kwargs: dict = dict(
                email=email,
                display_name=entry.get("name") or email.split("@", 1)[0],
                provider="google",
                provider_subject=provider_subject,
            )
            # Optional social-foundation fields. Scenarios use these to
            # pre-seed handles, visibility, and the verified-organizer flag
            # so multi-user social flows can be exercised without manual
            # account setup.
            for key in (
                "handle",
                "account_visibility",
                "is_verified_organizer",
                "is_admin_managed",
                "show_in_suggestions",
                "managed_label",
                "share_attendance_default",
                "share_attendance_default_audience",
                "instagram_url",
                "facebook_url",
                "avatar_url",
                "bio",
                # Phase G — per-feature × per-channel notification flags.
                "email_event_reminders_enabled",
                "email_social_activity_enabled",
                "email_interest_matches_enabled",
                "push_event_reminders_enabled",
                "push_social_activity_enabled",
                "push_interest_matches_enabled",
                # Phase G — onboarding state. See ``auto_onboard`` handling
                # below for the scenario-wide default when these are omitted.
                "onboarded_at",
                "onboarding_version",
                "timezone",
                # Admin overrides for the PWA install / push opt-in banners.
                # Lets scenarios exercise the "forced" banner state without
                # a manual admin-panel toggle.
                "force_install_prompt",
                "force_enable_push_prompt",
                # First-observed PWA install timestamp — lets scenarios seed
                # an already-installed user for the Admin Users tab.
                "installed_at",
            ):
                if key in entry and entry[key] is not None:
                    user_kwargs[key] = entry[key]
            # ``onboarded_at`` in yaml may be a raw ISO string (most yaml
            # docs) or a parsed datetime (yaml's native timestamp syntax).
            # Normalize to datetime so SQLite/PG both accept it.
            raw_onboarded = user_kwargs.get("onboarded_at")
            if isinstance(raw_onboarded, str):
                user_kwargs["onboarded_at"] = datetime.fromisoformat(raw_onboarded)
            # Same string/datetime normalization for installed_at.
            raw_installed = user_kwargs.get("installed_at")
            if isinstance(raw_installed, str):
                user_kwargs["installed_at"] = datetime.fromisoformat(raw_installed)
            # Phase G — apply the scenario-wide auto-onboard default when
            # the entry didn't explicitly opt in or out. Explicit
            # ``onboarded_at: null`` in yaml means "leave un-onboarded" and
            # is preserved because ``entry[key] is not None`` above skips
            # it, so we only stamp defaults here if the key is missing.
            if auto_onboard_default and "onboarded_at" not in entry:
                user_kwargs["onboarded_at"] = datetime.utcnow()
                user_kwargs.setdefault("onboarding_version", current_onboarding_version)
            # Phase G legacy aliases — accepted for one release, written
            # through to the corresponding new flags. Emits a stderr
            # deprecation warning per §G.7.1.
            _legacy_write_through = {
                "reminder_email_enabled": ("email_event_reminders_enabled",),
                "activity_email_enabled": (
                    "email_social_activity_enabled",
                    "email_interest_matches_enabled",
                ),
                "push_enabled": (
                    "push_event_reminders_enabled",
                    "push_social_activity_enabled",
                    "push_interest_matches_enabled",
                ),
                "interest_notifications_enabled": (
                    "email_interest_matches_enabled",
                    "push_interest_matches_enabled",
                ),
            }
            for legacy_key, targets in _legacy_write_through.items():
                if legacy_key in entry and entry[legacy_key] is not None:
                    import sys as _sys

                    _sys.stderr.write(
                        f"[seed] warning: mock-user {email}: legacy "
                        f"'{legacy_key}' is deprecated; use "
                        f"{'/'.join(targets)} (Phase G).\n"
                    )
                    for target in targets:
                        user_kwargs.setdefault(target, entry[legacy_key])
            if user_kwargs.get("is_admin_managed") is True:
                user_kwargs["share_attendance_default"] = True
                user_kwargs["share_attendance_default_audience"] = "public"
            self.session.add(User(**user_kwargs))
            logger.info("Created mock user: %s", email)

    def _seed_generated_events(self, path: Path) -> None:
        if not path.exists():
            return

        with open(path) as f:
            data = yaml.safe_load(f) or {}

        cfg = data.get("generated_events") or {}
        count = int(cfg.get("count") or 0)
        if count <= 0:
            return

        calendars = cfg.get("calendar_ids") or [
            cal.calendar_id for cal in self.session.exec(select(CalendarSetting)).all()
        ]
        calendars = [str(cal) for cal in calendars if cal]
        if not calendars:
            logger.warning("Skipping generated events: no calendars available")
            return

        prefix = str(cfg.get("id_prefix") or "perf-gen")
        start_week = int(cfg.get("start_week", -8))
        weeks = max(1, int(cfg.get("weeks", 32)))
        views_per_event = max(0, int(cfg.get("views_per_event", 0)))
        saves_per_event = max(0, int(cfg.get("saves_per_event", 0)))
        attendances_per_event = max(0, int(cfg.get("attendances_per_event", 0)))
        save_handles = [
            str(handle).strip()
            for handle in (cfg.get("user_save_handles") or [])
            if str(handle).strip()
        ]
        attendance_handles = [
            str(handle).strip()
            for handle in (cfg.get("user_attendance_handles") or [])
            if str(handle).strip()
        ]
        user_by_handle = {
            user.handle: user
            for user in self.session.exec(select(User)).all()
            if user.handle
        }

        today = date.today()
        reference_monday = today - timedelta(days=today.weekday())
        window_start = datetime.combine(
            reference_monday, datetime.min.time()
        ) + timedelta(weeks=start_week)
        tag_lookup = self._build_tag_lookup()

        locations = [
            ("Le Balajo, Paris, France", 48.8533, 2.3716),
            ("Bar Salsa, London, UK", 51.5142, -0.13),
            ("Mojito Club, Barcelona, Spain", 41.3925, 2.1568),
            ("Tanzhaus Berlin, Germany", 52.5244, 13.3884),
            ("Akvarium Klub, Budapest, Hungary", 47.4979, 19.051),
            ("Centro Cultural de Belem, Lisbon, Portugal", 38.696, -9.2092),
        ]
        formats = ["social", "class", "workshop", "festival", "congress", "practice"]
        scopes = ["local", "regional", "international"]
        venues = ["indoor", "outdoor", "rooftop"]
        styles = ["salsa", "bachata", "kizomba", "zouk", "rueda"]
        levels = ["beginner-friendly", "intermediate", "advanced", "all-levels"]
        calendar_cycle = cycle(calendars)

        events_seeded = 0
        tags_seeded = 0
        views_seeded = 0
        saves_seeded = 0
        attendances_seeded = 0

        for idx in range(count):
            event_id = f"{prefix}-{idx + 1:05d}"
            calendar_id = next(calendar_cycle)
            day_offset = (idx * 3) % (weeks * 7)
            hour = 18 + (idx % 5)
            start = window_start + timedelta(days=day_offset, hours=hour)
            duration_hours = 3 + (idx % 4)
            if formats[idx % len(formats)] in ("festival", "congress"):
                duration_hours = 48 + (idx % 3) * 12
            end = start + timedelta(hours=duration_hours)
            location, latitude, longitude = locations[idx % len(locations)]
            style = styles[idx % len(styles)]
            event_format = formats[idx % len(formats)]
            title = f"{style.title()} {event_format.title()} #{idx + 1}"

            existing = self.session.get(CachedEvent, event_id)
            if existing:
                existing.calendar_id = calendar_id
                existing.title = title
                existing.description = "Generated production-volume perf fixture event."
                existing.location = location
                existing.latitude = latitude
                existing.longitude = longitude
                existing.start = start
                existing.end = end
                existing.price_is_free = idx % 4 == 0
                existing.review_status = "reviewed"
                existing.deleted_at = None
                existing.is_hidden = False
                existing.updated_at = datetime.utcnow()
                self.session.add(existing)
            else:
                self.session.add(
                    CachedEvent(
                        event_id=event_id,
                        calendar_id=calendar_id,
                        title=title,
                        description="Generated production-volume perf fixture event.",
                        location=location,
                        latitude=latitude,
                        longitude=longitude,
                        start=start,
                        end=end,
                        price_is_free=idx % 4 == 0,
                        review_status="reviewed",
                    )
                )
                events_seeded += 1

            tag_slugs = [
                f"format:{event_format}",
                f"reach:{scopes[idx % len(scopes)]}",
                f"venue:{venues[idx % len(venues)]}",
                f"dance-style:{style}",
                f"level:{levels[idx % len(levels)]}",
            ]
            for slug in tag_slugs:
                tag_id = tag_lookup.get(slug)
                if not tag_id:
                    continue
                existing_tag = self.session.exec(
                    select(EventTag).where(
                        EventTag.event_id == event_id, EventTag.tag_id == tag_id
                    )
                ).first()
                if not existing_tag:
                    self.session.add(EventTag(event_id=event_id, tag_id=tag_id))
                    tags_seeded += 1

            for view_idx in range(views_per_event):
                device_id = f"seed-view-{idx % 250:03d}-{view_idx}"
                source = "explorer-list" if view_idx % 2 == 0 else "calendar"
                existing_view = self.session.exec(
                    select(EventView).where(
                        EventView.event_id == event_id,
                        EventView.device_id == device_id,
                        EventView.source == source,
                    )
                ).first()
                if not existing_view:
                    self.session.add(
                        EventView(
                            event_id=event_id,
                            device_id=device_id,
                            source=source,
                            country="France" if idx % 2 == 0 else "Germany",
                            city="Paris" if idx % 2 == 0 else "Berlin",
                        )
                    )
                    views_seeded += 1

            for save_idx in range(saves_per_event):
                save_user = (
                    user_by_handle.get(
                        save_handles[(idx + save_idx) % len(save_handles)]
                    )
                    if save_handles
                    else None
                )
                device_id = (
                    f"seed-save-user-{save_user.handle}-{idx % 300:03d}-{save_idx}"
                    if save_user
                    else f"seed-save-{idx % 300:03d}-{save_idx}"
                )
                save_identity_filter = (
                    UserSavedEvent.user_id == save_user.id
                    if save_user
                    else UserSavedEvent.device_id == device_id
                )
                existing_save = self.session.exec(
                    select(UserSavedEvent).where(
                        UserSavedEvent.event_id == event_id,
                        save_identity_filter,
                    )
                ).first()
                if not existing_save:
                    self.session.add(
                        UserSavedEvent(
                            event_id=event_id,
                            device_id=device_id,
                            user_id=save_user.id if save_user else None,
                            audience="public" if save_idx % 2 == 0 else "friends",
                        )
                    )
                    saves_seeded += 1

            for attendance_idx in range(attendances_per_event):
                attendance_user = (
                    user_by_handle.get(
                        attendance_handles[
                            (idx + attendance_idx) % len(attendance_handles)
                        ]
                    )
                    if attendance_handles
                    else None
                )
                device_id = (
                    f"seed-attend-user-{attendance_user.handle}-{idx % 350:03d}-{attendance_idx}"
                    if attendance_user
                    else f"seed-attend-{idx % 350:03d}-{attendance_idx}"
                )
                attendance_identity_filter = (
                    UserEventAttendance.user_id == attendance_user.id
                    if attendance_user
                    else UserEventAttendance.device_id == device_id
                )
                existing_attendance = self.session.exec(
                    select(UserEventAttendance).where(
                        UserEventAttendance.event_id == event_id,
                        attendance_identity_filter,
                    )
                ).first()
                if not existing_attendance:
                    self.session.add(
                        UserEventAttendance(
                            event_id=event_id,
                            device_id=device_id,
                            user_id=attendance_user.id if attendance_user else None,
                            share_publicly=attendance_idx % 2 == 0,
                            share_audience="public"
                            if attendance_idx % 2 == 0
                            else "friends",
                        )
                    )
                    attendances_seeded += 1

        logger.info(
            "Generated perf fixture: %d events, %d tags, %d views, %d saves, %d attendances",
            events_seeded,
            tags_seeded,
            views_seeded,
            saves_seeded,
            attendances_seeded,
        )

    def _seed_follows(self, path: Path) -> None:
        """Seed UserFollow rows from scenarios/<name>/db-follows.yaml.

        Lets a scenario pre-build the friends graph so social-foundation
        flows (mutual = friend, follow-back, friends-only visibility) can
        be exercised without manual click-through. Idempotent on the
        (follower, followee) pair.

        Set top-level ``emit_notifications: true`` to also emit
        ``new_follower`` (and ``new_friend`` when a mutual pair is
        seeded) — mirroring the HTTP follow route. Notification digest
        scenarios rely on this to produce assertable rows.

        Expected structure:
          emit_notifications: true   # optional, default false
          follows:
            - follower: alice@example.com   # email or handle
              followee: bob@example.com
            - follower: bob
              followee: alice
        """
        if not path.exists():
            return

        with open(path) as f:
            data = yaml.safe_load(f) or {}

        emit_notifications = bool(data.get("emit_notifications", False))
        # Track approved (follower_id, followee_id) pairs created in this
        # seed pass so we can fire new_follower and detect mutual pairs
        # for new_friend after all rows are inserted.
        approved_pairs: list[tuple[int, int]] = []

        def _resolve(ref: str) -> User | None:
            ref = (ref or "").strip()
            if not ref:
                return None
            if "@" in ref:
                return self.session.exec(
                    select(User).where(User.email == ref.lower())
                ).first()
            return self.session.exec(select(User).where(User.handle == ref)).first()

        for entry in data.get("follows", []) or []:
            if not isinstance(entry, dict):
                continue
            follower = _resolve(entry.get("follower", ""))
            followee = _resolve(entry.get("followee", ""))
            if not follower or not followee or follower.id == followee.id:
                logger.warning("Skipping follow row: %r", entry)
                continue
            # Phase E (E8): optional ``status`` (approved|pending). Defaults
            # to ``approved`` to preserve legacy seed behaviour. Pending rows
            # are used by the friend-requests scenario to pre-seed an
            # inbound request without hand-clicking.
            status = entry.get("status", "approved")
            if status not in ("approved", "pending"):
                status = "approved"
            existing = self.session.exec(
                select(UserFollow).where(
                    UserFollow.follower_id == follower.id,
                    UserFollow.followee_id == followee.id,
                )
            ).first()
            if existing:
                if existing.status == "approved":
                    ensure_calendar_subscription(self.session, follower.id, followee.id)
                continue
            if status == "approved":
                ensure_approved_follow_with_subscription(
                    self.session, follower.id, followee.id
                )
                approved_pairs.append((follower.id, followee.id))
            else:
                self.session.add(
                    UserFollow(
                        follower_id=follower.id,
                        followee_id=followee.id,
                        status=status,
                    )
                )
                ensure_calendar_subscription(self.session, follower.id, followee.id)
            logger.info(
                "Created mock follow: %s -> %s (%s)",
                follower.email,
                followee.email,
                status,
            )

        if emit_notifications and approved_pairs:
            from backend.services.notifications import (
                notify_new_follower,
                notify_new_friend,
            )

            self.session.flush()
            pair_set = set(approved_pairs)
            friend_seen: set[tuple[int, int]] = set()
            for follower_id, followee_id in approved_pairs:
                follower_user = self.session.get(User, follower_id)
                followee_user = self.session.get(User, followee_id)
                if follower_user is None or followee_user is None:
                    continue
                notify_new_follower(
                    self.session, followee=followee_user, follower=follower_user
                )
                if (followee_id, follower_id) in pair_set:
                    key = tuple(sorted((follower_id, followee_id)))
                    if key in friend_seen:
                        continue
                    friend_seen.add(key)
                    notify_new_friend(self.session, follower_user, followee_user)

    def _seed_interest_profiles(self, path: Path) -> None:
        """Seed UserInterestProfile rows from db-interest-profiles.yaml.

        Lets scenarios pre-build the notification matcher's inputs
        (geography bbox + dance/reach tags + per-profile notify toggle)
        without having to walk each user through the onboarding UI.
        Idempotent on (user_id, label).

        Expected structure:
          interest_profiles:
            - user: nora@example.com     # email or handle
              label: "Europe & nearby"
              min_lat: 24
              min_lng: -18
              max_lat: 69
              max_lng: 50
              dance_tags: ["dance-style:salsa"]   # slug or "group:slug"
              reach_tags: ["reach:international"]
              matches_enabled: true               # legacy: notify_enabled
              is_active: true
        """
        if not path.exists():
            return

        with open(path) as f:
            data = yaml.safe_load(f) or {}

        def _resolve_user(ref: str) -> User | None:
            ref = (ref or "").strip()
            if not ref:
                return None
            if "@" in ref:
                return self.session.exec(
                    select(User).where(User.email == ref.lower())
                ).first()
            return self.session.exec(select(User).where(User.handle == ref)).first()

        def _resolve_tag(ref: str) -> Tag | None:
            ref = (ref or "").strip()
            if not ref:
                return None
            group_slug, sep, tag_slug = ref.partition(":")
            if sep:
                group = self.session.exec(
                    select(TagGroup).where(TagGroup.slug == group_slug)
                ).first()
                if group is None:
                    return None
                return self.session.exec(
                    select(Tag).where(Tag.group_id == group.id, Tag.slug == tag_slug)
                ).first()
            return self.session.exec(select(Tag).where(Tag.slug == ref)).first()

        for entry in data.get("interest_profiles", []) or []:
            if not isinstance(entry, dict):
                continue
            user = _resolve_user(entry.get("user", ""))
            if user is None:
                logger.warning("Skipping interest profile (unknown user): %r", entry)
                continue
            label = (entry.get("label") or "").strip()
            if not label:
                logger.warning("Skipping interest profile (missing label): %r", entry)
                continue
            try:
                min_lat = float(entry["min_lat"])
                min_lng = float(entry["min_lng"])
                max_lat = float(entry["max_lat"])
                max_lng = float(entry["max_lng"])
            except (KeyError, TypeError, ValueError):
                logger.warning("Skipping interest profile (bad bbox): %r", entry)
                continue

            existing = self.session.exec(
                select(UserInterestProfile).where(
                    UserInterestProfile.user_id == user.id,
                    UserInterestProfile.label == label,
                )
            ).first()
            # Accept legacy ``notify_enabled`` key for one release.
            matches_enabled = entry.get("matches_enabled")
            if matches_enabled is None and "notify_enabled" in entry:
                import sys as _sys

                _sys.stderr.write(
                    f"[seed] warning: interest_profile {label!r}: legacy "
                    f"'notify_enabled' is deprecated; use 'matches_enabled' "
                    f"(Phase G).\n"
                )
                matches_enabled = entry["notify_enabled"]
            if matches_enabled is None:
                matches_enabled = True
            matches_enabled = bool(matches_enabled)
            if existing:
                profile = existing
                profile.min_lat = min_lat
                profile.min_lng = min_lng
                profile.max_lat = max_lat
                profile.max_lng = max_lng
                profile.matches_enabled = matches_enabled
                profile.is_active = bool(entry.get("is_active", False))
                self.session.add(profile)
                self.session.flush()
                self.session.exec(
                    delete(UserInterestProfileTag).where(
                        UserInterestProfileTag.profile_id == profile.id
                    )
                )
            else:
                profile = UserInterestProfile(
                    user_id=user.id,
                    label=label[:120],
                    min_lat=min_lat,
                    min_lng=min_lng,
                    max_lat=max_lat,
                    max_lng=max_lng,
                    matches_enabled=matches_enabled,
                    is_active=bool(entry.get("is_active", False)),
                )
                self.session.add(profile)
                self.session.flush()

            tag_refs = (entry.get("dance_tags") or []) + (entry.get("reach_tags") or [])
            for tag_ref in tag_refs:
                tag = _resolve_tag(str(tag_ref))
                if tag is None:
                    logger.warning(
                        "Interest profile %r: unknown tag %r", label, tag_ref
                    )
                    continue
                self.session.add(
                    UserInterestProfileTag(profile_id=profile.id, tag_id=tag.id)
                )
            logger.info("Seeded interest profile %r for %s", label, user.email)

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
        """Pre-seed UserEventAttendance rows from db-events.yaml or db-attendances.yaml.

        Lets scenarios test "Who's going" UI states (e.g. large attendee
        lists, mixed public/private breakdowns) without driving the UI.
        Idempotent: existing (event_id, user_id, device_id) rows are skipped.

        Set top-level ``emit_notifications: true`` to also run the
        ``subscription_going`` fan-out that the HTTP attendance route
        performs (public/friends audience only). This lets notification
        digest scenarios pre-seed the notification rows they assert on
        without hand-driving the UI.

        Expected structure:
          emit_notifications: true   # optional, default false
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

        emit_notifications = bool(data.get("emit_notifications", False))
        fan_out_targets: list[tuple[int, str, str]] = []

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
            # Optional ``share_audience`` (one of public|friends|private).
            # When omitted, fall back to legacy ``share_publicly`` semantics so
            # existing scenarios behave identically.
            share_audience = entry.get("share_audience")
            if share_audience not in ("public", "friends", "private"):
                share_audience = "public" if share_publicly else "private"

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
                    device_id=device_id
                    or _seed_device_id("seed-attend", event_id, email or "anon"),
                    share_publicly=share_publicly,
                    share_audience=share_audience,
                )
            )
            seeded += 1
            if (
                emit_notifications
                and user_id is not None
                and share_audience in ("public", "friends")
            ):
                fan_out_targets.append((user_id, event_id, share_audience))
        if seeded:
            logger.info("Seeded %d UserEventAttendance rows", seeded)

        if fan_out_targets:
            from backend.services.notifications import fan_out_going

            # Flush so the CalendarSubscription seeded via _seed_follows
            # (and any User row) is visible to fan_out_going's SELECT.
            self.session.flush()
            fanned = 0
            for actor_id, ev_id, audience in fan_out_targets:
                actor = self.session.get(User, actor_id)
                if actor is None:
                    continue
                fanned += fan_out_going(self.session, actor, ev_id, audience=audience)
            if fanned:
                logger.info(
                    "Emitted %d subscription_going notifications from seeded attendances",
                    fanned,
                )

    def _seed_user_saved_events(self, path: Path) -> None:
        """Pre-seed ``UserSavedEvent`` rows from db-events.yaml or db-saves.yaml.

        Lets scenarios test the trending / popularity score and the
        Following-badge "soft saved" fallback without driving the UI.
        Idempotent on ``(device_id, event_id)`` (the table's unique
        constraint).

        Expected structure::

            saves:
              - event_id: evt-trend-001
                email: alice@example.com   # required if no device_id
                audience: public           # public | friends | private (default friends)
              - event_id: evt-trend-001
                device_id: seed-anon-1     # anonymous, device-only save
        """
        if not path.exists():
            return

        with open(path) as f:
            data = yaml.safe_load(f) or {}

        rows = data.get("saves") or []
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
            audience = entry.get("audience") or "friends"
            if audience not in ("public", "friends", "private"):
                logger.warning(
                    "Skipping save for %s: invalid audience %r", event_id, audience
                )
                continue

            user_id = None
            if email:
                user = self.session.exec(
                    select(User).where(User.email == email)
                ).first()
                if not user:
                    logger.warning(
                        "Skipping save: user %s not found (seed users first)",
                        email,
                    )
                    continue
                user_id = user.id

            if user_id is None and not device_id:
                logger.warning(
                    "Skipping save for %s: needs email or device_id",
                    event_id,
                )
                continue

            effective_device_id = device_id or _seed_device_id(
                "seed-save", event_id, email or "anon"
            )

            # Idempotency check on the unique (device_id, event_id) constraint.
            existing = self.session.exec(
                select(UserSavedEvent).where(
                    UserSavedEvent.event_id == event_id,
                    UserSavedEvent.device_id == effective_device_id,
                )
            ).first()
            if existing:
                continue

            self.session.add(
                UserSavedEvent(
                    event_id=event_id,
                    user_id=user_id,
                    device_id=effective_device_id,
                    audience=audience,
                )
            )
            seeded += 1
        if seeded:
            logger.info("Seeded %d UserSavedEvent rows", seeded)

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

    def _seed_promo_codes(self, path: Path) -> None:
        """Pre-seed EventPromoCode rows from db-promo-codes.yaml.

        Each entry can specify:
          - event_id (required)
          - submitter_email (required — must exist in mock-users.yaml)
          - code (required)
          - description (optional)
          - source_url (optional)
          - expires_at (optional, ISO datetime)
          - status: pending | approved | rejected (default pending)
          - admin_notes (optional)
        Idempotent: skips when a row with the same
        ``(event_id, lower(code))`` already exists.
        """
        if not path.exists():
            return
        with open(path) as f:
            data = yaml.safe_load(f) or {}
        rows = data.get("promo_codes") or []
        if not rows:
            return

        seeded = 0
        for entry in rows:
            if not isinstance(entry, dict):
                continue
            event_id = entry.get("event_id")
            code = entry.get("code")
            email = (entry.get("submitter_email") or "").strip().lower() or None
            if not event_id or not code or not email:
                continue
            user = self.session.exec(select(User).where(User.email == email)).first()
            if not user:
                logger.warning("Skipping promo code: submitter %s not found", email)
                continue
            existing = self.session.exec(
                select(EventPromoCode).where(
                    EventPromoCode.event_id == event_id,
                    EventPromoCode.code == code,
                )
            ).first()
            if existing:
                continue
            status = entry.get("status") or "pending"
            now = datetime.utcnow()
            expires_at_raw = entry.get("expires_at")
            expires_at = None
            if expires_at_raw:
                if isinstance(expires_at_raw, datetime):
                    expires_at = expires_at_raw
                else:
                    try:
                        expires_at = datetime.fromisoformat(str(expires_at_raw))
                    except ValueError:
                        logger.warning(
                            "Bad expires_at %r on promo code %s", expires_at_raw, code
                        )
            self.session.add(
                EventPromoCode(
                    event_id=event_id,
                    code=code,
                    description=entry.get("description"),
                    source_url=entry.get("source_url"),
                    expires_at=expires_at,
                    submitter_user_id=user.id,
                    status=status,
                    admin_notes=entry.get("admin_notes"),
                    reviewed_at=now if status != "pending" else None,
                    reviewed_by=("seed" if status != "pending" else None),
                    created_at=now,
                    updated_at=now,
                )
            )
            seeded += 1
        if seeded:
            logger.info("Seeded %d EventPromoCode rows", seeded)

    def _seed_organizer_claims(self, path: Path) -> None:
        """Pre-seed OrganizerClaim + OrganizerClaimEvent rows from
        db-organizer-claims.yaml.

        Each entry:
          - submitter_email (required)
          - kind: ``"badge"`` (default) or ``"events"``
          - grant_badge (badge claims: default true; events: ignored)
          - status (default pending)
          - admin_notes (optional)
          - events: list of {event_id, decision} (required for kind=events;
            ignored for kind=badge)
        On approved decisions, the corresponding
        ``cached_events.organizer_user_id`` is set + the user's
        ``is_verified_organizer`` flag is flipped on (badge claims with
        status=approved + grant_badge=true).
        Idempotent: skips a claim if one already exists for that user
        of the same kind whose set of event_ids matches exactly.
        """
        if not path.exists():
            return
        with open(path) as f:
            data = yaml.safe_load(f) or {}
        rows = data.get("organizer_claims") or []
        if not rows:
            return

        seeded = 0
        for entry in rows:
            if not isinstance(entry, dict):
                continue
            email = (entry.get("submitter_email") or "").strip().lower() or None
            if not email:
                continue
            kind = (entry.get("kind") or "badge").lower()
            if kind not in ("badge", "events"):
                logger.warning("Skipping organizer claim: unknown kind %s", kind)
                continue
            event_entries = entry.get("events") or [] if kind == "events" else []
            user = self.session.exec(select(User).where(User.email == email)).first()
            if not user:
                logger.warning("Skipping organizer claim: user %s not found", email)
                continue
            event_ids = sorted(
                str(ev.get("event_id"))
                for ev in event_entries
                if isinstance(ev, dict) and ev.get("event_id")
            )
            if kind == "events" and not event_ids:
                continue
            existing_claims = self.session.exec(
                select(OrganizerClaim)
                .where(OrganizerClaim.user_id == user.id)
                .where(OrganizerClaim.kind == kind)
            ).all()
            duplicate = False
            for c in existing_claims:
                rows_existing = self.session.exec(
                    select(OrganizerClaimEvent).where(
                        OrganizerClaimEvent.claim_id == c.id
                    )
                ).all()
                if sorted(r.event_id for r in rows_existing) == event_ids:
                    duplicate = True
                    break
            if duplicate:
                continue

            status = entry.get("status") or "pending"
            grant_badge = bool(
                entry.get("grant_badge", True if kind == "badge" else False)
            )
            now = datetime.utcnow()
            claim = OrganizerClaim(
                user_id=user.id,
                kind=kind,
                grant_badge=grant_badge,
                status=status,
                admin_notes=entry.get("admin_notes"),
                reviewed_at=now if status != "pending" else None,
                reviewed_by=("seed" if status != "pending" else None),
                created_at=now,
                updated_at=now,
            )
            self.session.add(claim)
            self.session.flush()

            granted_event_ids: list[str] = []
            for ev in event_entries:
                if not isinstance(ev, dict):
                    continue
                event_id = ev.get("event_id")
                if not event_id:
                    continue
                decision = ev.get("decision") or "pending"
                self.session.add(
                    OrganizerClaimEvent(
                        claim_id=claim.id,
                        event_id=event_id,
                        decision=decision,
                        created_at=now,
                    )
                )
                if decision == "approved":
                    granted_event_ids.append(event_id)

            if granted_event_ids:
                cached_rows = self.session.exec(
                    select(CachedEvent).where(
                        CachedEvent.event_id.in_(granted_event_ids)
                    )
                ).all()
                for cev in cached_rows:
                    cev.organizer_user_id = user.id
                    self.session.add(cev)

            if kind == "badge" and grant_badge and status == "approved":
                user.is_verified_organizer = True
                self.session.add(user)

            seeded += 1
        if seeded:
            logger.info("Seeded %d OrganizerClaim rows", seeded)
