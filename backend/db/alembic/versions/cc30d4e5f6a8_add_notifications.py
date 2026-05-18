"""add_notifications

Revision ID: cc30d4e5f6a8
Revises: f2b4fdf1c18d
Create Date: 2026-05-20

Phase C: in-app notification feed.

Two trigger paths fan out one row per eligible subscriber:
  * ``subscription_going``: target user marked Going to ``event_id`` with
    ``share_publicly=true``.
  * ``subscription_suggested``: target user submitted an EventSuggestion
    that was admin-approved (resulting cached event id stored in
    ``event_id``).

Eligibility = an active CalendarSubscription with notify_new_events=true,
re-checked against can_view at emit time.

Also adds ``event_suggestions.submitter_user_id`` (nullable FK to users)
so that authenticated submissions can be linked back to a user account
for the suggested fan-out. Anonymous submissions remain supported.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "cc30d4e5f6a8"
down_revision: Union[str, None] = "f2b4fdf1c18d"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "notifications",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("recipient_user_id", sa.Uuid(), nullable=False),
        sa.Column("actor_user_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("event_id", sa.String(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("read_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(
            ["recipient_user_id"], ["users.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["actor_user_id"], ["users.id"], ondelete="CASCADE"),
        sa.UniqueConstraint(
            "recipient_user_id",
            "kind",
            "actor_user_id",
            "event_id",
            name="uq_notification_dedupe",
        ),
    )
    op.create_index(
        "ix_notifications_recipient_user_id",
        "notifications",
        ["recipient_user_id"],
    )
    op.create_index(
        "ix_notifications_actor_user_id",
        "notifications",
        ["actor_user_id"],
    )
    op.create_index("ix_notifications_kind", "notifications", ["kind"])
    op.create_index("ix_notifications_event_id", "notifications", ["event_id"])
    op.create_index("ix_notifications_created_at", "notifications", ["created_at"])
    op.create_index("ix_notifications_read_at", "notifications", ["read_at"])

    with op.batch_alter_table("event_suggestions") as batch:
        batch.add_column(sa.Column("submitter_user_id", sa.Uuid(), nullable=True))
        batch.create_foreign_key(
            "fk_event_suggestions_submitter_user_id_users",
            "users",
            ["submitter_user_id"],
            ["id"],
            ondelete="SET NULL",
        )
        batch.create_index(
            "ix_event_suggestions_submitter_user_id",
            ["submitter_user_id"],
        )


def downgrade() -> None:
    with op.batch_alter_table("event_suggestions") as batch:
        batch.drop_index("ix_event_suggestions_submitter_user_id")
        batch.drop_constraint(
            "fk_event_suggestions_submitter_user_id_users",
            type_="foreignkey",
        )
        batch.drop_column("submitter_user_id")

    op.drop_index("ix_notifications_read_at", table_name="notifications")
    op.drop_index("ix_notifications_created_at", table_name="notifications")
    op.drop_index("ix_notifications_event_id", table_name="notifications")
    op.drop_index("ix_notifications_kind", table_name="notifications")
    op.drop_index("ix_notifications_actor_user_id", table_name="notifications")
    op.drop_index("ix_notifications_recipient_user_id", table_name="notifications")
    op.drop_table("notifications")
