"""simplify visibility model

Revision ID: ff60a7b8c9d0
Revises: ee50f6a7b8c9
Create Date: 2026-05-13

Collapses the per-scope visibility model down to a single
``account_visibility`` (Instagram-style account gate, ``public`` |
``friends``). Drops the per-scope ``visibility_attendance`` and
``visibility_saved`` columns and renames ``visibility_calendar`` →
``account_visibility``. Coerces any legacy ``private`` value on that
column to ``friends`` (per the simplified model, only ``public`` and
``friends`` remain).

Also flips defaults to public:
- ``users.account_visibility`` default ``public``
- ``users.share_attendance_default_audience`` default ``public``
- ``user_event_attendances.share_audience`` default ``public``
- ``user_saved_events.audience`` default ``public``

Per-event audience values (``share_audience`` / ``audience``) are NOT
backfilled — users keep the values they set; the AND-rule narrowing
from the dropped fields is intentionally released (release notes).
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "ff60a7b8c9d0"
down_revision: Union[str, None] = "ee50f6a7b8c9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. Rename visibility_calendar → account_visibility and coerce 'private' → 'friends'.
    op.alter_column(
        "users",
        "visibility_calendar",
        new_column_name="account_visibility",
    )
    op.execute(
        "UPDATE users SET account_visibility = 'friends' WHERE account_visibility = 'private'"
    )
    # 2. Flip default on the renamed column.
    op.alter_column(
        "users",
        "account_visibility",
        server_default="public",
    )
    # 3. Drop the per-scope columns we no longer use.
    op.drop_column("users", "visibility_attendance")
    op.drop_column("users", "visibility_saved")
    # 4. Flip defaults to public for new rows.
    op.alter_column(
        "users",
        "share_attendance_default_audience",
        server_default="public",
    )
    op.alter_column(
        "user_event_attendances",
        "share_audience",
        server_default="public",
    )
    op.alter_column(
        "user_saved_events",
        "audience",
        server_default="public",
    )


def downgrade() -> None:
    op.alter_column(
        "user_saved_events",
        "audience",
        server_default="friends",
    )
    op.alter_column(
        "user_event_attendances",
        "share_audience",
        server_default="private",
    )
    op.alter_column(
        "users",
        "share_attendance_default_audience",
        server_default="public",
    )
    op.add_column(
        "users",
        sa.Column(
            "visibility_saved",
            sa.String(length=16),
            nullable=False,
            server_default="friends",
        ),
    )
    op.add_column(
        "users",
        sa.Column(
            "visibility_attendance",
            sa.String(length=16),
            nullable=False,
            server_default="friends",
        ),
    )
    op.alter_column(
        "users",
        "account_visibility",
        server_default="friends",
    )
    op.alter_column(
        "users",
        "account_visibility",
        new_column_name="visibility_calendar",
    )
