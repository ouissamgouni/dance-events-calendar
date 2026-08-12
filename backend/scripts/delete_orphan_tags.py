"""Delete orphan tags (and their dependent rows) from the current DATABASE_URL.

Dry-run by default: prints the tag id and dependent-row counts per table.
Pass --commit to actually delete. Targets are hard-coded to the agreed orphan
set (audience leftovers + disabled venue:live-band).
"""

import sys

from sqlalchemy import text
from sqlmodel import Session, select

from backend.db.database import get_engine
from backend.db.models import Tag, TagGroup

# (group_slug, tag_slug)
TARGETS = [
    ("audience", "drinks-lovers"),
    ("audience", "food-lovers"),
    ("audience", "beginners"),
    ("audience", "intermediate"),
    ("audience", "advanced"),
    ("audience", "live-music-fans"),
    ("venue", "live-band"),
]

# Tables with a tag_id FK; delete dependent rows before the tag itself.
DEPENDENT_TABLES = [
    "tag_synonyms",
    "event_tags",
    "user_preferred_tags",
    "user_interest_profile_tags",
    "tag_suggestions",
    "event_rating_aspect_tags",
    "calendar_default_tags",
]


def main() -> None:
    commit = "--commit" in sys.argv
    engine = get_engine()
    with Session(engine) as session:
        tag_ids: list[tuple[str, str, int]] = []
        for group_slug, tag_slug in TARGETS:
            group = session.exec(
                select(TagGroup).where(TagGroup.slug == group_slug)
            ).first()
            if not group:
                print(f"SKIP {group_slug}:{tag_slug} — group not found")
                continue
            tag = session.exec(
                select(Tag).where(Tag.group_id == group.id, Tag.slug == tag_slug)
            ).first()
            if not tag:
                print(f"SKIP {group_slug}:{tag_slug} — tag not found")
                continue
            tag_ids.append((group_slug, tag_slug, tag.id))

        if not tag_ids:
            print("Nothing to delete.")
            return

        for group_slug, tag_slug, tid in tag_ids:
            print(f"\nTAG {group_slug}:{tag_slug} (id={tid})")
            for table in DEPENDENT_TABLES:
                count = session.exec(
                    text(f"SELECT COUNT(*) FROM {table} WHERE tag_id = :tid").bindparams(
                        tid=tid
                    )
                ).one()[0]
                print(f"    {table}: {count}")

        if not commit:
            print("\nDRY RUN — pass --commit to delete the above tags and dependents.")
            return

        for _group_slug, _tag_slug, tid in tag_ids:
            for table in DEPENDENT_TABLES:
                session.exec(
                    text(f"DELETE FROM {table} WHERE tag_id = :tid").bindparams(tid=tid)
                )
            session.exec(text("DELETE FROM tags WHERE id = :tid").bindparams(tid=tid))
        session.commit()
        print(f"\nDeleted {len(tag_ids)} tags and their dependent rows.")


if __name__ == "__main__":
    main()
