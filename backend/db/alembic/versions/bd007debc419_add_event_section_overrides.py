"""add_event_section_overrides

Revision ID: bd007debc419
Revises: h4i5j6k7l8m9
Create Date: 2026-07-21

Adds per-event overrides for the ``show_prices`` and ``promo_codes_enabled``
global site settings:
- ``cached_events.show_price_override`` — nullable boolean. ``NULL`` means
  "inherit the global ``show_prices`` flag"; ``true``/``false`` force the
  price section on/off for this event only.
- ``cached_events.show_promo_override`` — same tri-state semantics for the
  promo-codes section, and also unlocks/locks the
  ``/api/events/{event_id}/promo-codes`` endpoints for that event
  regardless of the global ``promo_codes_enabled`` setting.
"""

from alembic import op
import sqlalchemy as sa

revision = "bd007debc419"
down_revision = "h4i5j6k7l8m9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "cached_events",
        sa.Column("show_price_override", sa.Boolean(), nullable=True),
    )
    op.add_column(
        "cached_events",
        sa.Column("show_promo_override", sa.Boolean(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("cached_events", "show_promo_override")
    op.drop_column("cached_events", "show_price_override")
