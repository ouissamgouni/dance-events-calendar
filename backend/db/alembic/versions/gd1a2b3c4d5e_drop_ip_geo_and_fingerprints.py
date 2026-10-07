"""drop IP geolocation and browser-fingerprint columns (GDPR data minimisation)

Revision ID: gd1a2b3c4d5e
Revises: so1a2b3c4d5e
Create Date: 2026-10-06
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "gd1a2b3c4d5e"
down_revision: Union[str, None] = "so1a2b3c4d5e"
branch_labels = None
depends_on = None

# Downgrade restores the columns empty; the erased values are not recoverable by design.
_DROPPED = {
    "event_views": [("country", sa.String()), ("city", sa.String())],
    "event_link_clicks": [("country", sa.String()), ("city", sa.String())],
    "event_suggestions": [
        ("submitter_ip", sa.String()),
        ("submitter_user_agent", sa.String()),
        ("submitter_language", sa.String()),
        ("submitter_referrer", sa.String()),
        ("submitter_screen_size", sa.String()),
        ("submitter_city", sa.String()),
        ("submitter_country", sa.String()),
        ("submitter_lat", sa.Float()),
        ("submitter_lng", sa.Float()),
    ],
    "tag_suggestions": [("submitter_ip", sa.String())],
    "event_ratings": [
        ("submitter_ip", sa.String(length=64)),
        ("submitter_user_agent", sa.String(length=512)),
        ("submitter_country", sa.String(length=8)),
    ],
}


def upgrade() -> None:
    for table, columns in _DROPPED.items():
        with op.batch_alter_table(table) as batch:
            for name, _type in columns:
                batch.drop_column(name)


def downgrade() -> None:
    for table, columns in _DROPPED.items():
        with op.batch_alter_table(table) as batch:
            for name, type_ in columns:
                batch.add_column(sa.Column(name, type_, nullable=True))
