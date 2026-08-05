"""reshape event_ratings for adaptive review system

Revision ID: e2f3a4b5c6d7
Revises: f3a4b5c6d7e8
Create Date: 2026-07-23

Redesign of the review feature (not yet in prod). Replaces the mood /
come_again / flat review_tag_ids shape with the adaptive review model:

- event_ratings: drop ``mood``, ``come_again``, ``review_tag_ids``; add
  ``overall_sentiment`` (amazing|great|okay|disappointing|bad — internal
  ``stars`` is derived from it), ``audience_tag_ids`` (JSON, recommendation
  audience), and ``comment_status`` (none|pending|approved|rejected — only the
  free-text comment is moderated; structured signals count live).
- tags: add ``polarity`` (positive|negative) for aspect tags.
- tag_groups: add ``condition_tag_slugs`` (JSON) to gate conditional aspect
  groups (e.g. Workshop only for workshop/class events).
- new ``event_rating_aspect_tags`` table: per-rating aspect-scoped tag choices.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "e2f3a4b5c6d7"
down_revision: Union[str, None] = "f3a4b5c6d7e8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # --- event_ratings reshape ----------------------------------------------
    op.drop_constraint("ck_event_ratings_mood", "event_ratings", type_="check")
    op.drop_constraint("ck_event_ratings_come_again", "event_ratings", type_="check")
    op.drop_column("event_ratings", "mood")
    op.drop_column("event_ratings", "come_again")
    op.drop_column("event_ratings", "review_tag_ids")

    op.add_column(
        "event_ratings",
        sa.Column("overall_sentiment", sa.String(length=20), nullable=True),
    )
    op.add_column(
        "event_ratings",
        sa.Column("audience_tag_ids", postgresql.JSON(), nullable=True),
    )
    op.add_column(
        "event_ratings",
        sa.Column(
            "comment_status",
            sa.String(length=16),
            nullable=False,
            server_default="none",
        ),
    )
    op.alter_column("event_ratings", "status", server_default="approved")
    op.create_check_constraint(
        "ck_event_ratings_overall_sentiment",
        "event_ratings",
        "overall_sentiment IS NULL OR overall_sentiment IN "
        "('amazing', 'great', 'okay', 'disappointing', 'bad')",
    )
    op.create_index(
        "ix_event_ratings_comment_status", "event_ratings", ["comment_status"]
    )

    # --- tags / tag_groups extensions ---------------------------------------
    op.add_column("tags", sa.Column("polarity", sa.String(length=16), nullable=True))
    op.create_check_constraint(
        "ck_tags_polarity",
        "tags",
        "polarity IS NULL OR polarity IN ('positive', 'negative')",
    )
    op.add_column(
        "tag_groups",
        sa.Column("condition_tag_slugs", postgresql.JSON(), nullable=True),
    )

    # --- event_rating_aspect_tags -------------------------------------------
    op.create_table(
        "event_rating_aspect_tags",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("rating_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("aspect_slug", sa.String(length=32), nullable=False),
        sa.Column("tag_id", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["rating_id"],
            ["event_ratings.id"],
            name="fk_event_rating_aspect_tags_rating_id",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tag_id"],
            ["tags.id"],
            name="fk_event_rating_aspect_tags_tag_id",
        ),
        sa.UniqueConstraint("rating_id", "tag_id", name="uq_event_rating_aspect_tag"),
    )
    op.create_index(
        "ix_event_rating_aspect_tags_rating_id",
        "event_rating_aspect_tags",
        ["rating_id"],
    )
    op.create_index(
        "ix_event_rating_aspect_tags_tag_id",
        "event_rating_aspect_tags",
        ["tag_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_event_rating_aspect_tags_tag_id", table_name="event_rating_aspect_tags"
    )
    op.drop_index(
        "ix_event_rating_aspect_tags_rating_id", table_name="event_rating_aspect_tags"
    )
    op.drop_table("event_rating_aspect_tags")

    op.drop_column("tag_groups", "condition_tag_slugs")
    op.drop_constraint("ck_tags_polarity", "tags", type_="check")
    op.drop_column("tags", "polarity")

    op.drop_index("ix_event_ratings_comment_status", table_name="event_ratings")
    op.drop_constraint(
        "ck_event_ratings_overall_sentiment", "event_ratings", type_="check"
    )
    op.alter_column("event_ratings", "status", server_default="pending")
    op.drop_column("event_ratings", "comment_status")
    op.drop_column("event_ratings", "audience_tag_ids")
    op.drop_column("event_ratings", "overall_sentiment")

    op.add_column(
        "event_ratings",
        sa.Column("review_tag_ids", postgresql.JSON(), nullable=True),
    )
    op.add_column(
        "event_ratings", sa.Column("come_again", sa.String(length=10), nullable=True)
    )
    op.add_column(
        "event_ratings", sa.Column("mood", sa.String(length=20), nullable=True)
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
