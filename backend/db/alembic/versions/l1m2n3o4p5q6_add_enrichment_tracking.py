"""add enrichment tracking to sync_logs

Revision ID: l1m2n3o4p5q6
Revises: k1l2m3n4o5p6
Create Date: 2026-04-17 10:00:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "l1m2n3o4p5q6"
down_revision: Union[str, None] = "k1l2m3n4o5p6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "sync_logs",
        sa.Column(
            "enrichment_status", sa.String(), nullable=True, server_default="pending"
        ),
    )
    op.add_column(
        "sync_logs",
        sa.Column("enrichment_progress", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("sync_logs", "enrichment_progress")
    op.drop_column("sync_logs", "enrichment_status")
