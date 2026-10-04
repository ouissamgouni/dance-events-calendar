"""add event_suggestions.image_key

Revision ID: si1a2b3c4d5e
Revises: st1a2b3c4d5e
Create Date: 2026-10-03
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "si1a2b3c4d5e"
down_revision: Union[str, None] = "st1a2b3c4d5e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    columns = {
        c["name"] for c in sa.inspect(op.get_bind()).get_columns("event_suggestions")
    }
    if "image_key" not in columns:
        op.add_column(
            "event_suggestions",
            sa.Column("image_key", sa.String(length=200), nullable=True),
        )


def downgrade() -> None:
    op.drop_column("event_suggestions", "image_key")
