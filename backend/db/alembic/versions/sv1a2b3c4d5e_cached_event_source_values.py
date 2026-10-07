"""cached_events.source_values: revisable fields as last received from the source

Revision ID: sv1a2b3c4d5e
Revises: rv1a2b3c4d5e
Create Date: 2026-10-06
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "sv1a2b3c4d5e"
down_revision: Union[str, None] = "rv1a2b3c4d5e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("cached_events", sa.Column("source_values", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("cached_events", "source_values")
