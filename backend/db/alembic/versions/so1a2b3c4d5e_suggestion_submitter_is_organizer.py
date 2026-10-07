"""event_suggestions.submitter_is_organizer: attribute an organizer's own submission on approval

Revision ID: so1a2b3c4d5e
Revises: es1a2b3c4d5e
Create Date: 2026-10-06
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "so1a2b3c4d5e"
down_revision: Union[str, None] = "es1a2b3c4d5e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "event_suggestions",
        sa.Column(
            "submitter_is_organizer",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )


def downgrade() -> None:
    op.drop_column("event_suggestions", "submitter_is_organizer")
