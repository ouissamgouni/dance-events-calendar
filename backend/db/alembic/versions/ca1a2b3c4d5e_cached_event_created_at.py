"""cached_events.created_at: when the event first entered the database

Revision ID: ca1a2b3c4d5e
Revises: rs1a2b3c4d5e
Create Date: 2026-10-07
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "ca1a2b3c4d5e"
down_revision: Union[str, None] = "rs1a2b3c4d5e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "cached_events",
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=True,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
    )
    # Best available guess for existing rows: first revision, then submission, then last sync.
    op.execute(
        """
        UPDATE cached_events SET created_at = COALESCE(
            (SELECT MIN(r.created_at) FROM event_revisions r
              WHERE r.event_id = cached_events.event_id),
            (SELECT s.created_at FROM event_suggestions s
              WHERE s.id = cached_events.suggestion_id),
            cached_events.updated_at
        )
        """
    )
    op.alter_column("cached_events", "created_at", nullable=False)
    op.create_index("ix_cached_events_created_at", "cached_events", ["created_at"])


def downgrade() -> None:
    op.drop_index("ix_cached_events_created_at", table_name="cached_events")
    op.drop_column("cached_events", "created_at")
