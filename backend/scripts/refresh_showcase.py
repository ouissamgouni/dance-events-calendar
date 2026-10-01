"""Refresh the prod-showcase catalog from narrowly scoped production reads."""

from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import logging
import os
import re
import tempfile
from pathlib import Path

import yaml
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlmodel import Session, create_engine, select

from backend.db.models import (
    CachedEvent,
    CalendarDefaultTag,
    CalendarSetting,
    EventSeries,
    EventSeriesMember,
    EventTag,
    Tag,
    TagGroup,
    TagSynonym,
)

logger = logging.getLogger(__name__)

ROOT_DIR = Path(__file__).parents[2]
DEFAULT_OUTPUT_DIR = ROOT_DIR / "scenarios" / "prod-showcase"
DEFAULT_IMAGE_BASE_URL = "https://cdn.joinmovida.com"
GENERATED_FILES = ("calendars.yaml", "tags.yaml", "db-events.yaml")
SHOWCASE_CONFIG = "showcase.yaml"
OVERLAY_FILES = (
    "overlay-events.yaml",
    "db-attendances.yaml",
    "db-saves.yaml",
    "db-messages.yaml",
    "db-promo-codes.yaml",
    "db-organizer-claims.yaml",
    "db-schedules.yaml",
    "db-notifications.yaml",
)
USER_REFERENCE_FILES = (
    "overlay-events.yaml",
    "db-attendances.yaml",
    "db-saves.yaml",
    "db-follows.yaml",
    "db-messages.yaml",
    "db-promo-codes.yaml",
    "db-organizer-claims.yaml",
    "db-interest-profiles.yaml",
    "db-schedules.yaml",
    "db-notifications.yaml",
)
USER_REFERENCE_KEYS = {
    "email",
    "submitter_email",
    "follower",
    "followee",
    "user",
    "recipient",
    "actor",
}
FORBIDDEN_ENTITY_PATTERN = re.compile(
    r"\b(?:demo|example|fake|showcase|synthetic|test)\b", re.IGNORECASE
)


def _event_ids_from_overlay(value) -> set[str]:
    ids: set[str] = set()
    if isinstance(value, dict):
        event_id = value.get("event_id")
        if isinstance(event_id, str):
            ids.add(event_id)
        for child in value.values():
            ids.update(_event_ids_from_overlay(child))
    elif isinstance(value, list):
        for child in value:
            ids.update(_event_ids_from_overlay(child))
    return ids


def _values_for_keys(value, keys: set[str]) -> list[str]:
    values: list[str] = []
    if isinstance(value, dict):
        for key, child in value.items():
            if (not keys or key in keys) and isinstance(child, str):
                values.append(child)
            values.extend(_values_for_keys(child, keys))
    elif isinstance(value, list):
        for child in value:
            values.extend(_values_for_keys(child, keys))
    return values


def _load_yaml(path: Path) -> dict:
    if not path.exists():
        return {}
    with path.open(encoding="utf-8") as file:
        return yaml.safe_load(file) or {}


def _normalized_asset_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def _validate_local_assets(output_dir: Path, users: list[dict]) -> None:
    missing = []
    for user in users:
        filename = user.get("avatar") if isinstance(user, dict) else None
        if filename and not (output_dir / "user-avatars" / filename).is_file():
            missing.append(f"avatar {filename}")

    overlay = _load_yaml(output_dir / "overlay-events.yaml")
    for event in overlay.get("events") or []:
        filename = event.get("image") if isinstance(event, dict) else None
        if not filename:
            continue
        if not (output_dir / "images" / filename).is_file():
            missing.append(f"event image {filename}")
            continue
        image_name = re.sub(r"^\d+[-_]", "", Path(filename).stem)
        if _normalized_asset_name(image_name) != _normalized_asset_name(
            event.get("title", "")
        ):
            raise ValueError(f"Showcase event image does not match title: {filename}")

    if missing:
        raise ValueError("Missing showcase local assets: " + ", ".join(sorted(missing)))


