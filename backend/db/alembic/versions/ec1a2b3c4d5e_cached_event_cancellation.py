"""cached_events.is_cancelled + cancellation_note: organizer-requested cancellation

Revision ID: ec1a2b3c4d5e
Revises: sv1a2b3c4d5e
Create Date: 2026-10-06
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "ec1a2b3c4d5e"
down_revision: Union[str, None] = "sv1a2b3c4d5e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "cached_events",
        sa.Column(
            "is_cancelled", sa.Boolean(), nullable=False, server_default=sa.false()
        ),
    )
    op.add_column(
        "cached_events", sa.Column("cancellation_note", sa.Text(), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("cached_events", "cancellation_note")
    op.drop_column("cached_events", "is_cancelled")
