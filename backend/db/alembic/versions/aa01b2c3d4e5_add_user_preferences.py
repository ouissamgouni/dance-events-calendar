"""add_user_preferences

Revision ID: aa01b2c3d4e5
Revises: i2j3k4l5m6n7
Create Date: 2026-05-12

Adds the per-user "preferences" feature: preferred map area (bounding box)
and preferred dance-style tags. Tags live in a separate join table mirroring
the ``event_tags`` pattern, with ``ON DELETE CASCADE`` so removing a user or
tag tidies the join rows automatically.

``preferences_set_at`` is the gate that distinguishes "never touched" from
"explicitly empty" (used by the anon→authed merge to decide whether to apply
localStorage prefs without overwriting existing server-side prefs).
"""

from typing import Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "aa01b2c3d4e5"
down_revision: Union[str, None] = "i2j3k4l5m6n7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("preferred_area_min_lat", sa.Float(), nullable=True),
    )
    op.add_column(
        "users",
        sa.Column("preferred_area_min_lng", sa.Float(), nullable=True),
    )
    op.add_column(
        "users",
        sa.Column("preferred_area_max_lat", sa.Float(), nullable=True),
    )
    op.add_column(
        "users",
        sa.Column("preferred_area_max_lng", sa.Float(), nullable=True),
    )
    op.add_column(
        "users",
        sa.Column("preferred_area_label", sa.String(length=120), nullable=True),
    )
    op.add_column(
        "users",
        sa.Column("preferences_set_at", sa.DateTime(), nullable=True),
    )

    op.create_table(
        "user_preferred_tags",
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("tag_id", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["tag_id"], ["tags.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id", "tag_id"),
    )


def downgrade() -> None:
    op.drop_table("user_preferred_tags")
    op.drop_column("users", "preferences_set_at")
    op.drop_column("users", "preferred_area_label")
    op.drop_column("users", "preferred_area_max_lng")
    op.drop_column("users", "preferred_area_max_lat")
    op.drop_column("users", "preferred_area_min_lng")
    op.drop_column("users", "preferred_area_min_lat")
