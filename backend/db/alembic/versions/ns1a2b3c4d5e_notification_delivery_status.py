"""notification deliveries: status/detail + recipient/kind for notification-less sends

Revision ID: ns1a2b3c4d5e
Revises: nb1a2b3c4d5e
Create Date: 2026-10-24
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "ns1a2b3c4d5e"
down_revision: Union[str, None] = "nb1a2b3c4d5e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    existing = {
        c["name"] for c in sa.inspect(bind).get_columns("notification_deliveries")
    }
    with op.batch_alter_table("notification_deliveries") as batch:
        batch.alter_column("notification_id", existing_type=sa.Integer(), nullable=True)
        if "recipient_user_id" not in existing:
            batch.add_column(sa.Column("recipient_user_id", sa.Uuid(), nullable=True))
            batch.create_foreign_key(
                "fk_notification_deliveries_recipient_user_id",
                "users",
                ["recipient_user_id"],
                ["id"],
            )
            batch.create_index(
                "ix_notification_deliveries_recipient_user_id", ["recipient_user_id"]
            )
        if "kind" not in existing:
            batch.add_column(sa.Column("kind", sa.String(length=40), nullable=True))
        if "status" not in existing:
            batch.add_column(sa.Column("status", sa.String(length=16), nullable=True))
        if "detail" not in existing:
            batch.add_column(sa.Column("detail", sa.String(length=120), nullable=True))


def downgrade() -> None:
    op.execute("DELETE FROM notification_deliveries WHERE notification_id IS NULL")
    with op.batch_alter_table("notification_deliveries") as batch:
        batch.drop_column("detail")
        batch.drop_column("status")
        batch.drop_column("kind")
        batch.drop_index("ix_notification_deliveries_recipient_user_id")
        batch.drop_constraint(
            "fk_notification_deliveries_recipient_user_id", type_="foreignkey"
        )
        batch.drop_column("recipient_user_id")
        batch.alter_column(
            "notification_id", existing_type=sa.Integer(), nullable=False
        )
