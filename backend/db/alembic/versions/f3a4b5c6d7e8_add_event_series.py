"""add_event_series

Revision ID: f3a4b5c6d7e8
Revises: d1e2f3a4b5c6
Create Date: 2026-07-22

Adds tables backing the admin event-series grouping / fuzzy-detection
review feature (Event Quality Layer Phase 4): ``event_series``,
``event_series_members``, ``event_series_scan_log``. Mirrors the
``event_duplicate_*`` tables added in h4i5j6k7l8m9, except a series never
hides/blocks its members — every occurrence stays independently visible.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "f3a4b5c6d7e8"
down_revision: Union[str, None] = "d1e2f3a4b5c6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "event_series",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(), nullable=False, server_default="pending"),
        sa.Column("source", sa.String(), nullable=False, server_default="auto"),
        sa.Column(
            "canonical_title",
            sa.String(length=200),
            nullable=False,
            server_default="",
        ),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("resolved_at", sa.DateTime(), nullable=True),
        sa.Column("resolved_by_admin", sa.String(length=255), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_event_series_status", "event_series", ["status"])

    op.create_table(
        "event_series_members",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("series_id", sa.Integer(), nullable=False),
        sa.Column("event_id", sa.String(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["series_id"], ["event_series.id"]),
        sa.ForeignKeyConstraint(["event_id"], ["cached_events.event_id"]),
        sa.UniqueConstraint("series_id", "event_id", name="uq_series_event"),
    )
    op.create_index(
        "ix_event_series_members_series_id", "event_series_members", ["series_id"]
    )
    op.create_index(
        "ix_event_series_members_event_id", "event_series_members", ["event_id"]
    )

    op.create_table(
        "event_series_scan_log",
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
    op.drop_table("event_series_scan_log")
    op.drop_index("ix_event_series_members_event_id", table_name="event_series_members")
    op.drop_index(
        "ix_event_series_members_series_id", table_name="event_series_members"
    )
    op.drop_table("event_series_members")
    op.drop_index("ix_event_series_status", table_name="event_series")
    op.drop_table("event_series")
