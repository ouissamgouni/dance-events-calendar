"""add event_schedules.unpublished_at

Revision ID: pu9d0e1f2a3b
Revises: op8c9d0e1f2a
Create Date: 2026-10-22
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "pu9d0e1f2a3b"
down_revision: Union[str, None] = "op8c9d0e1f2a"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "event_schedules",
        sa.Column("unpublished_at", sa.DateTime(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("event_schedules", "unpublished_at")
