"""admin force-install-prompt override

Revision ID: u8v9w0x1y2z3
Revises: o2p3q4r5s6t7
Create Date: 2026-06-01

``users.force_install_prompt`` — admin-only override. When True, the
frontend InstallPrompt banner bypasses its 14-day local dismiss snooze
for this user, letting support re-surface the "Install app" banner for
someone who dismissed it and hasn't installed the PWA yet.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "u8v9w0x1y2z3"
down_revision: Union[str, None] = "o2p3q4r5s6t7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "force_install_prompt",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )


def downgrade() -> None:
    op.drop_column("users", "force_install_prompt")
