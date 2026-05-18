"""add audience columns for 3-tier visibility

Revision ID: ee50f6a7b8c9
Revises: dd40e5f6a7b8
Create Date: 2026-05-13

Migrates the privacy model from boolean ``share_publicly`` /
``share_attendance_default`` to 3-tier audience columns
(``public`` | ``friends`` | ``private``):

- ``user_event_attendances.share_audience`` — per-RSVP audience.
  Backfilled from ``share_publicly`` (true → ``public``,
  false → ``private``).
- ``user_saved_events.audience`` — per-saved-event audience.
  Backfilled from the saver's current ``users.visibility_saved``.
- ``users.share_attendance_default_audience`` — default for new RSVPs.
  Backfilled from ``users.share_attendance_default``
  (true → ``public``, false → ``private``).

The legacy boolean columns are kept for one release so older clients
continue to work; a follow-up cleanup migration will drop them.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "ee50f6a7b8c9"
down_revision: Union[str, None] = "dd40e5f6a7b8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. user_event_attendances.share_audience
    op.add_column(
        "user_event_attendances",
        sa.Column(
            "share_audience",
            sa.String(length=16),
            nullable=False,
            server_default="private",
        ),
    )
    op.execute(
        """
        UPDATE user_event_attendances
        SET share_audience = CASE WHEN share_publicly THEN 'public' ELSE 'private' END
        """
    )

    # 2. user_saved_events.audience — backfill from saver's visibility_saved
    op.add_column(
        "user_saved_events",
        sa.Column(
            "audience",
            sa.String(length=16),
            nullable=False,
            server_default="friends",
        ),
    )
    op.execute(
        """
        UPDATE user_saved_events AS s
        SET audience = COALESCE(u.visibility_saved, 'friends')
        FROM users AS u
        WHERE s.user_id = u.id
        """
    )

    # 3. users.share_attendance_default_audience
    op.add_column(
        "users",
        sa.Column(
            "share_attendance_default_audience",
            sa.String(length=16),
            nullable=False,
            server_default="public",
        ),
    )
    op.execute(
        """
        UPDATE users
        SET share_attendance_default_audience =
            CASE WHEN share_attendance_default THEN 'public' ELSE 'private' END
        """
    )

    # 4. event_suggestions.auto_save — when True (the default for new
    #    submissions), the suggestion will auto-create a UserSavedEvent
    #    for the submitter on approval, so suggested events naturally
    #    appear on the submitter's calendar tab without a second action.
    op.add_column(
        "event_suggestions",
        sa.Column(
            "auto_save",
            sa.Boolean(),
            nullable=False,
            server_default=sa.true(),
        ),
    )


def downgrade() -> None:
    op.drop_column("event_suggestions", "auto_save")
    op.drop_column("users", "share_attendance_default_audience")
    op.drop_column("user_saved_events", "audience")
    op.drop_column("user_event_attendances", "share_audience")
