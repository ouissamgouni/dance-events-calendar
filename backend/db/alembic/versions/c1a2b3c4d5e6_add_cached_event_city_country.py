"""add_cached_event_city_country

Revision ID: c1a2b3c4d5e6
Revises: e2f3a4b5c6d7
Create Date: 2026-08-05

Adds structured place columns (``city``, ``country``, ``country_code``) to
``cached_events`` for the Dance Passport feature. Populated by reverse-geocoding
lat/lng (see backend/services/geocoding.py) and scenario seeding.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "c1a2b3c4d5e6"
down_revision: Union[str, None] = "e2f3a4b5c6d7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("cached_events", sa.Column("city", sa.String(), nullable=True))
    op.add_column("cached_events", sa.Column("country", sa.String(), nullable=True))
    op.add_column(
        "cached_events",
        sa.Column("country_code", sa.String(length=2), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("cached_events", "country_code")
    op.drop_column("cached_events", "country")
    op.drop_column("cached_events", "city")
