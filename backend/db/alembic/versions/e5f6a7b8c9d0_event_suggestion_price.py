"""event_suggestion_price

Revision ID: e5f6a7b8c9d0
Revises: d4e5f6a7b8c9
Create Date: 2026-05-06

Adds optional price-range fields to ``event_suggestions`` so submitters
can hint pricing when proposing an event. On approval these are copied
to the resulting ``cached_events`` row.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "e5f6a7b8c9d0"
down_revision: Union[str, None] = "d4e5f6a7b8c9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "event_suggestions", sa.Column("price_min", sa.Float(), nullable=True)
    )
    op.add_column(
        "event_suggestions", sa.Column("price_max", sa.Float(), nullable=True)
    )
    op.add_column(
        "event_suggestions", sa.Column("price_currency", sa.String(), nullable=True)
    )
    op.add_column(
        "event_suggestions",
        sa.Column(
            "price_is_free", sa.Boolean(), nullable=False, server_default=sa.false()
        ),
    )


def downgrade() -> None:
    op.drop_column("event_suggestions", "price_is_free")
    op.drop_column("event_suggestions", "price_currency")
    op.drop_column("event_suggestions", "price_max")
    op.drop_column("event_suggestions", "price_min")
