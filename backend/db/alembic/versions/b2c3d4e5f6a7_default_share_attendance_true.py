"""default_share_attendance_true

Revision ID: b2c3d4e5f6a7
Revises: a2b3c4d5e6f7
Create Date: 2026-05-06

Flips the default of ``users.share_attendance_default`` from ``False``
(privacy-first) to ``True`` (visibility-first). Adds a companion flag
``share_attendance_default_set_by_user`` so subsequent default flips can
avoid overriding deliberate user choices.

Behaviour for existing rows: backfilled to ``True`` (the new default),
because before this migration we have no signal distinguishing "user
deliberately chose False" from "user never touched the toggle". Going
forward, every PATCH /auth/preferences sets the new flag to ``True``,
so future migrations can be more surgical.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "b2c3d4e5f6a7"
down_revision: Union[str, None] = "a2b3c4d5e6f7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "share_attendance_default_set_by_user",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    # Flip the default for new rows.
    op.alter_column(
        "users",
        "share_attendance_default",
        server_default=sa.true(),
    )
    # Backfill existing users to the new default.
    op.execute(
        "UPDATE users SET share_attendance_default = TRUE "
        "WHERE share_attendance_default_set_by_user = FALSE"
    )


def downgrade() -> None:
    op.alter_column(
        "users",
        "share_attendance_default",
        server_default=sa.false(),
    )
    op.drop_column("users", "share_attendance_default_set_by_user")
