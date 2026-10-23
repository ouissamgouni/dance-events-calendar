"""notification deliveries: batch_id + rendered; notifications.email_opened_at

Revision ID: nb1a2b3c4d5e
Revises: pd1a2b3c4d5e
Create Date: 2026-10-23
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "nb1a2b3c4d5e"
down_revision: Union[str, None] = "pd1a2b3c4d5e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    deliveries = {
        c["name"] for c in sa.inspect(bind).get_columns("notification_deliveries")
    }
    if "batch_id" not in deliveries:
        op.add_column(
            "notification_deliveries",
            sa.Column("batch_id", sa.String(length=32), nullable=True),
        )
        op.create_index(
            "ix_notification_deliveries_batch_id",
            "notification_deliveries",
            ["batch_id"],
        )
    if "rendered" not in deliveries:
        op.add_column(
            "notification_deliveries",
            sa.Column("rendered", sa.Boolean(), nullable=True),
        )
    notifications = {c["name"] for c in sa.inspect(bind).get_columns("notifications")}
    if "email_opened_at" not in notifications:
        op.add_column(
            "notifications",
            sa.Column("email_opened_at", sa.DateTime(), nullable=True),
        )


def downgrade() -> None:
    op.drop_column("notifications", "email_opened_at")
    op.drop_column("notification_deliveries", "rendered")
    op.drop_index(
        "ix_notification_deliveries_batch_id", table_name="notification_deliveries"
    )
    op.drop_column("notification_deliveries", "batch_id")
