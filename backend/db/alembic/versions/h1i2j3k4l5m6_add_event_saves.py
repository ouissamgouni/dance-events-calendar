"""add_event_saves_table

Revision ID: h1i2j3k4l5m6
Revises: g1h2i3j4k5l6
Create Date: 2026-04-16 12:00:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "h1i2j3k4l5m6"
down_revision: Union[str, None] = "g1h2i3j4k5l6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "event_saves",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("event_id", sa.String(), nullable=False, index=True),
        sa.Column("device_id", sa.String(), nullable=False, index=True),
        sa.Column("action", sa.String(), nullable=False, server_default="save"),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )


def downgrade() -> None:
    op.drop_table("event_saves")
