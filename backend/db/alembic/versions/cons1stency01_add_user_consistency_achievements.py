"""add_user_consistency_achievements

Revision ID: cons1stency01
Revises: l0m1n2o3p4q5
Create Date: 2026-08-09

Backs the recurring Dance Passport consistency achievements (Consistent /
Committed / Year-Rounder / Unstoppable / Dance Lifestyle). Unlike the one-time
``user_milestones`` catalog, these RECUR: one row per (user, level, period),
where ``period_start`` (``"YYYY-MM"``) identifies the rolling-activity period.
The display is recomputed from attended events on every read; these rows only
dedupe the celebration toast and the upward-reach notification.

Also retires the old consecutive-month "streak" milestones the consistency
system replaces: their orphaned ``user_milestones`` rows and
``milestone_unlocked`` notifications are removed so they stop surfacing.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "cons1stency01"
down_revision: Union[str, None] = "l0m1n2o3p4q5"
branch_labels = None
depends_on = None


_STREAK_KEYS = (
    "streak_3_months",
    "streak_6_months",
    "streak_12_months",
    "streak_18_months",
    "streak_24_months",
)


def upgrade() -> None:
    op.create_table(
        "user_consistency_achievements",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("level_key", sa.String(length=32), nullable=False),
        sa.Column("period_start", sa.String(length=7), nullable=False),
        sa.Column("reached_at", sa.DateTime(), nullable=False),
        sa.Column("seen_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.UniqueConstraint(
            "user_id",
            "level_key",
            "period_start",
            name="uq_user_consistency_user_level_period",
        ),
    )
    op.create_index(
        "ix_user_consistency_achievements_user_id",
        "user_consistency_achievements",
        ["user_id"],
    )

    # Retire the replaced consecutive-month streak milestones.
    bind = op.get_bind()
    keys = list(_STREAK_KEYS)
    bind.execute(
        sa.text(
            "DELETE FROM notifications WHERE kind = 'milestone_unlocked' "
            "AND subject_key IN :keys"
        ).bindparams(sa.bindparam("keys", expanding=True)),
        {"keys": keys},
    )
    bind.execute(
        sa.text(
            "DELETE FROM user_milestones WHERE milestone_key IN :keys"
        ).bindparams(sa.bindparam("keys", expanding=True)),
        {"keys": keys},
    )


def downgrade() -> None:
    op.drop_index(
        "ix_user_consistency_achievements_user_id",
        table_name="user_consistency_achievements",
    )
    op.drop_table("user_consistency_achievements")
