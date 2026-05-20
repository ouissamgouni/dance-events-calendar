"""add organizer_claims.kind column

Revision ID: db52c3d4e6f7
Revises: da41b2c3d4e5
Create Date: 2026-05-20

Splits the single ``OrganizerClaim`` shape into two kinds:

- ``badge``: account-level verified-organizer request (no events).
- ``events``: per-event organizer attribution (verified users only).

Backfill: every existing row becomes ``kind="badge"``. Historical
``badge``-shaped claims may carry event line items as informational
context; the decide handler still applies those decisions on demand
but new ``badge`` submissions cannot include events.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "db52c3d4e6f7"
down_revision: Union[str, None] = "8c2f3d4e5a01"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Add with server_default so the column is NOT NULL on existing rows,
    # then drop the default so the application layer is the source of truth.
    op.add_column(
        "organizer_claims",
        sa.Column(
            "kind",
            sa.String(length=16),
            nullable=False,
            server_default="badge",
        ),
    )
    op.alter_column("organizer_claims", "kind", server_default=None)
    op.create_index(
        "ix_organizer_claims_kind", "organizer_claims", ["kind"]
    )


def downgrade() -> None:
    op.drop_index("ix_organizer_claims_kind", table_name="organizer_claims")
    op.drop_column("organizer_claims", "kind")
