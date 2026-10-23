"""people discovery: suggestion dismissals, people prompt impressions/forces, gates

Revision ID: pd1a2b3c4d5e
Revises: pm1a2b3c4d5e
Create Date: 2026-10-23
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "pd1a2b3c4d5e"
down_revision: Union[str, None] = "pm1a2b3c4d5e"
branch_labels = None
depends_on = None

NEW_COLS = (
    "email_people_suggestions_enabled",
    "push_people_suggestions_enabled",
)


def upgrade() -> None:
    bind = op.get_bind()
    existing = {c["name"] for c in sa.inspect(bind).get_columns("users")}
    for col in NEW_COLS:
        if col not in existing:
            op.add_column(
                "users",
                sa.Column(col, sa.Boolean(), nullable=False, server_default=sa.true()),
            )

    op.create_table(
        "suggestion_dismissals",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("dismissed_user_id", sa.Uuid(), nullable=False),
        sa.Column("dismissed_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["dismissed_user_id"], ["users.id"]),
        sa.UniqueConstraint(
            "user_id", "dismissed_user_id", name="uq_suggestion_dismissal_pair"
        ),
    )
    op.create_index(
        "ix_suggestion_dismissals_user_id", "suggestion_dismissals", ["user_id"]
    )
    op.create_index(
        "ix_suggestion_dismissals_dismissed_user_id",
        "suggestion_dismissals",
        ["dismissed_user_id"],
    )

    op.create_table(
        "people_prompt_impressions",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("shown_at", sa.DateTime(), nullable=False),
        sa.Column("outcome", sa.String(length=16), nullable=False),
        sa.Column("followed_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("forced", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
    )
    op.create_index(
        "ix_people_prompt_impressions_user_id", "people_prompt_impressions", ["user_id"]
    )
    op.create_index(
        "ix_people_prompt_impressions_shown_at",
        "people_prompt_impressions",
        ["shown_at"],
    )

    op.create_table(
        "people_prompt_forces",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("forced_by", sa.String(length=255), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
    )
    op.create_index(
        "ix_people_prompt_forces_user_id",
        "people_prompt_forces",
        ["user_id"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("ix_people_prompt_forces_user_id", table_name="people_prompt_forces")
    op.drop_table("people_prompt_forces")
    op.drop_index(
        "ix_people_prompt_impressions_shown_at", table_name="people_prompt_impressions"
    )
    op.drop_index(
        "ix_people_prompt_impressions_user_id", table_name="people_prompt_impressions"
    )
    op.drop_table("people_prompt_impressions")
    op.drop_index(
        "ix_suggestion_dismissals_dismissed_user_id",
        table_name="suggestion_dismissals",
    )
    op.drop_index(
        "ix_suggestion_dismissals_user_id", table_name="suggestion_dismissals"
    )
    op.drop_table("suggestion_dismissals")
    bind = op.get_bind()
    existing = {c["name"] for c in sa.inspect(bind).get_columns("users")}
    for col in NEW_COLS:
        if col in existing:
            op.drop_column("users", col)
