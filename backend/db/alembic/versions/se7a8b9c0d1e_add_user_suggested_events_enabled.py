"""add_user_suggested_events_enabled

Revision ID: se7a8b9c0d1e
Revises: d1e2s3t4v5w6
Create Date: 2026-08-11

Handoff 4: split ``subscription_suggested`` out of the broader
``social_activity`` bucket into its own ``suggested_events`` feature with
independent per-channel gates ``users.email_suggested_events_enabled`` /
``users.push_suggested_events_enabled``. Both default on so existing users
keep receiving suggested-event-approval notifications.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "se7a8b9c0d1e"
down_revision: Union[str, None] = "d1e2s3t4v5w6"
branch_labels = None
depends_on = None

_COLUMNS = (
    "email_suggested_events_enabled",
    "push_suggested_events_enabled",
)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = {c["name"] for c in inspector.get_columns("users")}
    for name in _COLUMNS:
        if name not in existing:
            op.add_column(
                "users",
                sa.Column(
                    name,
                    sa.Boolean(),
                    nullable=False,
                    server_default=sa.true(),
                ),
            )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = {c["name"] for c in inspector.get_columns("users")}
    for name in reversed(_COLUMNS):
        if name in existing:
            op.drop_column("users", name)
