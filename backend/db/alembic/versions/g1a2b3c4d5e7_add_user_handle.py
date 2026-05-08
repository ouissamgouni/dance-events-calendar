"""add_user_handle

Revision ID: g1a2b3c4d5e7
Revises: f6a7b8c9d0e1
Create Date: 2026-05-08

Adds a public ``handle`` column to ``users`` for /u/{handle} URLs and
future social features (follow graph, attribution display). Nullable so
existing accounts can keep using the app and claim a handle later from
the Account page.

Uniqueness is enforced case-insensitively via a functional unique index
on ``lower(handle)`` so a user cannot register both "Maria" and "maria".
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "g1a2b3c4d5e7"
down_revision: Union[str, None] = "f6a7b8c9d0e1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("handle", sa.String(length=24), nullable=True),
    )
    op.create_index(
        "ix_users_handle_lower",
        "users",
        [sa.text("lower(handle)")],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("ix_users_handle_lower", table_name="users")
    op.drop_column("users", "handle")