def _validate_review_tags(output_dir: Path) -> None:
    tag_groups = _load_yaml(output_dir / "tags.yaml").get("tag_groups") or []
    scopes = {
        f"{group['slug']}:{tag['slug']}": group.get("scope", "event")
        for group in tag_groups
        for tag in group.get("tags") or []
    }
    ratings = _load_yaml(output_dir / "overlay-events.yaml").get("ratings") or []
    invalid = []
    for rating in ratings:
        for slug in rating.get("aspect_tags") or []:
            if scopes.get(slug) != "aspect":
                invalid.append(slug)
        for slug in rating.get("audience_tags") or []:
            if scopes.get(slug) != "audience":
                invalid.append(slug)
        for group_slug in rating.get("aspect_scores") or {}:
            if not any(
                group.get("slug") == group_slug and group.get("scope") == "aspect"
                for group in tag_groups
            ):
                invalid.append(group_slug)
    if invalid:
        raise ValueError(
            "Showcase reviews reference invalid tags or aspects: "
            + ", ".join(sorted(set(invalid)))
        )


def validate_showcase_fixtures(output_dir: Path, event_ids: set[str]) -> None:
    users = _load_yaml(output_dir / "mock-users.yaml").get("users") or []
    emails = [
        user.get("email", "").strip().lower()
        for user in users
        if isinstance(user, dict) and user.get("email")
    ]
    handles = [
        user.get("handle", "").strip().lower()
        for user in users
        if isinstance(user, dict) and user.get("handle")
    ]
    duplicate_emails = sorted(
        value for value, count in Counter(emails).items() if count > 1
    )
    duplicate_handles = sorted(
        value for value, count in Counter(handles).items() if count > 1
    )
    if duplicate_emails or duplicate_handles:
        details = []
        if duplicate_emails:
            details.append("emails: " + ", ".join(duplicate_emails))
        if duplicate_handles:
            details.append("handles: " + ", ".join(duplicate_handles))
        raise ValueError("Duplicate showcase identities: " + "; ".join(details))

    known_emails = set(emails)
    unknown_users_by_file: dict[str, list[str]] = {}
    forbidden_by_file: dict[str, list[str]] = {}
    for filename in ("mock-users.yaml", *USER_REFERENCE_FILES):
        path = output_dir / filename
        if not path.exists():
            continue
        data = _load_yaml(path)
        if filename != "mock-users.yaml":
            references = {
                value.strip().lower()
                for value in _values_for_keys(data, USER_REFERENCE_KEYS)
            }
            missing = sorted(references - known_emails)
            if missing:
                unknown_users_by_file[filename] = missing
        forbidden = sorted(
            {
                value
                for value in _values_for_keys(data, set())
                if FORBIDDEN_ENTITY_PATTERN.search(value)
            }
        )
        if forbidden:
            forbidden_by_file[filename] = forbidden

    if unknown_users_by_file:
        details = "; ".join(
            f"{filename}: {', '.join(values)}"
            for filename, values in sorted(unknown_users_by_file.items())
        )
        raise ValueError("Showcase fixtures reference unknown users: " + details)

    _validate_local_assets(output_dir, users)
    _validate_review_tags(output_dir)
    validate_overlays(output_dir, event_ids)

    if forbidden_by_file:
        details = "; ".join(
            f"{filename}: {', '.join(values)}"
            for filename, values in sorted(forbidden_by_file.items())
        )
        raise ValueError("Showcase entity naming looks non-production: " + details)


def validate_overlays(output_dir: Path, event_ids: set[str]) -> None:
    missing_by_file: dict[str, list[str]] = {}
    for filename in OVERLAY_FILES:
        path = output_dir / filename
        if not path.exists():
            continue
        with path.open(encoding="utf-8") as file:
            data = yaml.safe_load(file) or {}
        missing = sorted(_event_ids_from_overlay(data) - event_ids)
        if missing:
            missing_by_file[filename] = missing
    if missing_by_file:
        details = "; ".join(
            f"{filename}: {', '.join(ids)}"
            for filename, ids in sorted(missing_by_file.items())
        )
        raise ValueError(
            f"Showcase overlays reference events outside the snapshot: {details}"
        )


