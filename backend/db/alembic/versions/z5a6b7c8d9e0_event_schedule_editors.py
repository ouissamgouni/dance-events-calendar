"""add event schedule editors

Revision ID: z5a6b7c8d9e0
Revises: y4z5a6b7c8d9
Create Date: 2026-09-25
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "z5a6b7c8d9e0"
down_revision: Union[str, None] = "y4z5a6b7c8d9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "event_schedule_editors",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("schedule_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("granted_by_user_id", sa.Uuid(), nullable=True),
        sa.Column("granted_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["schedule_id"], ["event_schedules.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["granted_by_user_id"], ["users.id"], ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("schedule_id", "user_id", name="uq_event_schedule_editor"),
    )
    op.create_index(
        "ix_event_schedule_editors_schedule_id",
        "event_schedule_editors",
        ["schedule_id"],
    )
    op.create_index(
        "ix_event_schedule_editors_user_id",
        "event_schedule_editors",
        ["user_id"],
    )
    op.create_index(
        "ix_event_schedule_editors_granted_by_user_id",
        "event_schedule_editors",
        ["granted_by_user_id"],
    )


def downgrade() -> None:
    op.drop_table("event_schedule_editors")
