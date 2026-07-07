"""Add show_events to calendar_settings

Revision ID: o2p3q4r5s6t7
Revises: m6n7o8p9q0r1
Create Date: 2026-07-07

Splits the single ``enabled`` toggle on ``calendar_settings`` into two
independent concerns:

- ``enabled`` (existing) — whether the background sync job fetches new
  events from this calendar.
- ``show_events`` (new) — whether already-cached events from this
  calendar appear in public-facing surfaces.

Previously, disabling a calendar (``enabled = false``) also hid its
already-synced events everywhere (``/api/events``, sitemap, shared
calendars, profile feeds, etc.) — a side effect that was never intended.
Backfilling ``show_events = true`` for all existing rows preserves the
originally-intended behavior: turning sync off does not hide events that
were already cached.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "o2p3q4r5s6t7"
down_revision: Union[str, None] = "m6n7o8p9q0r1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "calendar_settings",
        sa.Column(
            "show_events", sa.Boolean(), nullable=False, server_default=sa.text("true")
        ),
    )


def downgrade() -> None:
    op.drop_column("calendar_settings", "show_events")
