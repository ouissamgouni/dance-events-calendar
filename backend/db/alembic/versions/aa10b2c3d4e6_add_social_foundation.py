"""add_social_foundation

Revision ID: aa10b2c3d4e6
Revises: z1a2b3c4d5e6
Create Date: 2026-05-12

Phase A foundation for the v1 social/friends features:

- ``user_follows`` — asymmetric follow edges; "friends" = mutual follow,
  derived at query time via self-join.
- ``users.visibility_attendance / visibility_saved / visibility_calendar`` —
  per-scope visibility (``public`` | ``friends`` | ``private``). Defaults to
  ``friends`` for new accounts; ``visibility_attendance`` is backfilled from
  the existing ``share_attendance_default`` for legacy rows so the new
  privacy chokepoint matches each user's current effective behavior.
- ``users.is_verified_organizer`` — admin-granted credibility badge flag.
- ``users.instagram_url / facebook_url`` — optional, unverified, display-only
  social links surfaced on the public profile.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "aa10b2c3d4e6"
down_revision: Union[str, None] = "z1a2b3c4d5e6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "user_follows",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("follower_id", sa.Uuid(), nullable=False),
        sa.Column("followee_id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.ForeignKeyConstraint(["follower_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["followee_id"], ["users.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("follower_id", "followee_id", name="uq_user_follow_pair"),
        sa.CheckConstraint(
            "follower_id <> followee_id", name="ck_user_follow_not_self"
        ),
    )
    op.create_index("ix_user_follows_follower_id", "user_follows", ["follower_id"])
    op.create_index("ix_user_follows_followee_id", "user_follows", ["followee_id"])

    op.add_column(
        "users",
        sa.Column(
            "visibility_attendance",
            sa.String(length=16),
            nullable=False,
            server_default="friends",
        ),
    )
    op.add_column(
        "users",
        sa.Column(
            "visibility_saved",
            sa.String(length=16),
            nullable=False,
            server_default="friends",
        ),
    )
    op.add_column(
        "users",
        sa.Column(
            "visibility_calendar",
            sa.String(length=16),
            nullable=False,
            server_default="friends",
        ),
    )
    op.add_column(
        "users",
        sa.Column(
            "is_verified_organizer",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.add_column(
        "users",
        sa.Column("instagram_url", sa.String(length=255), nullable=True),
    )
    op.add_column(
        "users",
        sa.Column("facebook_url", sa.String(length=255), nullable=True),
    )

    # Backfill visibility_attendance from share_attendance_default so the new
    # privacy chokepoint mirrors each user's existing effective behavior:
    # users who already opted into public attendee listing become
    # visibility_attendance='public'; everyone else stays at the 'friends'
    # default.
    op.execute(
        "UPDATE users SET visibility_attendance = 'public' "
        "WHERE share_attendance_default = TRUE"
    )


def downgrade() -> None:
    op.drop_column("users", "facebook_url")
    op.drop_column("users", "instagram_url")
    op.drop_column("users", "is_verified_organizer")
    op.drop_column("users", "visibility_calendar")
    op.drop_column("users", "visibility_saved")
    op.drop_column("users", "visibility_attendance")
    op.drop_index("ix_user_follows_followee_id", table_name="user_follows")
    op.drop_index("ix_user_follows_follower_id", table_name="user_follows")
    op.drop_table("user_follows")
