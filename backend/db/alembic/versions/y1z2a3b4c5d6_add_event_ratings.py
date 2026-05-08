"""add event_ratings table + review-tags TagGroup + link tag_suggestions to feedback

Revision ID: y1z2a3b4c5d6
Revises: x1y2z3a4b5c6
Create Date: 2026-06-01

Adds the rating/feedback feature:
- event_ratings table (pre-moderated reviews; nullable user_id for soft anonymisation
  via ``ON DELETE SET NULL`` so account deletion preserves aggregate scores).
- Partial unique index ensures one rating per (user_id, event_id) for non-anon rows.
- ``feedback_submission_id`` on tag_suggestions links suggestions submitted in the
  same envelope as a rating (decoupled moderation, joined display in admin).
- Seeds a ``review-tags`` TagGroup with starter tags so users have something to pick.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "y1z2a3b4c5d6"
down_revision: Union[str, None] = "x1y2z3a4b5c6"
branch_labels = None
depends_on = None


REVIEW_TAGS = [
    ("great-music", "Great music"),
    ("friendly-crowd", "Friendly crowd"),
    ("crowded", "Crowded"),
    ("overpriced", "Overpriced"),
    ("beginner-friendly", "Beginner-friendly"),
    ("authentic", "Authentic"),
    ("loud", "Loud"),
    ("good-venue", "Good venue"),
]


def upgrade() -> None:
    # --- event_ratings -------------------------------------------------------
    op.create_table(
        "event_ratings",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("event_id", sa.String(), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("stars", sa.Integer(), nullable=False),
        sa.Column("comment", sa.Text(), nullable=True),
        sa.Column("review_tag_ids", postgresql.JSON(), nullable=True),
        sa.Column(
            "is_anonymous",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column(
            "feedback_submission_id", postgresql.UUID(as_uuid=True), nullable=True
        ),
        sa.Column(
            "status",
            sa.String(length=16),
            nullable=False,
            server_default="pending",
        ),
        sa.Column("admin_notes", sa.Text(), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(), nullable=True),
        sa.Column("reviewed_by", sa.String(length=255), nullable=True),
        sa.Column("submitter_ip", sa.String(length=64), nullable=True),
        sa.Column("submitter_user_agent", sa.String(length=512), nullable=True),
        sa.Column("submitter_country", sa.String(length=8), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint("stars >= 1 AND stars <= 5", name="ck_event_ratings_stars"),
        sa.ForeignKeyConstraint(
            ["event_id"],
            ["cached_events.event_id"],
            name="fk_event_ratings_event_id",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_event_ratings_user_id",
            ondelete="SET NULL",
        ),
    )
    op.create_index("ix_event_ratings_event_id", "event_ratings", ["event_id"])
    op.create_index("ix_event_ratings_user_id", "event_ratings", ["user_id"])
    op.create_index("ix_event_ratings_status", "event_ratings", ["status"])
    op.create_index(
        "ix_event_ratings_feedback_submission_id",
        "event_ratings",
        ["feedback_submission_id"],
    )
    op.create_index("ix_event_ratings_created_at", "event_ratings", ["created_at"])

    # Partial unique index: one rating per (user, event) when user is known.
    op.execute(
        "CREATE UNIQUE INDEX uq_event_ratings_user_event "
        "ON event_ratings (user_id, event_id) WHERE user_id IS NOT NULL"
    )

    # --- tag_suggestions: link to feedback envelope --------------------------
    op.add_column(
        "tag_suggestions",
        sa.Column(
            "feedback_submission_id",
            postgresql.UUID(as_uuid=True),
            nullable=True,
        ),
    )
    op.create_index(
        "ix_tag_suggestions_feedback_submission_id",
        "tag_suggestions",
        ["feedback_submission_id"],
    )

    # --- Seed review-tags TagGroup + starter tags ---------------------------
    bind = op.get_bind()
    res = bind.execute(
        sa.text(
            "INSERT INTO tag_groups (slug, label, color, ordinal, allow_multiple, "
            "enabled, created_at) VALUES "
            "(:slug, :label, :color, :ordinal, :allow_multiple, :enabled, NOW()) "
            "ON CONFLICT (slug) DO UPDATE SET label = EXCLUDED.label "
            "RETURNING id"
        ),
        {
            "slug": "review-tags",
            "label": "Review tags",
            "color": "#f59e0b",
            "ordinal": 100,
            "allow_multiple": True,
            "enabled": True,
        },
    )
    group_id = res.scalar_one()

    for ordinal, (slug, label) in enumerate(REVIEW_TAGS):
        bind.execute(
            sa.text(
                "INSERT INTO tags (group_id, slug, label, ordinal, enabled, "
                "is_hero_filter, created_at) VALUES "
                "(:group_id, :slug, :label, :ordinal, true, false, NOW()) "
                "ON CONFLICT (group_id, slug) DO NOTHING"
            ),
            {
                "group_id": group_id,
                "slug": slug,
                "label": label,
                "ordinal": ordinal,
            },
        )


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.text(
            "DELETE FROM tags WHERE group_id IN "
            "(SELECT id FROM tag_groups WHERE slug = 'review-tags')"
        )
    )
    bind.execute(sa.text("DELETE FROM tag_groups WHERE slug = 'review-tags'"))

    op.drop_index(
        "ix_tag_suggestions_feedback_submission_id", table_name="tag_suggestions"
    )
    op.drop_column("tag_suggestions", "feedback_submission_id")

    op.execute("DROP INDEX IF EXISTS uq_event_ratings_user_event")
    op.drop_index("ix_event_ratings_created_at", table_name="event_ratings")
    op.drop_index("ix_event_ratings_feedback_submission_id", table_name="event_ratings")
    op.drop_index("ix_event_ratings_status", table_name="event_ratings")
    op.drop_index("ix_event_ratings_user_id", table_name="event_ratings")
    op.drop_index("ix_event_ratings_event_id", table_name="event_ratings")
    op.drop_table("event_ratings")
