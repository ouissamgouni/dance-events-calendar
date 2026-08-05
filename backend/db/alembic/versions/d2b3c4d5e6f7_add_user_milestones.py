"""add_user_milestones

Revision ID: d2b3c4d5e6f7
Revises: c1a2b3c4d5e6
Create Date: 2026-08-05

Creates the ``user_milestones`` table backing the Dance Passport achievement
catalog (Phase B). One row per (user, milestone_key); ``seen_at`` NULL means the
celebration toast has not yet been acknowledged.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "d2b3c4d5e6f7"
down_revision: Union[str, None] = "c1a2b3c4d5e6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "user_milestones",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("milestone_key", sa.String(length=48), nullable=False),
        sa.Column("unlocked_at", sa.DateTime(), nullable=False),
        sa.Column("seen_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.UniqueConstraint(
            "user_id", "milestone_key", name="uq_user_milestone_user_key"
        ),
    )
    op.create_index("ix_user_milestones_user_id", "user_milestones", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_user_milestones_user_id", table_name="user_milestones")
    op.drop_table("user_milestones")
