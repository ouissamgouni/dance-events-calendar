"""add geo fields to event_views and event_link_clicks

Revision ID: q1r2s3t4u5v6
Revises: p1q2r3s4t5u6
Create Date: 2026-04-29 12:00:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "q1r2s3t4u5v6"
down_revision: Union[str, None] = "p1q2r3s4t5u6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("event_views", sa.Column("country", sa.String(), nullable=True))
    op.add_column("event_views", sa.Column("city", sa.String(), nullable=True))
    op.add_column("event_link_clicks", sa.Column("country", sa.String(), nullable=True))
    op.add_column("event_link_clicks", sa.Column("city", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("event_link_clicks", "city")
    op.drop_column("event_link_clicks", "country")
    op.drop_column("event_views", "city")
    op.drop_column("event_views", "country")
