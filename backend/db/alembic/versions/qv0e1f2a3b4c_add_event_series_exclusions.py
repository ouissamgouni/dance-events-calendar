"""add event_series_exclusions

Revision ID: qv0e1f2a3b4c
Revises: pu9d0e1f2a3b
Create Date: 2026-10-22

Remembers events an admin removed from a series so auto-detection doesn't
re-add them on the next scan.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "qv0e1f2a3b4c"
down_revision: Union[str, None] = "pu9d0e1f2a3b"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "event_series_exclusions",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("series_id", sa.Integer(), nullable=False),
        sa.Column("event_id", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["series_id"], ["event_series.id"]),
        sa.ForeignKeyConstraint(["event_id"], ["cached_events.event_id"]),
        sa.UniqueConstraint("series_id", "event_id", name="uq_series_exclusion"),
    )
    op.create_index(
        "ix_event_series_exclusions_series_id",
        "event_series_exclusions",
        ["series_id"],
    )
    op.create_index(
        "ix_event_series_exclusions_event_id",
        "event_series_exclusions",
        ["event_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_event_series_exclusions_event_id", table_name="event_series_exclusions"
    )
    op.drop_index(
        "ix_event_series_exclusions_series_id", table_name="event_series_exclusions"
    )
    op.drop_table("event_series_exclusions")
