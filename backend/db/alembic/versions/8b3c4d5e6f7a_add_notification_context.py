"""add_notification_context

Revision ID: 8b3c4d5e6f7a
Revises: 7c1d9e2a6b4f
Create Date: 2026-05-08

Interest Profiles & Interest-Event Notifications PRD (Section 7/14):
adds a nullable ``notifications.context`` column so kinds that need extra
message copy beyond actor/event (e.g. ``interest_event``'s matched profile
label(s)) can carry it through to the in-app/email/push renderers without a
second lookup.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "8b3c4d5e6f7a"
down_revision: Union[str, None] = "7c1d9e2a6b4f"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    existing_cols = {c["name"] for c in inspector.get_columns("notifications")}
    if "context" not in existing_cols:
        op.add_column(
            "notifications",
            sa.Column("context", sa.String(length=200), nullable=True),
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    existing_cols = {c["name"] for c in inspector.get_columns("notifications")}
    if "context" in existing_cols:
        op.drop_column("notifications", "context")
