"""structured place fields from location autocomplete

Revision ID: pl1a2b3c4d5e
Revises: ca1a2b3c4d5e
Create Date: 2026-10-13
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "pl1a2b3c4d5e"
down_revision: Union[str, None] = "ca1a2b3c4d5e"
branch_labels = None
depends_on = None

_PLACE_COLUMNS = (
    ("venue_name", sa.String()),
    ("street_address", sa.String()),
    ("place_id", sa.String(length=255)),
    ("place_provider", sa.String(length=32)),
)
_SUGGESTION_ONLY = (
    ("city", sa.String()),
    ("country", sa.String()),
    ("country_code", sa.String(length=2)),
)


def upgrade() -> None:
    for name, type_ in _PLACE_COLUMNS:
        op.add_column("cached_events", sa.Column(name, type_, nullable=True))
    for name, type_ in _PLACE_COLUMNS + _SUGGESTION_ONLY:
        op.add_column("event_suggestions", sa.Column(name, type_, nullable=True))


def downgrade() -> None:
    for name, _ in _PLACE_COLUMNS + _SUGGESTION_ONLY:
        op.drop_column("event_suggestions", name)
    for name, _ in _PLACE_COLUMNS:
        op.drop_column("cached_events", name)
