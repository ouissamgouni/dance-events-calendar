"""add_geocode_metadata

Revision ID: v1w2x3y4z5a6
Revises: u1v2w3x4y5z6
Create Date: 2026-05-02

Adds two nullable columns to cached_events:
  - geocode_query    : the candidate string that successfully geocoded
  - geocode_provider : which provider resolved it (google | nominatim | cache)
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "v1w2x3y4z5a6"
down_revision: Union[str, None] = "u1v2w3x4y5z6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "cached_events",
        sa.Column("geocode_query", sa.Text(), nullable=True),
    )
    op.add_column(
        "cached_events",
        sa.Column("geocode_provider", sa.String(length=32), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("cached_events", "geocode_provider")
    op.drop_column("cached_events", "geocode_query")
