"""drop legacy review-tags TagGroup

Revision ID: i7g8b9c0d1e2
Revises: h6f7a8b9c0d1
Create Date: 2026-08-06

The flat ``review-tags`` group (``scope='review'``) seeded by
``y1z2a3b4c5d6`` is superseded by the adaptive review vocabulary
(``scope='aspect'`` / ``scope='audience'`` groups seeded from
``scenarios/*/tags.yaml``). It is no longer offered anywhere in the UI, so
this migration removes the group (and its tags + dependent join rows) from
every environment. Idempotent: a no-op when the group is already absent.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "i7g8b9c0d1e2"
down_revision: Union[str, None] = "h6f7a8b9c0d1"
branch_labels = None
depends_on = None


# Mirrors the seed set in y1z2a3b4c5d6 so downgrade restores prior state.
REVIEW_TAGS = [
    ("great-music", "Great music"),
    ("friendly-crowd", "Friendly crowd"),
    ("crowded", "Crowded"),
    ("overpriced", "Overpriced"),
    ("beginner-friendly", "Beginner-friendly"),
    ("authentic", "Authentic"),
    ("loud", "Loud"),
    ("good-venue", "Good venue"),
]

_TAG_IDS = (
    "SELECT id FROM tags WHERE group_id IN "
    "(SELECT id FROM tag_groups WHERE slug = 'review-tags')"
)


def upgrade() -> None:
    bind = op.get_bind()

    group_id = bind.execute(
        sa.text("SELECT id FROM tag_groups WHERE slug = 'review-tags'")
    ).scalar()
    if group_id is None:
        return

    # Detach dependent join rows first so the FK to tags does not block delete.
    for table in (
        "tag_synonyms",
        "event_tags",
        "user_preferred_tags",
        "user_interest_profile_tags",
    ):
        bind.execute(sa.text(f"DELETE FROM {table} WHERE tag_id IN ({_TAG_IDS})"))
    bind.execute(
        sa.text(
            f"UPDATE tag_suggestions SET tag_id = NULL WHERE tag_id IN ({_TAG_IDS})"
        )
    )

    bind.execute(sa.text(f"DELETE FROM tags WHERE group_id = {int(group_id)}"))
    bind.execute(sa.text("DELETE FROM tag_groups WHERE slug = 'review-tags'"))


def downgrade() -> None:
    bind = op.get_bind()
    group_id = bind.execute(
        sa.text(
            "INSERT INTO tag_groups (slug, label, color, ordinal, allow_multiple, "
            "enabled, onboarding_eligible, scope, created_at) VALUES "
            "('review-tags', 'Review tags', '#f59e0b', 100, true, true, false, "
            "'review', NOW()) "
            "ON CONFLICT (slug) DO UPDATE SET label = EXCLUDED.label "
            "RETURNING id"
        )
    ).scalar_one()

    for ordinal, (slug, label) in enumerate(REVIEW_TAGS):
        bind.execute(
            sa.text(
                "INSERT INTO tags (group_id, slug, label, ordinal, enabled, "
                "is_hero_filter, created_at) VALUES "
                "(:group_id, :slug, :label, :ordinal, true, false, NOW()) "
                "ON CONFLICT (group_id, slug) DO NOTHING"
            ),
            {"group_id": group_id, "slug": slug, "label": label, "ordinal": ordinal},
        )