def load_showcase_config(output_dir: Path) -> dict:
    path = output_dir / SHOWCASE_CONFIG
    if not path.exists():
        raise ValueError(f"Missing showcase configuration: {path}")
    with path.open(encoding="utf-8") as file:
        config = yaml.safe_load(file) or {}

    production = config.get("production") or {}
    required_ids = production.get("required_ids") or []
    required_series_ids = production.get("required_series_ids") or []
    synthetic_counts = config.get("synthetic_counts") or {}
    if not required_ids:
        raise ValueError("showcase.yaml production.required_ids must not be empty")
    if not all(isinstance(event_id, str) and event_id for event_id in required_ids):
        raise ValueError("showcase.yaml production.required_ids must contain strings")
    if not all(isinstance(series_id, int) for series_id in required_series_ids):
        raise ValueError(
            "showcase.yaml production.required_series_ids must contain integers"
        )
    allowed_counts = {"events", "series", "ratings", "messages"}
    unknown_counts = sorted(set(synthetic_counts) - allowed_counts)
    if unknown_counts:
        raise ValueError(
            "showcase.yaml synthetic_counts has unknown keys: "
            + ", ".join(unknown_counts)
        )
    if set(synthetic_counts) != allowed_counts or not all(
        isinstance(count, int) and count >= 0 for count in synthetic_counts.values()
    ):
        raise ValueError(
            "showcase.yaml synthetic_counts must define non-negative integer "
            "events, series, ratings, and messages"
        )
    return {
        "required_ids": list(dict.fromkeys(required_ids)),
        "required_series_ids": list(dict.fromkeys(required_series_ids)),
        "synthetic_counts": synthetic_counts,
    }


def validate_synthetic_counts(output_dir: Path, expected: dict[str, int]) -> None:
    with (output_dir / "overlay-events.yaml").open(encoding="utf-8") as file:
        overlay = yaml.safe_load(file) or {}
    messages_path = output_dir / "db-messages.yaml"
    with messages_path.open(encoding="utf-8") as file:
        messages = yaml.safe_load(file) or {}
    actual = {
        "events": len(overlay.get("events") or []),
        "series": len(overlay.get("event_series") or []),
        "ratings": len(overlay.get("ratings") or []),
        "messages": len(messages.get("messages") or []),
    }
    mismatches = [
        f"{key}: expected {expected[key]}, found {actual[key]}"
        for key in sorted(expected)
        if expected[key] != actual[key]
    ]
    if mismatches:
        raise ValueError("Synthetic showcase counts changed: " + "; ".join(mismatches))


def merge_synthetic_overlay(
    output_dir: Path,
    calendar_doc: dict,
    event_doc: dict,
) -> tuple[dict, dict]:
    path = output_dir / "overlay-events.yaml"
    if not path.exists():
        return calendar_doc, event_doc
    with path.open(encoding="utf-8") as file:
        overlay = yaml.safe_load(file) or {}

    production_ids = {event["id"] for event in event_doc.get("events", [])}
    synthetic_events = overlay.get("events") or []
    synthetic_ids = {event["id"] for event in synthetic_events}
    duplicate_synthetic_ids = {
        event_id
        for event_id in synthetic_ids
        if sum(event["id"] == event_id for event in synthetic_events) > 1
    }
    duplicates = sorted((production_ids & synthetic_ids) | duplicate_synthetic_ids)
    if duplicates:
        raise ValueError(
            "Synthetic showcase event IDs collide with production: "
            + ", ".join(duplicates)
        )

    known_ids = production_ids | synthetic_ids
    missing_members = sorted(
        {
            event_id
            for series in overlay.get("event_series") or []
            for event_id in series.get("members") or []
            if event_id not in known_ids
        }
    )
    if missing_members:
        raise ValueError(
            "Synthetic showcase series reference missing events: "
            + ", ".join(missing_members)
        )
    missing_ratings = sorted(
        {
            rating.get("event_id")
            for rating in overlay.get("ratings") or []
            if rating.get("event_id") not in known_ids
        }
    )
    if missing_ratings:
        raise ValueError(
            "Synthetic showcase ratings reference missing events: "
            + ", ".join(missing_ratings)
        )

    merged_calendars = {**calendar_doc}
    merged_calendars["calendars"] = [
        *calendar_doc.get("calendars", []),
        *(overlay.get("calendars") or []),
    ]
    merged_events = {**event_doc}
    merged_events["events"] = [*event_doc.get("events", []), *synthetic_events]
    for key, value in overlay.items():
        if key not in {"calendars", "events"}:
            merged_events[key] = [*event_doc.get(key, []), *value]
    return merged_calendars, merged_events


