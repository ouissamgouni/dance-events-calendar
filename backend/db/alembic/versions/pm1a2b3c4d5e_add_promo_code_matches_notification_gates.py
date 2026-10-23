"""add_promo_code_matches_notification_gates

Revision ID: pm1a2b3c4d5e
Revises: qv0e1f2a3b4c
Create Date: 2026-10-23

Adds the "Deals" notification feature bucket (``promo_code_match`` kind:
promo codes on events matching the user's interest profiles):
- ``users.email_promo_code_matches_enabled``
- ``users.push_promo_code_matches_enabled``
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "pm1a2b3c4d5e"
down_revision: Union[str, None] = "qv0e1f2a3b4c"
branch_labels = None
depends_on = None

NEW_COLS = (
    "email_promo_code_matches_enabled",
    "push_promo_code_matches_enabled",
)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = {c["name"] for c in inspector.get_columns("users")}

    for col in NEW_COLS:
        if col not in existing:
            op.add_column(
                "users",
                sa.Column(col, sa.Boolean(), nullable=False, server_default=sa.true()),
            )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = {c["name"] for c in inspector.get_columns("users")}

    for col in NEW_COLS:
        if col in existing:
            op.drop_column("users", col)
