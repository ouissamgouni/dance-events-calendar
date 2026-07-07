"""add_notification_deliveries

Revision ID: l5m6n7o8p9q0
Revises: k4l5m6n7o8p9
Create Date: 2026-07-06

Adds ``notification_deliveries``: an audit-log table with one row per
actual app/email/push distribution event of a ``Notification``. Unlike
``notifications.emailed_at``/``pushed_at`` (internal bookkeeping stamps
that mark a row as "processed this dispatch tick" regardless of whether
the recipient's channel toggle allowed a real send), a row here is only
inserted when the channel genuinely delivered. Powers the admin
Notifications log (``GET /api/admin/notifications/log``) with an accurate,
append-only history instead of deriving delivery status from those mutable
timestamps. Schema-only migration; no data backfill.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "l5m6n7o8p9q0"
down_revision: Union[str, None] = "k4l5m6n7o8p9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if "notification_deliveries" not in inspector.get_table_names():
        op.create_table(
            "notification_deliveries",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column(
                "notification_id",
                sa.Integer(),
                sa.ForeignKey("notifications.id"),
                nullable=False,
            ),
            sa.Column("channel", sa.String(), nullable=False),
            sa.Column("delivered_at", sa.DateTime(), nullable=False),
        )
        op.create_index(
            "ix_notification_deliveries_notification_id",
            "notification_deliveries",
            ["notification_id"],
        )
        op.create_index(
            "ix_notification_deliveries_channel",
            "notification_deliveries",
            ["channel"],
        )
        op.create_index(
            "ix_notification_deliveries_delivered_at",
            "notification_deliveries",
            ["delivered_at"],
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if "notification_deliveries" in inspector.get_table_names():
        op.drop_index(
            "ix_notification_deliveries_delivered_at",
            table_name="notification_deliveries",
        )
        op.drop_index(
            "ix_notification_deliveries_channel", table_name="notification_deliveries"
        )
        op.drop_index(
            "ix_notification_deliveries_notification_id",
            table_name="notification_deliveries",
        )
        op.drop_table("notification_deliveries")
