"""add_passport_share_require_signin

Revision ID: h6f7a8b9c0d1
Revises: g5e6f7a8b9c0
Create Date: 2026-08-06

Dance Passport sharing Phase 3 — per-share "signed-in only" option. Adds
``require_signin`` (default False) to ``passport_share_tokens``; when set the
public ``/shared/{token}`` endpoint only resolves for an authenticated viewer.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "h6f7a8b9c0d1"
down_revision: Union[str, None] = "g5e6f7a8b9c0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = {c["name"] for c in inspector.get_columns("passport_share_tokens")}
    if "require_signin" not in existing:
        op.add_column(
            "passport_share_tokens",
            sa.Column(
                "require_signin",
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            ),
        )


def downgrade() -> None:
    op.drop_column("passport_share_tokens", "require_signin")
