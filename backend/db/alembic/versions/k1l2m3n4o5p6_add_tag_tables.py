"""add_tag_tables

Revision ID: k1l2m3n4o5p6
Revises: j1k2l3m4n5o6
Create Date: 2026-04-16 10:00:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "k1l2m3n4o5p6"
down_revision: Union[str, None] = "j1k2l3m4n5o6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. tag_groups
    op.create_table(
        "tag_groups",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("slug", sa.String(), nullable=False, unique=True),
        sa.Column("label", sa.String(), nullable=False),
        sa.Column("ordinal", sa.Integer(), server_default="0"),
        sa.Column("allow_multiple", sa.Boolean(), server_default=sa.text("true")),
        sa.Column(
            "created_at",
            sa.DateTime(),
            server_default=sa.func.now(),
        ),
    )
    op.create_index("ix_tag_groups_slug", "tag_groups", ["slug"])

    # 2. tags
    op.create_table(
        "tags",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "group_id",
            sa.Integer(),
            sa.ForeignKey("tag_groups.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("slug", sa.String(), nullable=False),
        sa.Column("label", sa.String(), nullable=False),
        sa.Column("color", sa.String(), nullable=True),
        sa.Column("ordinal", sa.Integer(), server_default="0"),
        sa.Column(
            "created_at",
            sa.DateTime(),
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint("group_id", "slug", name="uq_tag_group_slug"),
    )
    op.create_index("ix_tags_group_id", "tags", ["group_id"])

    # 3. event_tags (junction)
    op.create_table(
        "event_tags",
        sa.Column(
            "event_id",
            sa.String(),
            sa.ForeignKey("cached_events.event_id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "tag_id",
            sa.Integer(),
            sa.ForeignKey("tags.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(),
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint("event_id", "tag_id", name="uq_event_tag"),
    )

    # 4. tag_suggestions
    op.create_table(
        "tag_suggestions",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("event_id", sa.String(), nullable=False),
        sa.Column(
            "tag_id",
            sa.Integer(),
            sa.ForeignKey("tags.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("free_text", sa.String(), nullable=True),
        sa.Column("status", sa.String(), server_default="pending"),
        sa.Column("submitter_device_id", sa.String(), nullable=True),
        sa.Column("submitter_ip", sa.String(), nullable=True),
        sa.Column("admin_notes", sa.Text(), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(),
            server_default=sa.func.now(),
        ),
    )
    op.create_index("ix_tag_suggestions_event_id", "tag_suggestions", ["event_id"])
    op.create_index("ix_tag_suggestions_status", "tag_suggestions", ["status"])

    # 5b. Add suggested_tag_ids column to event_suggestions
    op.add_column(
        "event_suggestions",
        sa.Column("suggested_tag_ids", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("event_suggestions", "suggested_tag_ids")
    op.drop_table("tag_suggestions")
    op.drop_table("event_tags")
    op.drop_table("tags")
    op.drop_table("tag_groups")
