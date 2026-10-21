"""plannable overview items and schedule session color mode

Revision ID: op8c9d0e1f2a
Revises: ov7a8b9c0d1e
Create Date: 2026-10-21
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "op8c9d0e1f2a"
down_revision: Union[str, None] = "ov7a8b9c0d1e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "schedule_overview_items",
        sa.Column(
            "allow_plan", sa.Boolean(), nullable=False, server_default=sa.false()
        ),
    )
    op.add_column(
        "event_schedules",
        sa.Column(
            "session_color_mode",
            sa.String(length=24),
            nullable=False,
            server_default="room",
        ),
    )
    op.create_check_constraint(
        "ck_event_schedules_session_color_mode",
        "event_schedules",
        "session_color_mode IN ('room', 'activity_type', 'activity_type_stripe')",
    )
    op.alter_column(
        "user_plan_sessions", "session_id", existing_type=sa.Uuid(), nullable=True
    )
    op.add_column(
        "user_plan_sessions",
        sa.Column("overview_item_id", sa.Uuid(), nullable=True),
    )
    op.create_index(
        "ix_user_plan_sessions_overview_item_id",
        "user_plan_sessions",
        ["overview_item_id"],
    )
    op.create_unique_constraint(
        "uq_user_plan_overview_item",
        "user_plan_sessions",
        ["user_id", "overview_item_id"],
    )
    op.create_check_constraint(
        "ck_user_plan_sessions_one_target",
        "user_plan_sessions",
        "(session_id IS NULL) <> (overview_item_id IS NULL)",
    )


def downgrade() -> None:
    op.execute("DELETE FROM user_plan_sessions WHERE session_id IS NULL")
    op.drop_constraint(
        "ck_user_plan_sessions_one_target", "user_plan_sessions", type_="check"
    )
    op.drop_constraint(
        "uq_user_plan_overview_item", "user_plan_sessions", type_="unique"
    )
    op.drop_index(
        "ix_user_plan_sessions_overview_item_id", table_name="user_plan_sessions"
    )
    op.drop_column("user_plan_sessions", "overview_item_id")
    op.alter_column(
        "user_plan_sessions", "session_id", existing_type=sa.Uuid(), nullable=False
    )
    op.drop_constraint(
        "ck_event_schedules_session_color_mode", "event_schedules", type_="check"
    )
    op.drop_column("event_schedules", "session_color_mode")
    op.drop_column("schedule_overview_items", "allow_plan")
