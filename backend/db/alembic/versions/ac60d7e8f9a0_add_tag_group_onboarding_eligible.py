"""add tag group onboarding eligibility

Revision ID: ac60d7e8f9a0
Revises: db52c3d4e6f7
Create Date: 2026-05-21

"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "ac60d7e8f9a0"
down_revision: Union[str, None] = "db52c3d4e6f7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "tag_groups",
        sa.Column(
            "onboarding_eligible",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )
    op.alter_column("tag_groups", "onboarding_eligible", server_default=None)


def downgrade() -> None:
    op.drop_column("tag_groups", "onboarding_eligible")
