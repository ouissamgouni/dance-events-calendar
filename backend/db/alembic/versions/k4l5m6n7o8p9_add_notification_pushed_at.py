"""add_notification_pushed_at

Revision ID: k4l5m6n7o8p9
Revises: j4k5l6m7n8o9
Create Date: 2026-07-06

Adds a nullable ``notifications.pushed_at`` column so push delivery can be
tracked independently of ``emailed_at``. Previously both channels shared a
single dedup stamp, which meant push notifications were incorrectly gated
by the (much slower) weekly activity-digest email schedule — see
``backend/services/activity_email.py`` for the decoupled ``run_once()``
logic that now stamps this column on every dispatch tick, independent of
the email schedule gate.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "k4l5m6n7o8p9"
down_revision: Union[str, None] = "j4k5l6m7n8o9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    existing_cols = {c["name"] for c in inspector.get_columns("notifications")}
    if "pushed_at" not in existing_cols:
        op.add_column(
            "notifications",
            sa.Column("pushed_at", sa.DateTime(), nullable=True),
        )
        op.create_index("ix_notifications_pushed_at", "notifications", ["pushed_at"])


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    existing_cols = {c["name"] for c in inspector.get_columns("notifications")}
    if "pushed_at" in existing_cols:
        op.drop_index("ix_notifications_pushed_at", table_name="notifications")
        op.drop_column("notifications", "pushed_at")
