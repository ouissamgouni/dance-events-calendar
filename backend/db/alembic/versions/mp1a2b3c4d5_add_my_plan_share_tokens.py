"""add my plan share tokens

Revision ID: mp1a2b3c4d5
Revises: z6a7b8c9d0e1
Create Date: 2026-09-27
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "mp1a2b3c4d5"
down_revision: Union[str, None] = "z6a7b8c9d0e1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "my_plan_share_tokens",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("token", sa.String(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("event_id", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["event_id"], ["cached_events.event_id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "event_id", name="uq_my_plan_share_user_event"),
    )
    op.create_index(
        "ix_my_plan_share_tokens_token",
        "my_plan_share_tokens",
        ["token"],
        unique=True,
    )
    op.create_index(
        "ix_my_plan_share_tokens_user_id",
        "my_plan_share_tokens",
        ["user_id"],
    )
    op.create_index(
        "ix_my_plan_share_tokens_event_id",
        "my_plan_share_tokens",
        ["event_id"],
    )


def downgrade() -> None:
    op.drop_table("my_plan_share_tokens")
