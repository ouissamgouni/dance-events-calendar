"""add blocked event reasons

Revision ID: br3a4b5c6d7e
Revises: pb2c3d4e5f6a
Create Date: 2026-09-30
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "br3a4b5c6d7e"
down_revision: Union[str, None] = "pb2c3d4e5f6a"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "blocked_events",
        sa.Column("reason", sa.String(length=32), nullable=True),
    )
    op.add_column(
        "blocked_events",
        sa.Column("reason_detail", sa.String(), nullable=True),
    )
    op.execute(
        """
        UPDATE blocked_events AS blocked
        SET reason = 'duplicate',
            reason_detail = events.rejected_duplicate_reason
        FROM cached_events AS events
        WHERE events.event_id = blocked.event_id
          AND events.rejected_duplicate_reason IS NOT NULL
        """
    )
    op.execute(
        """
        UPDATE blocked_events AS blocked
        SET reason = 'rejected',
            reason_detail = suggestions.admin_notes
        FROM cached_events AS events
        JOIN event_suggestions AS suggestions
          ON suggestions.id = events.suggestion_id
        WHERE events.event_id = blocked.event_id
          AND blocked.reason IS NULL
          AND suggestions.status = 'rejected'
        """
    )
    op.execute("UPDATE blocked_events SET reason = 'deleted' WHERE reason IS NULL")
    op.alter_column(
        "blocked_events",
        "reason",
        existing_type=sa.String(length=32),
        nullable=False,
        server_default="deleted",
    )
    op.create_check_constraint(
        "ck_blocked_events_reason",
        "blocked_events",
        "reason IN ('deleted', 'duplicate', 'rejected')",
    )


def downgrade() -> None:
    op.drop_constraint("ck_blocked_events_reason", "blocked_events", type_="check")
    op.drop_column("blocked_events", "reason_detail")
    op.drop_column("blocked_events", "reason")
