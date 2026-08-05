"""add_passport_share_tokens

Revision ID: f4d5e6a7b8c9
Revises: e3c4d5e6f7a8
Create Date: 2026-08-06

Creates the ``passport_share_tokens`` table backing the opt-in shareable Dance
Passport summary card (Phase F). One row per user; the token resolves to a
public, read-only summary (stats + unlocked badges only). Kept separate from
``share_tokens`` so a passport link can never expose the owner's saved/going
calendar feed.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "f4d5e6a7b8c9"
down_revision: Union[str, None] = "e3c4d5e6f7a8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "passport_share_tokens",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("token", sa.String(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
    )
    op.create_index(
        "ix_passport_share_tokens_token",
        "passport_share_tokens",
        ["token"],
        unique=True,
    )
    op.create_index(
        "ix_passport_share_tokens_user_id",
        "passport_share_tokens",
        ["user_id"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_passport_share_tokens_user_id", table_name="passport_share_tokens"
    )
    op.drop_index("ix_passport_share_tokens_token", table_name="passport_share_tokens")
    op.drop_table("passport_share_tokens")
