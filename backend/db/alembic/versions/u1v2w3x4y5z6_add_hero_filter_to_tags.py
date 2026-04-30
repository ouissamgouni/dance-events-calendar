"""add_hero_filter_to_tags

Revision ID: u1v2w3x4y5z6
Revises: t1u2v3w4x5y6
Create Date: 2026-04-30

"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "u1v2w3x4y5z6"
down_revision: Union[str, None] = "t1u2v3w4x5y6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "tags",
        sa.Column(
            "is_hero_filter",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.add_column(
        "tags",
        sa.Column("hero_ordinal", sa.Integer(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("tags", "hero_ordinal")
    op.drop_column("tags", "is_hero_filter")
