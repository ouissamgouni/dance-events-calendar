"""add user_follows.status column for E8 friend-requests

Revision ID: ea50b6c7d8e9
Revises: da41b2c3d4e5
Create Date: 2026-05-19

Phase E (E8) — friend-requests for ``friends``-visibility accounts.

Adds a ``status`` column to ``user_follows`` that lets a follow edge
exist without granting visibility. Values:

- ``'approved'`` — full follow, visible in ``is_following`` /
  follower-lists / ``can_view`` reads. Existing rows are backfilled
  to this value so behaviour is unchanged for already-followed
  accounts.
- ``'pending'`` — request created against a ``friends``-visibility
  target awaiting approval. Read paths MUST filter it out.

The feature is gated server-side behind the ``FEATURE_FRIEND_REQUESTS``
env var; the column is added unconditionally so the migration is safe
to run with the flag off.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "ea50b6c7d8e9"
down_revision: Union[str, None] = "da41b2c3d4e5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "user_follows",
        sa.Column(
            "status",
            sa.String(length=16),
            nullable=False,
            server_default="approved",
        ),
    )
    op.create_index(
        "ix_user_follows_status",
        "user_follows",
        ["status"],
    )


def downgrade() -> None:
    op.drop_index("ix_user_follows_status", table_name="user_follows")
    op.drop_column("user_follows", "status")
