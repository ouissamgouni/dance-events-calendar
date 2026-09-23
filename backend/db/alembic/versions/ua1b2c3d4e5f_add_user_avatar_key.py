"""add managed user avatar key

Revision ID: ua1b2c3d4e5f
Revises: o4p5q6r7s8t9
Create Date: 2026-09-23
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "ua1b2c3d4e5f"
down_revision: Union[str, None] = "o4p5q6r7s8t9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("users") as batch:
        batch.add_column(sa.Column("avatar_key", sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("users") as batch:
        batch.drop_column("avatar_key")
