"""add_attendance_visibility

Revision ID: z1a2b3c4d5e6
Revises: y1z2a3b4c5d6
Create Date: 2026-05-05

Adds privacy controls for the "I'm going" feature:
- ``user_event_attendances.share_publicly`` — per-event opt-in for being
  named on the public attendee list. Existing rows backfill to ``false``
  so historical attendees stay private until they explicitly opt in.
- ``users.share_attendance_default`` — pre-fills the share toggle in the
  GoingButton popover. Defaults to ``false`` (privacy-first).
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "z1a2b3c4d5e6"
down_revision: Union[str, None] = "y1z2a3b4c5d6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "user_event_attendances",
        sa.Column(
            "share_publicly",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.add_column(
        "users",
        sa.Column(
            "share_attendance_default",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )


def downgrade() -> None:
    op.drop_column("users", "share_attendance_default")
    op.drop_column("user_event_attendances", "share_publicly")
