"""add event_suggestions.creator_going

Revision ID: s4d2f3a6b7c8
Revises: r3c1e2f4a5b6
Create Date: 2026-09-19

The submitter's "I'm going" was applied at submit time and then discarded. A
recurring suggestion materialises occurrences in three waves (bounded preview
on submit, full horizon on approval, rolling window for open-ended rules), so
the intent has to be persisted for the later waves to replay it onto the
occurrences they create. Backfilled from the attendance row that the old
first-occurrence-only code left behind, so pending suggestions keep their RSVP.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "s4d2f3a6b7c8"
down_revision: Union[str, None] = "r3c1e2f4a5b6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    columns = {c["name"] for c in inspector.get_columns("event_suggestions")}
    if "creator_going" not in columns:
        op.add_column(
            "event_suggestions",
            sa.Column(
                "creator_going",
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            ),
        )
    if "creator_going_audience" not in columns:
        op.add_column(
            "event_suggestions",
            sa.Column("creator_going_audience", sa.String(length=16), nullable=True),
        )

    op.execute(
        """
        UPDATE event_suggestions AS es
        SET creator_going = true,
            creator_going_audience = uea.share_audience
        FROM user_event_attendances AS uea
        WHERE uea.event_id = es.created_event_id
          AND uea.user_id = es.submitter_user_id
        """
    )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    columns = {c["name"] for c in inspector.get_columns("event_suggestions")}
    if "creator_going_audience" in columns:
        op.drop_column("event_suggestions", "creator_going_audience")
    if "creator_going" in columns:
        op.drop_column("event_suggestions", "creator_going")
