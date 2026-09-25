"""add event extractor source and state

Revision ID: x3y4z5a6b7c8
Revises: w2x3y4z5a6b7
Create Date: 2026-09-24
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "x3y4z5a6b7c8"
down_revision: Union[str, None] = "w2x3y4z5a6b7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("cached_events") as batch:
        batch.add_column(sa.Column("source_description", sa.Text(), nullable=True))
        batch.add_column(sa.Column("extractor_state", sa.JSON(), nullable=True))
    op.execute(
        "UPDATE cached_events SET source_description = description "
        "WHERE source_description IS NULL AND suggestion_id IS NULL"
    )


def downgrade() -> None:
    with op.batch_alter_table("cached_events") as batch:
        batch.drop_column("extractor_state")
        batch.drop_column("source_description")
