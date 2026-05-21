"""add_user_bio

Revision ID: dd40e5f6a7b8
Revises: cc30d4e5f6a8
Create Date: 2026-05-13

Phase D: free-form short bio rendered on /u/{handle} About tab.
Plain text, max 280 chars (Twitter-like). Nullable so existing
accounts keep their current empty-state until they edit it.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "dd40e5f6a7b8"
down_revision: Union[str, None] = "cc30d4e5f6a8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("bio", sa.String(length=280), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("users", "bio")
