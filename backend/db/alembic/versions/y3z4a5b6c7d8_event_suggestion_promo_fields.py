"""event_suggestion_promo_fields

Revision ID: y3z4a5b6c7d8
Revises: x2y3z4a5b6c7
Create Date: 2026-07-18

Adds optional promo metadata columns to ``event_suggestions`` so
submitters can include promo details during event creation.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "y3z4a5b6c7d8"
down_revision: Union[str, None] = "x2y3z4a5b6c7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "event_suggestions",
        sa.Column("promo_code", sa.String(length=64), nullable=True),
    )
    op.add_column(
        "event_suggestions",
        sa.Column("promo_description", sa.Text(), nullable=True),
    )
    op.add_column(
        "event_suggestions",
        sa.Column("promo_source_url", sa.String(length=500), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("event_suggestions", "promo_source_url")
    op.drop_column("event_suggestions", "promo_description")
    op.drop_column("event_suggestions", "promo_code")
