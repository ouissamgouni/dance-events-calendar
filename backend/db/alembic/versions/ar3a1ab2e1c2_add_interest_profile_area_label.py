"""add interest profile area label

Revision ID: ar3a1ab2e1c2
Revises: cf80b9d0e1a2
Create Date: 2026-08-23
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "ar3a1ab2e1c2"
down_revision: Union[str, None] = "cf80b9d0e1a2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "user_interest_profiles",
        sa.Column("area_label", sa.String(length=120), nullable=True),
    )
    op.execute("UPDATE user_interest_profiles SET area_label = label")
    op.alter_column("user_interest_profiles", "area_label", nullable=False)


def downgrade() -> None:
    op.drop_column("user_interest_profiles", "area_label")