def _tag_slug(group_slug: str, tag_slug: str) -> str:
    return f"{group_slug}:{tag_slug}"


def build_snapshot(
    session: Session,
    *,
    required_event_ids: list[str],
    required_series_ids: list[int],
    image_base_url: str,
) -> tuple[dict, dict, dict, dict]:
    series = (
        list(
            session.exec(
                select(EventSeries).where(EventSeries.id.in_(required_series_ids))
            ).all()
        )
        if required_series_ids
        else []
    )
    found_series_ids = {item.id for item in series}
    missing_series_ids = sorted(set(required_series_ids) - found_series_ids)
    if missing_series_ids:
        raise ValueError(
            "Required production series not found: "
            + ", ".join(str(series_id) for series_id in missing_series_ids)
        )
    memberships = (
        list(
            session.exec(
                select(EventSeriesMember).where(
                    EventSeriesMember.series_id.in_(required_series_ids)
                )
            ).all()
        )
        if required_series_ids
        else []
    )
    members_by_series: dict[int, list[str]] = {}
    for member in memberships:
        members_by_series.setdefault(member.series_id, []).append(member.event_id)
    selected_ids = set(required_event_ids) | {member.event_id for member in memberships}

    visible_calendar_ids = set(
        session.exec(
            select(CalendarSetting.calendar_id).where(
                CalendarSetting.show_events.is_(True)
            )
        ).all()
    )
    events = list(
        session.exec(
            select(CachedEvent).where(
                CachedEvent.event_id.in_(selected_ids),
                CachedEvent.calendar_id.in_(visible_calendar_ids),
                CachedEvent.deleted_at.is_(None),
                CachedEvent.is_hidden.is_(False),
            )
        ).all()
    )
    events.sort(key=lambda event: (event.start, event.event_id))
    event_ids = {event.event_id for event in events}
    missing_event_ids = sorted(selected_ids - event_ids)
    if missing_event_ids:
        raise ValueError(
            "Required production events not found or not visible: "
            + ", ".join(missing_event_ids)
        )

    calendars = list(
        session.exec(
            select(CalendarSetting).where(
                CalendarSetting.calendar_id.in_({event.calendar_id for event in events})
            )
        ).all()
    )
    calendars.sort(key=lambda calendar: (calendar.name.lower(), calendar.calendar_id))

    groups = list(session.exec(select(TagGroup)).all())
    groups.sort(key=lambda group: (group.ordinal, group.slug))
    tags = list(session.exec(select(Tag)).all())
    tags_by_group: dict[int, list[Tag]] = {}
    for tag in tags:
        tags_by_group.setdefault(tag.group_id, []).append(tag)

    synonyms_by_tag: dict[int, list[str]] = {}
    for tag_id, term in session.exec(select(TagSynonym.tag_id, TagSynonym.term)).all():
        synonyms_by_tag.setdefault(tag_id, []).append(term)

    tag_slugs_by_id = {
        tag.id: _tag_slug(group.slug, tag.slug)
        for group in groups
        for tag in tags_by_group.get(group.id, [])
    }
    calendar_default_tags: dict[str, list[str]] = {}
    for calendar_id, tag_id in session.exec(
        select(CalendarDefaultTag.calendar_id, CalendarDefaultTag.tag_id).where(
            CalendarDefaultTag.calendar_id.in_(
                {calendar.calendar_id for calendar in calendars}
            )
        )
    ).all():
        if tag_id in tag_slugs_by_id:
            calendar_default_tags.setdefault(calendar_id, []).append(
                tag_slugs_by_id[tag_id]
            )

    event_tag_rows = session.exec(
        select(EventTag.event_id, Tag.slug, TagGroup.slug)
        .join(Tag, Tag.id == EventTag.tag_id)
        .join(TagGroup, TagGroup.id == Tag.group_id)
        .where(EventTag.event_id.in_(event_ids))
    ).all()
    event_tags: dict[str, list[str]] = {}
    for event_id, tag_slug, group_slug in event_tag_rows:
        event_tags.setdefault(event_id, []).append(_tag_slug(group_slug, tag_slug))

    image_base = image_base_url.rstrip("/")
    event_rows = []
    for event in events:
        image_url = event.image_url
        if event.image_key:
            image_url = f"{image_base}/{event.image_key.strip('/')}/full.webp"
        row = {
            "id": event.event_id,
            "calendar_id": event.calendar_id,
            "title": event.title,
            "description": event.description,
            "image_url": image_url,
            "location": event.location,
            "city": event.city,
            "country": event.country,
            "country_code": event.country_code,
            "latitude": event.latitude,
            "longitude": event.longitude,
            "start": event.start.isoformat(),
            "end": event.end.isoformat(),
            "all_day": event.all_day,
            "price_min": event.price_min,
            "price_max": event.price_max,
            "price_currency": event.price_currency,
            "price_is_free": event.price_is_free,
            "links": event.links,
            "show_price_override": event.show_price_override,
            "show_promo_override": event.show_promo_override,
            "tags": sorted(event_tags.get(event.event_id, [])),
        }
        event_rows.append(
            {key: value for key, value in row.items() if value is not None}
        )

    calendar_doc = {
        "calendars": [
            {
                "id": calendar.calendar_id,
                "name": calendar.name,
                "color": calendar.color,
                "enabled": calendar.enabled,
                "default_tags": sorted(
                    calendar_default_tags.get(calendar.calendar_id, [])
                ),
            }
            for calendar in calendars
        ]
    }
    tag_doc = {
        "tag_groups": [
            {
                "slug": group.slug,
                "label": group.label,
                "ordinal": group.ordinal,
                "allow_multiple": group.allow_multiple,
                "enabled": group.enabled,
                "onboarding_eligible": group.onboarding_eligible,
                "scope": group.scope,
                **({"color": group.color} if group.color is not None else {}),
                **(
                    {"condition_tag_slugs": group.condition_tag_slugs}
                    if group.condition_tag_slugs
                    else {}
                ),
                "tags": [
                    {
                        "slug": tag.slug,
                        "label": tag.label,
                        "ordinal": tag.ordinal,
                        "enabled": tag.enabled,
                        "is_hero_filter": tag.is_hero_filter,
                        **(
                            {"hero_ordinal": tag.hero_ordinal}
                            if tag.hero_ordinal is not None
                            else {}
                        ),
                        **({"color": tag.color} if tag.color is not None else {}),
                        **(
                            {"polarity": tag.polarity}
                            if tag.polarity is not None
                            else {}
                        ),
                        **(
                            {"synonyms": sorted(synonyms_by_tag.get(tag.id, []))}
                            if tag.id in synonyms_by_tag
                            else {}
                        ),
                    }
                    for tag in sorted(
                        tags_by_group.get(group.id, []),
                        key=lambda item: (item.ordinal, item.slug),
                    )
                ],
            }
            for group in groups
        ]
    }
    event_doc = {
        "events": event_rows,
        "event_series": [
            {
                "canonical_title": item.canonical_title,
                "status": item.status,
                "source": item.source,
                "members": sorted(members_by_series.get(item.id or 0, [])),
            }
            for item in sorted(series, key=lambda item: item.id or 0)
        ],
    }
    manifest = {
        "counts": {
            "exported_events": len(events),
            "exported_series": len(series),
            "calendars": len(calendars),
            "tag_groups": len(groups),
            "tags": len(tags),
        },
    }
    return calendar_doc, tag_doc, event_doc, manifest


