"""tag_suggestions.submitter_user_id: who asked for a new tag

Revision ID: ts1a2b3c4d5e
Revises: mg1a2b3c4d5e
Create Date: 2026-10-07
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "ts1a2b3c4d5e"
down_revision: Union[str, None] = "mg1a2b3c4d5e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "tag_suggestions",
        sa.Column(
            "submitter_user_id",
            sa.Uuid(),
            sa.ForeignKey(
                "users.id",
                name="fk_tag_suggestions_submitter_user_id",
                ondelete="SET NULL",
            ),
            nullable=True,
        ),
    )
    op.create_index(
        "ix_tag_suggestions_submitter_user_id",
        "tag_suggestions",
        ["submitter_user_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_tag_suggestions_submitter_user_id", table_name="tag_suggestions")
    op.drop_constraint(
        "fk_tag_suggestions_submitter_user_id", "tag_suggestions", type_="foreignkey"
    )
    op.drop_column("tag_suggestions", "submitter_user_id")
