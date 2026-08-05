"""add mood/come_again to event_ratings + event_rating_aspect_scores table

Revision ID: c7d8e9f0a1b2
Revises: bf20c3d4e5f9
Create Date: 2026-07-22

Phase 1 of the Event Quality Layer: adds the structured post-event
"experience" fields on top of the existing event_ratings table.

- ``mood``: headline sentiment (amazing|nice|okay|disappointing). Nullable
  for legacy rows; the app derives the existing ``stars`` column from it
  (MOOD_TO_STARS) so all existing aggregate/sort/distribution code keeps
  working unchanged.
- ``come_again``: "Would you come again?" (yes|maybe|no).
- ``event_rating_aspect_scores``: normalized child table for per-aspect
  (music/crowd/floor/atmosphere) 1-5 scores, keyed by ``aspect_slug`` so new
  aspects can be added without a migration.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c7d8e9f0a1b2"
down_revision: Union[str, None] = "bf20c3d4e5f9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "event_ratings", sa.Column("mood", sa.String(length=20), nullable=True)
    )
    op.add_column(
        "event_ratings", sa.Column("come_again", sa.String(length=10), nullable=True)
    )
    op.create_check_constraint(
        "ck_event_ratings_mood",
        "event_ratings",
        "mood IS NULL OR mood IN ('amazing', 'nice', 'okay', 'disappointing')",
    )
    op.create_check_constraint(
        "ck_event_ratings_come_again",
        "event_ratings",
        "come_again IS NULL OR come_again IN ('yes', 'maybe', 'no')",
    )

    op.create_table(
        "event_rating_aspect_scores",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("rating_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("aspect_slug", sa.String(length=32), nullable=False),
        sa.Column("score", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint(
            "score >= 1 AND score <= 5", name="ck_event_rating_aspect_scores_score"
        ),
        sa.ForeignKeyConstraint(
            ["rating_id"],
            ["event_ratings.id"],
            name="fk_event_rating_aspect_scores_rating_id",
            ondelete="CASCADE",
        ),
        sa.UniqueConstraint(
            "rating_id", "aspect_slug", name="uq_event_rating_aspect_score"
        ),
    )
    op.create_index(
        "ix_event_rating_aspect_scores_rating_id",
        "event_rating_aspect_scores",
        ["rating_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_event_rating_aspect_scores_rating_id",
        table_name="event_rating_aspect_scores",
    )
    op.drop_table("event_rating_aspect_scores")
    op.drop_constraint("ck_event_ratings_come_again", "event_ratings", type_="check")
    op.drop_constraint("ck_event_ratings_mood", "event_ratings", type_="check")
    op.drop_column("event_ratings", "come_again")
    op.drop_column("event_ratings", "mood")
