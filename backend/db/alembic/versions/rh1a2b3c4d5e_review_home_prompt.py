"""home review prompt impressions, forces and rating entry point

Revision ID: rh1a2b3c4d5e
Revises: sl1a2b3c4d5e
Create Date: 2026-10-18
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "rh1a2b3c4d5e"
down_revision: Union[str, None] = "sl1a2b3c4d5e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "event_ratings", sa.Column("entry_point", sa.String(length=32), nullable=True)
    )
    op.create_table(
        "review_prompt_impressions",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("event_id", sa.String(), nullable=False),
        sa.Column("shown_at", sa.DateTime(), nullable=False),
        sa.Column("outcome", sa.String(length=16), nullable=False),
        sa.Column("forced", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["event_id"], ["cached_events.event_id"]),
    )
    op.create_index(
        "ix_review_prompt_impressions_user_id", "review_prompt_impressions", ["user_id"]
    )
    op.create_index(
        "ix_review_prompt_impressions_event_id",
        "review_prompt_impressions",
        ["event_id"],
    )
    op.create_index(
        "ix_review_prompt_impressions_shown_at",
        "review_prompt_impressions",
        ["shown_at"],
    )
    op.create_table(
        "review_prompt_forces",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("event_id", sa.String(), nullable=False),
        sa.Column("forced_by", sa.String(length=255), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["event_id"], ["cached_events.event_id"]),
        sa.UniqueConstraint(
            "user_id", "event_id", name="uq_review_prompt_force_user_event"
        ),
    )
    op.create_index(
        "ix_review_prompt_forces_user_id", "review_prompt_forces", ["user_id"]
    )
    op.create_index(
        "ix_review_prompt_forces_event_id", "review_prompt_forces", ["event_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_review_prompt_forces_event_id", table_name="review_prompt_forces")
    op.drop_index("ix_review_prompt_forces_user_id", table_name="review_prompt_forces")
    op.drop_table("review_prompt_forces")
    op.drop_index(
        "ix_review_prompt_impressions_shown_at", table_name="review_prompt_impressions"
    )
    op.drop_index(
        "ix_review_prompt_impressions_event_id", table_name="review_prompt_impressions"
    )
    op.drop_index(
        "ix_review_prompt_impressions_user_id", table_name="review_prompt_impressions"
    )
    op.drop_table("review_prompt_impressions")
    op.drop_column("event_ratings", "entry_point")
