"""event_ratings.scope: review of this edition vs. an earlier edition

Revision ID: rs1a2b3c4d5e
Revises: ts1a2b3c4d5e
Create Date: 2026-10-07
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "rs1a2b3c4d5e"
down_revision: Union[str, None] = "ts1a2b3c4d5e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "event_ratings",
        sa.Column(
            "scope",
            sa.String(length=20),
            nullable=False,
            server_default="this_edition",
        ),
    )
    op.execute("DROP INDEX IF EXISTS uq_event_ratings_user_event")
    op.execute(
        "CREATE UNIQUE INDEX uq_event_ratings_user_event_scope "
        "ON event_ratings (user_id, event_id, scope) WHERE user_id IS NOT NULL"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_event_ratings_user_event_scope")
    for child in ("event_rating_aspect_scores", "event_rating_aspect_tags"):
        op.execute(
            f"DELETE FROM {child} WHERE rating_id IN "
            "(SELECT id FROM event_ratings WHERE scope <> 'this_edition')"
        )
    op.execute("DELETE FROM event_ratings WHERE scope <> 'this_edition'")
    op.execute(
        "CREATE UNIQUE INDEX uq_event_ratings_user_event "
        "ON event_ratings (user_id, event_id) WHERE user_id IS NOT NULL"
    )
    op.drop_column("event_ratings", "scope")
