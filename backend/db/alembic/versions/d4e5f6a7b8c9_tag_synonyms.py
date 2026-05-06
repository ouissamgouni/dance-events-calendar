"""tag_synonyms table

Revision ID: d4e5f6a7b8c9
Revises: c3d4e5f6a7b8
Create Date: 2025-05-06 17:00:00.000000

Adds the ``tag_synonyms`` table that lets admins configure heuristic
synonym terms per tag. Replaces the static ``backend/services/tag_synonyms.py``
mapping at runtime; that file remains as the seed source for fresh installs.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "d4e5f6a7b8c9"
down_revision: Union[str, None] = "c3d4e5f6a7b8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "tag_synonyms",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "tag_id",
            sa.Integer(),
            sa.ForeignKey("tags.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("term", sa.String(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint("tag_id", "term", name="uq_tag_synonym_tag_term"),
    )
    op.create_index("ix_tag_synonyms_tag_id", "tag_synonyms", ["tag_id"])


def downgrade() -> None:
    op.drop_index("ix_tag_synonyms_tag_id", table_name="tag_synonyms")
    op.drop_table("tag_synonyms")
