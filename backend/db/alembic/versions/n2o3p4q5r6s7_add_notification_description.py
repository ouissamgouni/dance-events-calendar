"""add_notification_description

Revision ID: n2o3p4q5r6s7
Revises: cons1stency01
Create Date: 2026-08-10

Adds ``notifications.description`` (nullable string, max 255 chars): optional
narrative field for notification types that benefit from additional context
beyond the name/context fields. Initially used for ``milestone_unlocked``
notifications to show the milestone's descriptive copy.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "n2o3p4q5r6s7"
down_revision: Union[str, None] = "cons1stency01"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = {c["name"] for c in inspector.get_columns("notifications")}
    if "description" not in existing:
        op.add_column(
            "notifications", sa.Column("description", sa.String(255), nullable=True)
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = {c["name"] for c in inspector.get_columns("notifications")}
    if "description" in existing:
        op.drop_column("notifications", "description")
