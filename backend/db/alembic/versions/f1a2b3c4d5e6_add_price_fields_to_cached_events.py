"""add_price_fields_to_cached_events

Revision ID: f1a2b3c4d5e6
Revises: cd8fd57f95ff
Create Date: 2026-04-15 12:00:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "f1a2b3c4d5e6"
down_revision: Union[str, None] = "cd8fd57f95ff"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("cached_events", sa.Column("price_min", sa.Float(), nullable=True))
    op.add_column("cached_events", sa.Column("price_max", sa.Float(), nullable=True))
    op.add_column(
        "cached_events", sa.Column("price_currency", sa.String(), nullable=True)
    )
    op.add_column(
        "cached_events",
        sa.Column("price_is_free", sa.Boolean(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_column("cached_events", "price_is_free")
    op.drop_column("cached_events", "price_currency")
    op.drop_column("cached_events", "price_max")
    op.drop_column("cached_events", "price_min")
