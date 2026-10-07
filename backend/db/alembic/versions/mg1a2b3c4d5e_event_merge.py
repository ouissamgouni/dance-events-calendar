"""cached_events.merged_into_event_id + merge_summary: admin event merges

Revision ID: mg1a2b3c4d5e
Revises: gh1a2b3c4d5e
Create Date: 2026-10-07
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "mg1a2b3c4d5e"
down_revision: Union[str, None] = "gh1a2b3c4d5e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "cached_events",
        sa.Column("merged_into_event_id", sa.String(), nullable=True),
    )
    op.create_index(
        "ix_cached_events_merged_into_event_id",
        "cached_events",
        ["merged_into_event_id"],
    )
    op.add_column("cached_events", sa.Column("merge_summary", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("cached_events", "merge_summary")
    op.drop_index("ix_cached_events_merged_into_event_id", table_name="cached_events")
    op.drop_column("cached_events", "merged_into_event_id")
