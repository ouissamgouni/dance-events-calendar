"""add_calendar_subscriptions

Revision ID: bb20c3d4e5f7
Revises: aa10b2c3d4e6
Create Date: 2026-05-12

Phase B: subscribe to a user's calendar.

A ``calendar_subscriptions`` row records the subscriber's standing interest
in a target user's saved+going feed; ``notify_new_events`` controls whether
the subscriber receives an in-app notification when the target publishes
new activity (Phase C wires this).

Subscribing is gated by ``can_view(viewer, target, 'calendar')`` at write
time; the same check is re-applied at feed/notification emit time so that a
target can effectively revoke access by tightening their calendar
visibility, without us needing to retroactively delete subscriptions.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "bb20c3d4e5f7"
down_revision: Union[str, None] = "aa10b2c3d4e6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "calendar_subscriptions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("subscriber_id", sa.Uuid(), nullable=False),
        sa.Column("target_user_id", sa.Uuid(), nullable=False),
        sa.Column(
            "notify_new_events",
            sa.Boolean(),
            nullable=False,
            server_default=sa.true(),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.ForeignKeyConstraint(["subscriber_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["target_user_id"], ["users.id"], ondelete="CASCADE"),
        sa.UniqueConstraint(
            "subscriber_id",
            "target_user_id",
            name="uq_calendar_subscription_pair",
        ),
        sa.CheckConstraint(
            "subscriber_id <> target_user_id",
            name="ck_calendar_subscription_not_self",
        ),
    )
    op.create_index(
        "ix_calendar_subscriptions_subscriber_id",
        "calendar_subscriptions",
        ["subscriber_id"],
    )
    op.create_index(
        "ix_calendar_subscriptions_target_user_id",
        "calendar_subscriptions",
        ["target_user_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_calendar_subscriptions_target_user_id",
        table_name="calendar_subscriptions",
    )
    op.drop_index(
        "ix_calendar_subscriptions_subscriber_id",
        table_name="calendar_subscriptions",
    )
    op.drop_table("calendar_subscriptions")
