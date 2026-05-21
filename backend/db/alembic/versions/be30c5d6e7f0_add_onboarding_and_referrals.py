"""add onboarding marker and user referrals

Revision ID: be30c5d6e7f0
Revises: bc20d4e5f6a8
Create Date: 2026-05-18

Phase E batch 2:

- ``users.onboarded_at`` (E3): nullable timestamp marking when the
  user completed (or skipped) the post-signup onboarding flow.
  ``NULL`` means the frontend should redirect to ``/onboarding/follow``
  on the next signed-in navigation. Existing rows are left ``NULL``
  and will be stamped on their next sign-in via the same redirect path.

- ``user_referrals`` (E7): tracks invite codes that an existing user
  shares with friends. Redeeming a code at signup auto-creates a
  mutual follow between inviter and new user (with explicit consent
  on the signup screen). Codes are short, opaque, and
  case-insensitive. ``used_count`` lets us cap viral abuse later.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "be30c5d6e7f0"
down_revision: Union[str, None] = "bc20d4e5f6a8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("onboarded_at", sa.DateTime(), nullable=True),
    )

    op.create_table(
        "user_referrals",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("inviter_user_id", sa.Uuid(), nullable=False),
        sa.Column("code", sa.String(length=24), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "used_count",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
        sa.ForeignKeyConstraint(["inviter_user_id"], ["users.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("code", name="uq_user_referrals_code"),
        sa.UniqueConstraint("inviter_user_id", name="uq_user_referrals_inviter"),
    )
    op.create_index(
        "ix_user_referrals_inviter_user_id",
        "user_referrals",
        ["inviter_user_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_user_referrals_inviter_user_id", table_name="user_referrals")
    op.drop_table("user_referrals")
    op.drop_column("users", "onboarded_at")
