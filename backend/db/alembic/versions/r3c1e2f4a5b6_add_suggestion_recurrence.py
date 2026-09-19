"""add suggestion recurrence + cached_events.suggestion_id

Revision ID: r3c1e2f4a5b6
Revises: eik1a2b3c4d5
Create Date: 2026-09-18

User-declared recurrence on event suggestions. ``recurrence_rule`` holds an
RFC 5545 RRULE line (DTSTART implied by ``event_suggestions.start``);
``recurrence_dates`` holds explicit per-occurrence ``{start, end}`` objects for
the "choose dates" mode. The two are mutually exclusive.

``cached_events.suggestion_id`` lets a recurring suggestion fan out to one
CachedEvent per occurrence while still being reconcilable as a set — needed
because an admin can edit a suggestion's start/recurrence after submission and
change the occurrence count. Backfilled from ``created_event_id`` so
pre-existing single-occurrence suggestions reconcile the same way.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "r3c1e2f4a5b6"
down_revision: Union[str, None] = "eik1a2b3c4d5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    suggestion_columns = {c["name"] for c in inspector.get_columns("event_suggestions")}
    if "recurrence_rule" not in suggestion_columns:
        op.add_column(
            "event_suggestions",
            sa.Column("recurrence_rule", sa.String(length=500), nullable=True),
        )
    if "recurrence_dates" not in suggestion_columns:
        op.add_column(
            "event_suggestions",
            sa.Column("recurrence_dates", sa.JSON(), nullable=True),
        )

    event_columns = {c["name"] for c in inspector.get_columns("cached_events")}
    if "suggestion_id" not in event_columns:
        op.add_column(
            "cached_events",
            sa.Column("suggestion_id", sa.Uuid(), nullable=True),
        )
        op.create_foreign_key(
            "fk_cached_events_suggestion_id",
            "cached_events",
            "event_suggestions",
            ["suggestion_id"],
            ["id"],
            ondelete="SET NULL",
        )
        op.create_index(
            "ix_cached_events_suggestion_id", "cached_events", ["suggestion_id"]
        )
        op.execute(
            """
            UPDATE cached_events AS ce
            SET suggestion_id = es.id
            FROM event_suggestions AS es
            WHERE es.created_event_id = ce.event_id
            """
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    event_columns = {c["name"] for c in inspector.get_columns("cached_events")}
    if "suggestion_id" in event_columns:
        op.drop_index("ix_cached_events_suggestion_id", table_name="cached_events")
        op.drop_constraint(
            "fk_cached_events_suggestion_id", "cached_events", type_="foreignkey"
        )
        op.drop_column("cached_events", "suggestion_id")

    suggestion_columns = {c["name"] for c in inspector.get_columns("event_suggestions")}
    if "recurrence_dates" in suggestion_columns:
        op.drop_column("event_suggestions", "recurrence_dates")
    if "recurrence_rule" in suggestion_columns:
        op.drop_column("event_suggestions", "recurrence_rule")
