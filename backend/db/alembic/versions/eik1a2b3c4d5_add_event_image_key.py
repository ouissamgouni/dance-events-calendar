"""add event image_key for admin-managed pictures

Revision ID: eik1a2b3c4d5
Revises: pz1a2b3c4d5e
Create Date: 2026-09-16
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "eik1a2b3c4d5"
down_revision: Union[str, None] = "pz1a2b3c4d5e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("cached_events") as batch:
        batch.add_column(sa.Column("image_key", sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("cached_events") as batch:
        batch.drop_column("image_key")
