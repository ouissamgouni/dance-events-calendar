"""submitter editing of suggestions

Revision ID: se1a2b3c4d5e
Revises: si1a2b3c4d5e
Create Date: 2026-10-04

``cached_events.occurrence_key`` pins each materialised occurrence to the date
the recurrence produced for it, backfilled from ``start``.
``event_suggestions.edit_locked`` lets an admin freeze a suggestion.
``suggestion_audit_log`` records every edit.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "se1a2b3c4d5e"
down_revision: Union[str, None] = "si1a2b3c4d5e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())

    event_columns = {c["name"] for c in inspector.get_columns("cached_events")}
    if "occurrence_key" not in event_columns:
        op.add_column(
            "cached_events",
            sa.Column("occurrence_key", sa.DateTime(), nullable=True),
        )
        op.execute(
            "UPDATE cached_events SET occurrence_key = start "
            "WHERE suggestion_id IS NOT NULL"
        )

    suggestion_columns = {c["name"] for c in inspector.get_columns("event_suggestions")}
    if "edit_locked" not in suggestion_columns:
        op.add_column(
            "event_suggestions",
            sa.Column(
                "edit_locked",
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            ),
        )

    if "suggestion_audit_log" not in inspector.get_table_names():
        op.create_table(
            "suggestion_audit_log",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column(
                "suggestion_id",
                sa.Uuid(),
                sa.ForeignKey("event_suggestions.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column(
                "actor_user_id",
                sa.Uuid(),
                sa.ForeignKey("users.id", ondelete="SET NULL"),
                nullable=True,
            ),
            sa.Column("actor_admin_email", sa.String(length=255), nullable=True),
            sa.Column("action", sa.String(length=32), nullable=False),
            sa.Column("changes", sa.JSON(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
        )
        op.create_index(
            "ix_suggestion_audit_log_suggestion_id",
            "suggestion_audit_log",
            ["suggestion_id"],
        )


def downgrade() -> None:
    op.drop_index(
        "ix_suggestion_audit_log_suggestion_id", table_name="suggestion_audit_log"
    )
    op.drop_table("suggestion_audit_log")
    op.drop_column("event_suggestions", "edit_locked")
    op.drop_column("cached_events", "occurrence_key")
