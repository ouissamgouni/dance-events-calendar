"""add user_saved_events and share_tokens tables

Revision ID: r1s2t3u4v5w6
Revises: q1r2s3t4u5v6
Create Date: 2026-04-29 14:00:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "r1s2t3u4v5w6"
down_revision: Union[str, None] = "q1r2s3t4u5v6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "user_saved_events",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("device_id", sa.String(length=64), nullable=False),
        sa.Column("event_id", sa.String(), nullable=False),
        sa.Column("saved_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("device_id", "event_id"),
    )
    op.create_index(
        "ix_user_saved_events_device_id", "user_saved_events", ["device_id"]
    )
    op.create_index("ix_user_saved_events_event_id", "user_saved_events", ["event_id"])

    op.create_table(
        "share_tokens",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("token", sa.String(), nullable=False),
        sa.Column("device_id", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("token"),
        sa.UniqueConstraint("device_id"),
    )
    op.create_index("ix_share_tokens_token", "share_tokens", ["token"])
    op.create_index("ix_share_tokens_device_id", "share_tokens", ["device_id"])


def downgrade() -> None:
    op.drop_index("ix_share_tokens_device_id", table_name="share_tokens")
    op.drop_index("ix_share_tokens_token", table_name="share_tokens")
    op.drop_table("share_tokens")

    op.drop_index("ix_user_saved_events_event_id", table_name="user_saved_events")
    op.drop_index("ix_user_saved_events_device_id", table_name="user_saved_events")
    op.drop_table("user_saved_events")
