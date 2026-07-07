"""track PWA install per user

Revision ID: v9w0x1y2z3a4
Revises: u8v9w0x1y2z3
Create Date: 2026-07-07

``users.installed_at`` — nullable timestamp set the first time we observe
the account running as an installed PWA (native install prompt accepted,
or already-installed detected on a later load). Powers the "Installed app"
column in the Admin Users tab. Never cleared — uninstall isn't detectable
from the web app.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "v9w0x1y2z3a4"
down_revision: Union[str, None] = "u8v9w0x1y2z3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("installed_at", sa.DateTime(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("users", "installed_at")
