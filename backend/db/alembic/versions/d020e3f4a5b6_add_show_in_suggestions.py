"""add show_in_suggestions

Revision ID: d020e3f4a5b6
Revises: c020d3e4f5a6
Create Date: 2026-05-27
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "d020e3f4a5b6"
down_revision: Union[str, None] = "c020d3e4f5a6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "show_in_suggestions",
            sa.Boolean(),
            nullable=False,
            server_default=sa.true(),
        ),
    )


def downgrade() -> None:
    op.drop_column("users", "show_in_suggestions")
