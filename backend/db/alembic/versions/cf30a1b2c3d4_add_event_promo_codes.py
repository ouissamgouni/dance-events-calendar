"""add event_promo_codes

Revision ID: cf30a1b2c3d4
Revises: be30c5d6e7f0
Create Date: 2026-05-19

User-submitted promo codes for events. Sign-in required; admin-moderated.
Fields: code, description, source_url, expires_at, submitter_user_id.
Status enum: pending | approved | rejected.

Indexes:
- (event_id, status, expires_at) — powers the cheap "active codes" lookup
  used by the public listing endpoint and the event serializer
  ``has_active_promo_codes`` flag.
- Partial unique on (event_id, lower(code)) WHERE status != 'rejected'
  prevents two live/pending codes with the same text on the same event
  while still allowing re-submission after a rejection.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "cf30a1b2c3d4"
down_revision: Union[str, None] = "be30c5d6e7f0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "event_promo_codes",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("event_id", sa.String(), nullable=False),
        sa.Column("code", sa.String(length=64), nullable=False),
        sa.Column("description", sa.String(length=200), nullable=True),
        sa.Column("source_url", sa.String(length=500), nullable=True),
        sa.Column("expires_at", sa.DateTime(), nullable=True),
        sa.Column("submitter_user_id", sa.Uuid(), nullable=False),
        sa.Column(
            "status",
            sa.String(length=16),
            nullable=False,
            server_default="pending",
        ),
        sa.Column("admin_notes", sa.Text(), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(), nullable=True),
        sa.Column("reviewed_by", sa.String(length=255), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.ForeignKeyConstraint(
            ["event_id"], ["cached_events.event_id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["submitter_user_id"], ["users.id"], ondelete="CASCADE"
        ),
    )
    op.create_index(
        "ix_event_promo_codes_event_id",
        "event_promo_codes",
        ["event_id"],
    )
    op.create_index(
        "ix_event_promo_codes_submitter_user_id",
        "event_promo_codes",
        ["submitter_user_id"],
    )
    op.create_index(
        "ix_event_promo_codes_active_lookup",
        "event_promo_codes",
        ["event_id", "status", "expires_at"],
    )
    op.execute(
        "CREATE UNIQUE INDEX uq_event_promo_codes_event_code_active "
        "ON event_promo_codes (event_id, lower(code)) "
        "WHERE status != 'rejected'"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_event_promo_codes_event_code_active")
    op.drop_index("ix_event_promo_codes_active_lookup", table_name="event_promo_codes")
    op.drop_index(
        "ix_event_promo_codes_submitter_user_id", table_name="event_promo_codes"
    )
    op.drop_index("ix_event_promo_codes_event_id", table_name="event_promo_codes")
    op.drop_table("event_promo_codes")
