"""admin force-enable-push-prompt override

Revision ID: w0x1y2z3a4b5
Revises: v9w0x1y2z3a4
Create Date: 2026-07-08

``users.force_enable_push_prompt`` — admin-only override. When True, the
frontend InstallPrompt "enable notifications" banner bypasses its 24h
local dismiss snooze for this user, letting support re-surface the push
opt-in for someone who dismissed it and hasn't enabled push yet.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "w0x1y2z3a4b5"
down_revision: Union[str, None] = "v9w0x1y2z3a4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "force_enable_push_prompt",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )


def downgrade() -> None:
    op.drop_column("users", "force_enable_push_prompt")
