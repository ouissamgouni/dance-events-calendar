"""tag_suggestion_source

Revision ID: c3d4e5f6a7b8
Revises: b2c3d4e5f6a7
Create Date: 2026-05-06

Adds auto-generated tag suggestion support to ``tag_suggestions``:

* ``source`` — origin of the row (``user`` for end-user submissions,
  ``heuristic`` for rows produced by the TagSuggestionStage in the
  enrichment pipeline). Existing rows are backfilled to ``user``.
* ``confidence`` — score 0.0-1.0 for auto-source rows (NULL for user submissions).
* ``matched_terms`` — JSON list of terms that triggered a heuristic match,
  surfaced in the admin UI for transparency.

A partial unique index prevents the pipeline stage from creating duplicate
pending auto suggestions for the same (event_id, tag_id) pair on re-runs.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "c3d4e5f6a7b8"
down_revision: Union[str, None] = "b2c3d4e5f6a7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "tag_suggestions",
        sa.Column(
            "source",
            sa.String(),
            nullable=False,
            server_default="user",
        ),
    )
    op.add_column(
        "tag_suggestions",
        sa.Column("confidence", sa.Float(), nullable=True),
    )
    op.add_column(
        "tag_suggestions",
        sa.Column("matched_terms", sa.JSON(), nullable=True),
    )
    op.create_index(
        "ix_tag_suggestions_source",
        "tag_suggestions",
        ["source"],
    )
    # Idempotency guard for the auto suggestion stage: at most one pending
    # auto suggestion per (event_id, tag_id). User submissions are not
    # constrained (an event can receive the same suggestion from multiple
    # devices). ``tag_id`` may be NULL for free-text user rows; the WHERE
    # clause excludes those because auto-source rows always populate ``tag_id``.
    op.create_index(
        "uq_tag_suggestions_heuristic_pending",
        "tag_suggestions",
        ["event_id", "tag_id"],
        unique=True,
        postgresql_where=sa.text(
            "source = 'heuristic' AND status = 'pending' AND tag_id IS NOT NULL"
        ),
        sqlite_where=sa.text(
            "source = 'heuristic' AND status = 'pending' AND tag_id IS NOT NULL"
        ),
    )


def downgrade() -> None:
    op.drop_index("uq_tag_suggestions_heuristic_pending", table_name="tag_suggestions")
    op.drop_index("ix_tag_suggestions_source", table_name="tag_suggestions")
    op.drop_column("tag_suggestions", "matched_terms")
    op.drop_column("tag_suggestions", "confidence")
    op.drop_column("tag_suggestions", "source")
