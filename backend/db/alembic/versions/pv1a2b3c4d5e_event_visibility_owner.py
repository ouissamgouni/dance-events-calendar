"""event visibility and owner

Revision ID: pv1a2b3c4d5e
Revises: tz1a2b3c4d5e
Create Date: 2026-10-05

Adds ``visibility`` (public|private) and ``owner_user_id`` to ``cached_events``.
Rows materialised from a suggestion get their submitter as owner and stay
private unless the suggestion was approved. Rejected suggestions were blocked
for everyone, so they become ``blocked``.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "pv1a2b3c4d5e"
down_revision: Union[str, None] = "tz1a2b3c4d5e"
branch_labels = None
depends_on = None


def _columns(table: str) -> set[str]:
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}


def upgrade() -> None:
    columns = _columns("cached_events")
    if "visibility" not in columns:
        op.add_column(
            "cached_events",
            sa.Column(
                "visibility",
                sa.String(16),
                nullable=False,
                server_default="public",
            ),
        )
        op.create_index("ix_cached_events_visibility", "cached_events", ["visibility"])
    if "owner_user_id" not in columns:
        op.add_column(
            "cached_events",
            sa.Column(
                "owner_user_id",
                sa.Uuid(),
                sa.ForeignKey("users.id"),
                nullable=True,
            ),
        )
        op.create_index(
            "ix_cached_events_owner_user_id", "cached_events", ["owner_user_id"]
        )

    op.execute(
        """
        UPDATE cached_events AS e
        SET owner_user_id = s.submitter_user_id,
            visibility = CASE WHEN s.status = 'approved' THEN 'public' ELSE 'private' END
        FROM event_suggestions AS s
        WHERE e.suggestion_id = s.id
        """
    )
    op.execute(
        "UPDATE event_suggestions SET status = 'blocked' WHERE status = 'rejected'"
    )


def downgrade() -> None:
    op.execute(
        "UPDATE event_suggestions SET status = 'rejected' "
        "WHERE status IN ('blocked', 'declined')"
    )
    op.execute(
        "UPDATE event_suggestions SET status = 'pending' WHERE status = 'private'"
    )
    op.drop_index("ix_cached_events_owner_user_id", table_name="cached_events")
    op.drop_column("cached_events", "owner_user_id")
    op.drop_index("ix_cached_events_visibility", table_name="cached_events")
    op.drop_column("cached_events", "visibility")
