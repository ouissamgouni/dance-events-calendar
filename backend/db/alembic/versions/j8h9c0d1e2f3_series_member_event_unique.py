"""series_member_event_unique

Revision ID: j8h9c0d1e2f3
Revises: i7g8b9c0d1e2
Create Date: 2026-08-06

Enforces the single-membership invariant for event series: an event may
belong to at most one series. Before adding the unique index we deduplicate
any pre-existing memberships (keeping the earliest per event) and drop the
now-undersized series (fewer than two members) so the data matches the
invariant the app now maintains via auto-dissolve on member removal.
"""

from typing import Union

from alembic import op


revision: str = "j8h9c0d1e2f3"
down_revision: Union[str, None] = "i7g8b9c0d1e2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Keep only the earliest membership row per event_id.
    op.execute(
        """
        DELETE FROM event_series_members
        WHERE id NOT IN (
            SELECT min_id FROM (
                SELECT MIN(id) AS min_id
                FROM event_series_members
                GROUP BY event_id
            ) AS keep
        )
        """
    )
    # Drop members of series left with fewer than two occurrences, then the
    # now-empty series rows.
    op.execute(
        """
        DELETE FROM event_series_members
        WHERE series_id IN (
            SELECT series_id FROM (
                SELECT series_id
                FROM event_series_members
                GROUP BY series_id
                HAVING COUNT(*) < 2
            ) AS undersized
        )
        """
    )
    op.execute(
        """
        DELETE FROM event_series
        WHERE id NOT IN (
            SELECT DISTINCT series_id FROM event_series_members
        )
        """
    )

    op.drop_index("ix_event_series_members_event_id", table_name="event_series_members")
    op.create_index(
        "uq_event_series_member_event",
        "event_series_members",
        ["event_id"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("uq_event_series_member_event", table_name="event_series_members")
    op.create_index(
        "ix_event_series_members_event_id", "event_series_members", ["event_id"]
    )
