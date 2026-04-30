"""add_event_attendance

Revision ID: s1t2u3v4w5x6
Revises: r1s2t3u4v5w6
Create Date: 2026-04-29

"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "s1t2u3v4w5x6"
down_revision: Union[str, None] = "r1s2t3u4v5w6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "event_attendances",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("event_id", sa.String(), nullable=False),
        sa.Column("device_id", sa.String(), nullable=False),
        sa.Column("action", sa.String(), nullable=False, server_default="going"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_event_attendances_event_id", "event_attendances", ["event_id"])
    op.create_index(
        "ix_event_attendances_device_id", "event_attendances", ["device_id"]
    )

    op.create_table(
        "user_event_attendances",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("device_id", sa.String(length=64), nullable=False),
        sa.Column("event_id", sa.String(), nullable=False),
        sa.Column("attending_since", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("device_id", "event_id"),
    )
    op.create_index(
        "ix_user_event_attendances_device_id", "user_event_attendances", ["device_id"]
    )
    op.create_index(
        "ix_user_event_attendances_event_id", "user_event_attendances", ["event_id"]
    )


def downgrade() -> None:
    op.drop_index(
        "ix_user_event_attendances_event_id", table_name="user_event_attendances"
    )
    op.drop_index(
        "ix_user_event_attendances_device_id", table_name="user_event_attendances"
    )
    op.drop_table("user_event_attendances")
    op.drop_index("ix_event_attendances_device_id", table_name="event_attendances")
    op.drop_index("ix_event_attendances_event_id", table_name="event_attendances")
    op.drop_table("event_attendances")
