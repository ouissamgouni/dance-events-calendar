"""add calendar_default_tags table

Revision ID: p1q2r3s4t5u6
Revises: o1p2q3r4s5t6
Create Date: 2026-04-29 12:00:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "p1q2r3s4t5u6"
down_revision: Union[str, None] = "o1p2q3r4s5t6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "calendar_default_tags",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("calendar_id", sa.String(), nullable=False),
        sa.Column("tag_id", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["calendar_id"], ["calendar_settings.calendar_id"]),
        sa.ForeignKeyConstraint(["tag_id"], ["tags.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("calendar_id", "tag_id", name="uq_calendar_default_tag"),
    )
    op.create_index(
        "ix_calendar_default_tags_calendar_id", "calendar_default_tags", ["calendar_id"]
    )
    op.create_index(
        "ix_calendar_default_tags_tag_id", "calendar_default_tags", ["tag_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_calendar_default_tags_tag_id", table_name="calendar_default_tags")
    op.drop_index(
        "ix_calendar_default_tags_calendar_id", table_name="calendar_default_tags"
    )
    op.drop_table("calendar_default_tags")
