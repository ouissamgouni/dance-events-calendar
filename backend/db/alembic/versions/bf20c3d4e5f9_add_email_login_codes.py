"""add email_login_codes table for passwordless email sign-in

Revision ID: bf20c3d4e5f9
Revises: be10c3d4e5f8
Create Date: 2026-07-22

Backing store for the email one-time-code login flow. Stores only the SHA-256
hash of each code (never the plaintext); codes are single-use, short-lived and
attempt-capped.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "bf20c3d4e5f9"
down_revision: Union[str, None] = "be10c3d4e5f8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "email_login_codes",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("email", sa.String(length=255), nullable=False),
        sa.Column("code_hash", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("consumed_at", sa.DateTime(), nullable=True),
        sa.Column(
            "attempt_count",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column("request_ip", sa.String(length=64), nullable=True),
    )
    op.create_index("ix_email_login_codes_email", "email_login_codes", ["email"])
    op.create_index(
        "ix_email_login_codes_created_at", "email_login_codes", ["created_at"]
    )


def downgrade() -> None:
    op.drop_index("ix_email_login_codes_created_at", table_name="email_login_codes")
    op.drop_index("ix_email_login_codes_email", table_name="email_login_codes")
    op.drop_table("email_login_codes")
