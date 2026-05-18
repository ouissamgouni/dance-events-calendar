"""switch per-event sharing defaults to friends

Revision ID: bc20d4e5f6a8
Revises: ab10c3d4e5f7
Create Date: 2026-05-14

Privacy-by-default per GDPR Art. 25: flips the column server defaults
for per-event sharing audiences from ``public`` to ``friends`` so newly
created users / RSVPs / saves fail closed (mutual-followers only) until
the user opts up to ``public`` via the AudiencePicker.

Existing rows are NOT backfilled — users keep whatever audience they
explicitly chose. Only fresh INSERTs that omit the audience column
inherit the new default.
"""

from typing import Union

from alembic import op


revision: str = "bc20d4e5f6a8"
down_revision: Union[str, None] = "ab10c3d4e5f7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column(
        "users",
        "share_attendance_default_audience",
        server_default="friends",
    )
    op.alter_column(
        "user_saved_events",
        "audience",
        server_default="friends",
    )


def downgrade() -> None:
    op.alter_column(
        "user_saved_events",
        "audience",
        server_default="public",
    )
    op.alter_column(
        "users",
        "share_attendance_default_audience",
        server_default="public",
    )
