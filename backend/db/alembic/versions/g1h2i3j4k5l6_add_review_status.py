"""add_review_status_to_cached_events

Revision ID: g1h2i3j4k5l6
Revises: f1a2b3c4d5e6
Create Date: 2026-04-16 10:00:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "g1h2i3j4k5l6"
down_revision: Union[str, None] = "f1a2b3c4d5e6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "cached_events",
        sa.Column(
            "review_status",
            sa.String(),
            nullable=False,
            server_default="reviewed",
        ),
    )


def downgrade() -> None:
    op.drop_column("cached_events", "review_status")
