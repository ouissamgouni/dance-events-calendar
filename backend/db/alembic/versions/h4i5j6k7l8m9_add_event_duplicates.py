"""add_event_duplicates

Revision ID: h4i5j6k7l8m9
Revises: y3z4a5b6c7d8
Create Date: 2026-07-19

Adds tables backing the admin duplicate-events detection/review feature:
``event_duplicate_groups``, ``event_duplicate_members``,
``event_duplicate_scan_log``. Also adds ``cached_events.rejected_duplicate_reason``
and a new ``deleted_at, start`` index used to narrow the candidate query
before the Python-side fuzzy title match runs.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "h4i5j6k7l8m9"
down_revision: Union[str, None] = "y3z4a5b6c7d8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "cached_events",
        sa.Column("rejected_duplicate_reason", sa.String(), nullable=True),
    )
    op.create_index(
        "ix_cached_events_active_start",
        "cached_events",
        ["deleted_at", "start"],
    )

    op.create_table(
        "event_duplicate_groups",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(), nullable=False, server_default="pending"),
        sa.Column("source", sa.String(), nullable=False, server_default="auto"),
        sa.Column("kept_event_id", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("resolved_at", sa.DateTime(), nullable=True),
        sa.Column("resolved_by_admin", sa.String(length=255), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_event_duplicate_groups_status", "event_duplicate_groups", ["status"]
    )

    op.create_table(
        "event_duplicate_members",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("group_id", sa.Integer(), nullable=False),
        sa.Column("event_id", sa.String(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["group_id"], ["event_duplicate_groups.id"]),
        sa.ForeignKeyConstraint(["event_id"], ["cached_events.event_id"]),
        sa.UniqueConstraint("group_id", "event_id", name="uq_duplicate_group_event"),
    )
    op.create_index(
        "ix_event_duplicate_members_group_id",
        "event_duplicate_members",
        ["group_id"],
    )
    op.create_index(
        "ix_event_duplicate_members_event_id",
        "event_duplicate_members",
        ["event_id"],
    )

    op.create_table(
        "event_duplicate_scan_log",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column(
            "scan_type", sa.String(), nullable=False, server_default="incremental"
        ),
        sa.Column("triggered_by_event_id", sa.String(), nullable=True),
        sa.Column("triggered_by_admin", sa.String(length=255), nullable=True),
        sa.Column("started_at", sa.DateTime(), nullable=False),
        sa.Column("finished_at", sa.DateTime(), nullable=True),
        sa.Column("candidates_found", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("groups_created", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("status", sa.String(), nullable=False, server_default="running"),
        sa.PrimaryKeyConstraint("id"),
    )


def downgrade() -> None:
    op.drop_table("event_duplicate_scan_log")
    op.drop_index(
        "ix_event_duplicate_members_event_id", table_name="event_duplicate_members"
    )
    op.drop_index(
        "ix_event_duplicate_members_group_id", table_name="event_duplicate_members"
    )
    op.drop_table("event_duplicate_members")
    op.drop_index(
        "ix_event_duplicate_groups_status", table_name="event_duplicate_groups"
    )
    op.drop_table("event_duplicate_groups")
    op.drop_index("ix_cached_events_active_start", table_name="cached_events")
    op.drop_column("cached_events", "rejected_duplicate_reason")
