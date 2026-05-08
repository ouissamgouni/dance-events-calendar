"""event_suggestion_new_tags

Revision ID: f6a7b8c9d0e1
Revises: e5f6a7b8c9d0
Create Date: 2026-05-06

Adds ``suggested_new_tags`` JSON column to ``event_suggestions`` so the
public submission form can collect free-text "new tag" suggestions inline
with the event. On approval they become standard TagSuggestion rows.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "f6a7b8c9d0e1"
down_revision: Union[str, None] = "e5f6a7b8c9d0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "event_suggestions",
        sa.Column("suggested_new_tags", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("event_suggestions", "suggested_new_tags")
