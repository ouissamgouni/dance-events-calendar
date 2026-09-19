"""add event image url

Revision ID: fgc1a2b3c4d5
Revises: rch2b3c4d5e6
Create Date: 2026-08-24
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "fgc1a2b3c4d5"
down_revision: Union[str, None] = "rch2b3c4d5e6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("cached_events") as batch:
        batch.add_column(sa.Column("image_url", sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("cached_events") as batch:
        batch.drop_column("image_url")
