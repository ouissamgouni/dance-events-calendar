"""merge duplicate event tags

Revision ID: t5e3f4a7b8c9
Revises: s4d2f3a6b7c8
Create Date: 2026-09-20

Consolidate four event tags that were copied from ``format`` into ``misc``.
The ``misc`` rows are canonical because they carry the hero-filter metadata
and most production references already point to them.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "t5e3f4a7b8c9"
down_revision: Union[str, None] = "s4d2f3a6b7c8"
branch_labels = None
depends_on = None


DUPLICATE_TAGS = (
    ("trip", "Trip", 10, ("getaway", "retreat", "tour", "excursion")),
    ("live-band", "Live band", 11, ("live music", "orchestra")),
    ("pool-party", "Pool party", 12, ("pool",)),
    ("beach-side", "Beach Side", 13, ("beach",)),
)


def _tag_id(bind, group_slug: str, tag_slug: str) -> int | None:
    return bind.execute(
        sa.text(
            "SELECT t.id FROM tags t "
            "JOIN tag_groups g ON g.id = t.group_id "
            "WHERE g.slug = :group_slug AND t.slug = :tag_slug"
        ),
        {"group_slug": group_slug, "tag_slug": tag_slug},
    ).scalar()


def _merge_join_rows(
    bind, table: str, owner_column: str, source_id: int, target_id: int
) -> None:
    bind.execute(
        sa.text(
            f"INSERT INTO {table} ({owner_column}, tag_id, created_at) "
            f"SELECT {owner_column}, :target_id, created_at FROM {table} "
            "WHERE tag_id = :source_id "
            f"ON CONFLICT ({owner_column}, tag_id) DO NOTHING"
        ),
        {"source_id": source_id, "target_id": target_id},
    )
    bind.execute(
        sa.text(f"DELETE FROM {table} WHERE tag_id = :source_id"),
        {"source_id": source_id},
    )


def upgrade() -> None:
    bind = op.get_bind()

    for slug, _label, _ordinal, _synonyms in DUPLICATE_TAGS:
        source_id = _tag_id(bind, "format", slug)
        target_id = _tag_id(bind, "misc", slug)
        if source_id is None or target_id is None:
            continue

        for table, owner_column in (
            ("event_tags", "event_id"),
            ("user_preferred_tags", "user_id"),
            ("user_interest_profile_tags", "profile_id"),
            ("calendar_default_tags", "calendar_id"),
            ("event_rating_aspect_tags", "rating_id"),
        ):
            _merge_join_rows(bind, table, owner_column, source_id, target_id)

        bind.execute(
            sa.text(
                "DELETE FROM tag_suggestions source "
                "WHERE source.tag_id = :source_id "
                "AND source.source = 'heuristic' "
                "AND source.status = 'pending' "
                "AND EXISTS ("
                "SELECT 1 FROM tag_suggestions target "
                "WHERE target.event_id = source.event_id "
                "AND target.tag_id = :target_id "
                "AND target.source = 'heuristic' "
                "AND target.status = 'pending'"
                ")"
            ),
            {"source_id": source_id, "target_id": target_id},
        )
        bind.execute(
            sa.text(
                "UPDATE tag_suggestions SET tag_id = :target_id "
                "WHERE tag_id = :source_id"
            ),
            {"source_id": source_id, "target_id": target_id},
        )

        bind.execute(
            sa.text(
                "INSERT INTO tag_synonyms (tag_id, term, created_at) "
                "SELECT :target_id, term, created_at FROM tag_synonyms "
                "WHERE tag_id = :source_id "
                "ON CONFLICT (tag_id, term) DO NOTHING"
            ),
            {"source_id": source_id, "target_id": target_id},
        )
        bind.execute(
            sa.text("DELETE FROM tag_synonyms WHERE tag_id = :source_id"),
            {"source_id": source_id},
        )
        bind.execute(
            sa.text("DELETE FROM tags WHERE id = :source_id"),
            {"source_id": source_id},
        )


def downgrade() -> None:
    bind = op.get_bind()
    format_group_id = bind.execute(
        sa.text("SELECT id FROM tag_groups WHERE slug = 'format'")
    ).scalar()
    if format_group_id is None:
        return

    for slug, label, ordinal, synonyms in DUPLICATE_TAGS:
        source_id = bind.execute(
            sa.text(
                "INSERT INTO tags "
                "(group_id, slug, label, ordinal, enabled, is_hero_filter, created_at) "
                "VALUES (:group_id, :slug, :label, :ordinal, true, false, NOW()) "
                "ON CONFLICT (group_id, slug) DO UPDATE SET label = EXCLUDED.label "
                "RETURNING id"
            ),
            {
                "group_id": format_group_id,
                "slug": slug,
                "label": label,
                "ordinal": ordinal,
            },
        ).scalar_one()
        for term in synonyms:
            bind.execute(
                sa.text(
                    "INSERT INTO tag_synonyms (tag_id, term, created_at) "
                    "VALUES (:tag_id, :term, NOW()) "
                    "ON CONFLICT (tag_id, term) DO NOTHING"
                ),
                {"tag_id": source_id, "term": term},
            )
