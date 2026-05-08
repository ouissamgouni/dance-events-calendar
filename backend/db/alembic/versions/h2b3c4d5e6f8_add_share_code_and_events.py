"""add_share_code_and_events

Revision ID: h2b3c4d5e6f8
Revises: g1a2b3c4d5e7
Create Date: 2026-05-08

Adds two pieces of social-attribution plumbing:

1. ``users.share_code`` — a short, opaque, base32 identifier appended to
   shared event URLs (``?ref=share&src={code}``). Distinct from
   ``handle`` because it is non-rotatable and used for analytics: a
   user can change their handle without breaking attribution on links
   they already shared. Nullable so existing rows can be backfilled
   lazily; new rows get a code from the application layer.

2. ``share_events`` table — append-only log of share/click/conversion
   events keyed by the originating user's share_code (or anonymous
   device id). Powers the simple referral funnel without joining
   against a heavy analytics warehouse.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "h2b3c4d5e6f8"
down_revision: Union[str, None] = "g1a2b3c4d5e7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("share_code", sa.String(length=12), nullable=True),
    )
    op.create_index(
        "ix_users_share_code",
        "users",
        ["share_code"],
        unique=True,
    )

    op.create_table(
        "share_events",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("event_id", sa.String, nullable=False, index=True),
        # 'share'      = the share button was activated
        # 'click'      = a referred visitor landed on the event page
        # 'conversion' = a referred visitor performed an attributable action
        #                (currently RSVP "going")
        sa.Column("action", sa.String(length=16), nullable=False),
        # Who initiated the share. Nullable so anonymous shares are still
        # logged (we lose attribution but keep the volume metric).
        sa.Column("share_code", sa.String(length=12), nullable=True, index=True),
        # Anonymous device that performed the click/conversion (the
        # *recipient* side of the funnel). Nullable for the share row.
        sa.Column("device_id", sa.String(length=64), nullable=True, index=True),
        sa.Column(
            "created_at",
            sa.DateTime,
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index(
        "ix_share_events_event_action",
        "share_events",
        ["event_id", "action"],
    )


def downgrade() -> None:
    op.drop_index("ix_share_events_event_action", table_name="share_events")
    op.drop_table("share_events")
    op.drop_index("ix_users_share_code", table_name="users")
    op.drop_column("users", "share_code")