def _write_yaml(path: Path, data: dict) -> None:
    with path.open("w", encoding="utf-8") as file:
        yaml.safe_dump(data, file, sort_keys=False, allow_unicode=True)


def write_snapshot(
    output_dir: Path,
    calendar_doc: dict,
    tag_doc: dict,
    event_doc: dict,
    manifest: dict,
    *,
    synthetic_counts: dict[str, int],
) -> None:
    validate_synthetic_counts(output_dir, synthetic_counts)
    calendar_doc, event_doc = merge_synthetic_overlay(
        output_dir,
        calendar_doc,
        event_doc,
    )
    event_ids = {event["id"] for event in event_doc["events"]}
    validate_showcase_fixtures(output_dir, event_ids)

    with tempfile.TemporaryDirectory(dir=output_dir.parent) as temp_name:
        temp_dir = Path(temp_name)
        _write_yaml(temp_dir / "calendars.yaml", calendar_doc)
        _write_yaml(temp_dir / "tags.yaml", tag_doc)
        _write_yaml(temp_dir / "db-events.yaml", event_doc)
        digest = hashlib.sha256()
        for filename in GENERATED_FILES:
            digest.update((temp_dir / filename).read_bytes())
        manifest = {**manifest, "content_sha256": digest.hexdigest()}
        (temp_dir / "showcase-manifest.json").write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        for filename in (*GENERATED_FILES, "showcase-manifest.json"):
            os.replace(temp_dir / filename, output_dir / filename)


