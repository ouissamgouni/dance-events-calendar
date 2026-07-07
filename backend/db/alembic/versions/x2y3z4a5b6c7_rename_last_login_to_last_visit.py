"""rename users.last_login_at to last_visit_at + add last_visit_user_agent

Revision ID: x2y3z4a5b6c7
Revises: w0x1y2z3a4b5
Create Date: 2026-07-07

"Last login" is now tracked as "last visit" — bumped on Google login AND on
any subsequent session-cookie-authenticated request (throttled, see
``_LAST_SEEN_THROTTLE`` in ``backend/api/deps.py``), not just a fresh sign-in.

- ``users.last_login_at`` renamed to ``users.last_visit_at``.
- ``users.last_visit_user_agent`` — raw ``User-Agent`` header captured at
  that visit. Powers the browser/OS/device icons in the Admin Users tab.
  Nullable: existing rows have no value until the user's next visit.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "x2y3z4a5b6c7"
down_revision: Union[str, None] = "w0x1y2z3a4b5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column("users", "last_login_at", new_column_name="last_visit_at")
    op.add_column(
        "users",
        sa.Column("last_visit_user_agent", sa.String(length=400), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("users", "last_visit_user_agent")
    op.alter_column("users", "last_visit_at", new_column_name="last_login_at")
