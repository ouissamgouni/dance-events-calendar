"""add event_messages + reports + user event-message notification gates

Revision ID: em01a2b3c4d5
Revises: n2o3p4q5r6s7
Create Date: 2026-08-10

Adds the event message/Q&A board:
- event_messages table (flat threading via nullable self-FK ``parent_id``;
  nullable ``author_user_id`` with ``ON DELETE SET NULL`` so account deletion
  anonymises authored messages; ``deleted_at`` soft-delete + ``is_hidden``
  admin moderation flag).
- event_message_reports table (one report per (message, reporter)).
- Per-feature email/push gates on ``users`` for the new ``event_messages``
  notification bucket.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "em01a2b3c4d5"
down_revision: Union[str, None] = "n2o3p4q5r6s7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "event_messages",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("event_id", sa.String(), nullable=False),
        sa.Column("author_user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("parent_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column(
            "category",
            sa.String(length=16),
            nullable=False,
            server_default="other",
        ),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column(
            "is_hidden",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column("deleted_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["event_id"],
            ["cached_events.event_id"],
            name="fk_event_messages_event_id",
        ),
        sa.ForeignKeyConstraint(
            ["author_user_id"],
            ["users.id"],
            name="fk_event_messages_author_user_id",
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["parent_id"],
            ["event_messages.id"],
            name="fk_event_messages_parent_id",
            ondelete="CASCADE",
        ),
    )
    op.create_index("ix_event_messages_event_id", "event_messages", ["event_id"])
    op.create_index(
        "ix_event_messages_author_user_id", "event_messages", ["author_user_id"]
    )
    op.create_index("ix_event_messages_parent_id", "event_messages", ["parent_id"])
    op.create_index("ix_event_messages_is_hidden", "event_messages", ["is_hidden"])
    op.create_index("ix_event_messages_deleted_at", "event_messages", ["deleted_at"])
    op.create_index("ix_event_messages_created_at", "event_messages", ["created_at"])

    op.create_table(
        "event_message_reports",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("message_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("reporter_user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("reason", sa.String(length=280), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("resolved_at", sa.DateTime(), nullable=True),
        sa.Column("resolved_by", sa.String(length=255), nullable=True),
        sa.ForeignKeyConstraint(
            ["message_id"],
            ["event_messages.id"],
            name="fk_event_message_reports_message_id",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["reporter_user_id"],
            ["users.id"],
            name="fk_event_message_reports_reporter_user_id",
            ondelete="SET NULL",
        ),
        sa.UniqueConstraint(
            "message_id", "reporter_user_id", name="uq_event_message_report"
        ),
    )
    op.create_index(
        "ix_event_message_reports_message_id", "event_message_reports", ["message_id"]
    )
    op.create_index(
        "ix_event_message_reports_reporter_user_id",
        "event_message_reports",
        ["reporter_user_id"],
    )
    op.create_index(
        "ix_event_message_reports_created_at",
        "event_message_reports",
        ["created_at"],
    )

    op.add_column(
        "users",
        sa.Column(
            "email_event_messages_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
    )
    op.add_column(
        "users",
        sa.Column(
            "push_event_messages_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
    )


def downgrade() -> None:
    op.drop_column("users", "push_event_messages_enabled")
    op.drop_column("users", "email_event_messages_enabled")
    op.drop_index(
        "ix_event_message_reports_created_at", table_name="event_message_reports"
    )
    op.drop_index(
        "ix_event_message_reports_reporter_user_id",
        table_name="event_message_reports",
    )
    op.drop_index(
        "ix_event_message_reports_message_id", table_name="event_message_reports"
    )
    op.drop_table("event_message_reports")
    op.drop_index("ix_event_messages_created_at", table_name="event_messages")
    op.drop_index("ix_event_messages_deleted_at", table_name="event_messages")
    op.drop_index("ix_event_messages_is_hidden", table_name="event_messages")
    op.drop_index("ix_event_messages_parent_id", table_name="event_messages")
    op.drop_index("ix_event_messages_author_user_id", table_name="event_messages")
    op.drop_index("ix_event_messages_event_id", table_name="event_messages")
    op.drop_table("event_messages")
