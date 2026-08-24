"""add neutral review tag polarity

Revision ID: rvsz1a2b3c4d
Revises: ar3a1ab2e1c2
Create Date: 2026-08-23
"""

from typing import Union

from alembic import op


revision: str = "rvsz1a2b3c4d"
down_revision: Union[str, None] = "ar3a1ab2e1c2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("ck_tags_polarity", "tags", type_="check")
    op.create_check_constraint(
        "ck_tags_polarity",
        "tags",
        "polarity IS NULL OR polarity IN ('positive', 'negative', 'neutral')",
    )
    op.execute(
        "UPDATE tags SET polarity = 'neutral' "
        "WHERE polarity IS NULL AND group_id IN "
        "(SELECT id FROM tag_groups WHERE scope = 'aspect')"
    )
    op.execute(
        "UPDATE tags SET enabled = false WHERE "
        "(group_id = (SELECT id FROM tag_groups WHERE slug = 'venue-quality') "
        "AND slug IN ('good-food', 'good-bar', 'poor-food', 'poor-drinks')) OR "
        "(group_id = (SELECT id FROM tag_groups WHERE slug = 'atmosphere') "
        "AND slug IN ('small-event', 'large-event'))"
    )


def downgrade() -> None:
    op.execute("UPDATE tags SET polarity = NULL WHERE polarity = 'neutral'")
    op.drop_constraint("ck_tags_polarity", "tags", type_="check")
    op.create_check_constraint(
        "ck_tags_polarity",
        "tags",
        "polarity IS NULL OR polarity IN ('positive', 'negative')",
    )