def _assert_production_source(database_url: str) -> None:
    parsed = make_url(database_url)
    if parsed.get_backend_name() != "postgresql":
        raise ValueError("Showcase refresh requires a PostgreSQL production URL")
    if not parsed.host or parsed.host in {"localhost", "127.0.0.1", "::1"}:
        raise ValueError(
            "Showcase refresh source must be the remote production database"
        )


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument(
        "--image-base-url",
        default=os.getenv(
            "PROD_OBJECT_STORAGE_PUBLIC_BASE_URL", DEFAULT_IMAGE_BASE_URL
        ),
    )
    args = parser.parse_args()

    database_url = os.getenv("DATABASE_URL", "")
    if not database_url:
        raise RuntimeError("DATABASE_URL is required")
    _assert_production_source(database_url)
    output_dir = args.output_dir.resolve()
    if output_dir != DEFAULT_OUTPUT_DIR.resolve():
        raise ValueError(f"Output must be {DEFAULT_OUTPUT_DIR}")
    config = load_showcase_config(output_dir)

    engine = create_engine(database_url, pool_pre_ping=True)
    with engine.connect() as connection:
        transaction = connection.begin()
        connection.execute(text("SET TRANSACTION READ ONLY"))
        with Session(bind=connection) as session:
            documents = build_snapshot(
                session,
                required_event_ids=config["required_ids"],
                required_series_ids=config["required_series_ids"],
                image_base_url=args.image_base_url,
            )
        transaction.rollback()
    write_snapshot(
        output_dir,
        *documents,
        synthetic_counts=config["synthetic_counts"],
    )
    logger.info(
        "Refreshed %s: %d events",
        output_dir,
        documents[3]["counts"]["exported_events"],
    )


if __name__ == "__main__":
    main()
