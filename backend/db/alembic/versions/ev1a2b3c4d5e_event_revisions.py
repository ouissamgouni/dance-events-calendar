"""event revisions

Revision ID: ev1a2b3c4d5e
Revises: se1a2b3c4d5e
Create Date: 2026-10-04

``event_revisions`` stages changes to already-published events (Google source
edits, admin drafts, submitter edits of approved suggestions) until an admin
applies or discards them, and keeps the history afterwards.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "ev1a2b3c4d5e"
down_revision: Union[str, None] = "se1a2b3c4d5e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "event_revisions" in inspector.get_table_names():
        return
    op.create_table(
        "event_revisions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "event_id",
            sa.String(),
            sa.ForeignKey("cached_events.event_id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column(
            "suggestion_id",
            sa.Uuid(),
            sa.ForeignKey("event_suggestions.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("source", sa.String(length=16), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("changes", sa.JSON(), nullable=False),
        sa.Column("content_hash", sa.String(length=64), nullable=True),
        sa.Column(
            "proposed_by_user_id",
            sa.Uuid(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("proposed_by_admin_email", sa.String(length=255), nullable=True),
        sa.Column("decided_by", sa.String(length=255), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "notified_count", sa.Integer(), nullable=False, server_default="0"
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_event_revisions_event_id", "event_revisions", ["event_id"])
    op.create_index(
        "ix_event_revisions_suggestion_id", "event_revisions", ["suggestion_id"]
    )
    op.create_index("ix_event_revisions_status", "event_revisions", ["status"])


def downgrade() -> None:
    op.drop_index("ix_event_revisions_status", table_name="event_revisions")
    op.drop_index("ix_event_revisions_suggestion_id", table_name="event_revisions")
    op.drop_index("ix_event_revisions_event_id", table_name="event_revisions")
    op.drop_table("event_revisions")
