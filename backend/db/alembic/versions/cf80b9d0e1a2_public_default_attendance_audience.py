"""public default for share_attendance_default_audience

Revision ID: cf80b9d0e1a2
Revises: mrg1a2b3c4d5
Create Date: 2026-08-22

Flips the per-event sharing default from ``friends`` to ``public`` so
attendee lists / the event Interest section are populated by default.

Existing rows are backfilled to ``public`` ONLY where the user never
explicitly set the preference (``share_attendance_default_set_by_user =
FALSE``); deliberate ``friends``/``private`` choices are preserved. The
default is disclosed and reversible at the point of action via the
post-RSVP AudiencePicker.
"""

from typing import Union

from alembic import op


revision: str = "cf80b9d0e1a2"
down_revision: Union[str, None] = "mrg1a2b3c4d5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column(
        "users",
        "share_attendance_default_audience",
        server_default="public",
    )
    op.execute(
        """
        UPDATE users
        SET share_attendance_default = TRUE,
            share_attendance_default_audience = 'public'
        WHERE share_attendance_default_set_by_user = FALSE
        """
    )


def downgrade() -> None:
    op.execute(
        """
        UPDATE users
        SET share_attendance_default = FALSE,
            share_attendance_default_audience = 'friends'
        WHERE share_attendance_default_set_by_user = FALSE
        """
    )
    op.alter_column(
        "users",
        "share_attendance_default_audience",
        server_default="friends",
    )
