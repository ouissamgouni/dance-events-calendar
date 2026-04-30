"""add_dedup_support

Revision ID: t1u2v3w4x5y6
Revises: s1t2u3v4w5x6
Create Date: 2026-04-30

Adds:
- cached_events.content_hash (SHA-256 of normalized title|start|location)
- event_calendar_sources table (event_id, calendar_id) — tracks all source
  calendars for a canonical event; backfilled from existing cached_events rows
- sync_logs.dedup_log (JSON) — per-run list of merged duplicate entries
"""

from typing import Union

import hashlib

import sqlalchemy as sa
from alembic import op
from sqlalchemy import text

revision: str = "t1u2v3w4x5y6"
down_revision: Union[str, None] = "s1t2u3v4w5x6"
branch_labels = None
depends_on = None


def _compute_hash(title: str, start_iso: str, location: str) -> str:
    normalized = (
        f"{title.strip().lower()}|{start_iso}|{(location or '').strip().lower()}"
    )
    return hashlib.sha256(normalized.encode()).hexdigest()


def upgrade() -> None:
    # --- cached_events.content_hash ---
    op.add_column(
        "cached_events",
        sa.Column("content_hash", sa.String(), nullable=True),
    )
    op.create_index("ix_cached_events_content_hash", "cached_events", ["content_hash"])

    # --- event_calendar_sources ---
    op.create_table(
        "event_calendar_sources",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("event_id", sa.String(), nullable=False),
        sa.Column("calendar_id", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("event_id", "calendar_id", name="uq_event_calendar_source"),
    )
    op.create_index(
        "ix_event_calendar_sources_event_id", "event_calendar_sources", ["event_id"]
    )
    op.create_index(
        "ix_event_calendar_sources_calendar_id",
        "event_calendar_sources",
        ["calendar_id"],
    )

    # --- sync_logs.dedup_log ---
    op.add_column(
        "sync_logs",
        sa.Column("dedup_log", sa.JSON(), nullable=True),
    )

    # --- Data backfill ---
    conn = op.get_bind()

    # Backfill event_calendar_sources from existing non-deleted cached_events
    conn.execute(
        text(
            """
            INSERT INTO event_calendar_sources (event_id, calendar_id, created_at)
            SELECT event_id, calendar_id, NOW()
            FROM cached_events
            WHERE deleted_at IS NULL
            ON CONFLICT (event_id, calendar_id) DO NOTHING
            """
        )
    )

    # Compute content_hash for all existing events in Python (portable across DBs)
    rows = conn.execute(
        text("SELECT event_id, title, start, location FROM cached_events")
    ).fetchall()

    for row in rows:
        event_id, title, start, location = row
        title = title or ""
        start_iso = start.isoformat() if hasattr(start, "isoformat") else str(start)
        location = location or ""
        h = _compute_hash(title, start_iso, location)
        conn.execute(
            text("UPDATE cached_events SET content_hash = :h WHERE event_id = :eid"),
            {"h": h, "eid": event_id},
        )


def downgrade() -> None:
    op.drop_column("sync_logs", "dedup_log")
    op.drop_index(
        "ix_event_calendar_sources_calendar_id", table_name="event_calendar_sources"
    )
    op.drop_index(
        "ix_event_calendar_sources_event_id", table_name="event_calendar_sources"
    )
    op.drop_table("event_calendar_sources")
    op.drop_index("ix_cached_events_content_hash", table_name="cached_events")
    op.drop_column("cached_events", "content_hash")
