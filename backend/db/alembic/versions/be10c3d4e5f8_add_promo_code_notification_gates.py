"""add_promo_code_notification_gates

Revision ID: be10c3d4e5f8
Revises: bd007debc419
Create Date: 2026-07-21

Adds a new standalone "Promo codes" notification feature bucket:
- ``users.email_promo_codes_enabled``
- ``users.push_promo_codes_enabled``

Gates delivery of the new ``promo_code_added`` in-app notification (fired
when an admin approves a promo code on an event the recipient has saved).
In-app rows always land regardless of these flags, same convention as the
existing six event_reminders/social_activity/interest_matches gates.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "be10c3d4e5f8"
down_revision: Union[str, None] = "bd007debc419"
branch_labels = None
depends_on = None

NEW_COLS = (
    "email_promo_codes_enabled",
    "push_promo_codes_enabled",
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
