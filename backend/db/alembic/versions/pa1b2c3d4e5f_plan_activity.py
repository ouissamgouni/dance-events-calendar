"""add plan activity audience and delivery preferences

Revision ID: pa1b2c3d4e5f
Revises: mp1a2b3c4d5
Create Date: 2026-09-28
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "pa1b2c3d4e5f"
down_revision: Union[str, None] = "mp1a2b3c4d5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "email_plan_activity_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.add_column(
        "users",
        sa.Column(
            "push_plan_activity_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.true(),
        ),
    )
    op.create_table(
        "user_plan_audiences",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("event_id", sa.String(), nullable=False),
        sa.Column("audience", sa.String(length=16), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint(
            "audience IN ('followers', 'friends', 'private')",
            name="ck_user_plan_audience_value",
        ),
        sa.ForeignKeyConstraint(["event_id"], ["cached_events.event_id"]),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "event_id", name="uq_user_plan_audience"),
    )
    op.create_index(
        "ix_user_plan_audiences_user_id", "user_plan_audiences", ["user_id"]
    )
    op.create_index(
        "ix_user_plan_audiences_event_id", "user_plan_audiences", ["event_id"]
    )


def downgrade() -> None:
    op.drop_table("user_plan_audiences")
    op.drop_column("users", "push_plan_activity_enabled")
    op.drop_column("users", "email_plan_activity_enabled")
