"""add_user_digest_email_enabled

Revision ID: d1e2s3t4v5w6
Revises: em01a2b3c4d5
Create Date: 2026-08-10

Combined Digest v2 (H3): adds a master opt-out for the combined activity
digest email, ``users.digest_email_enabled``. Independent of the per-feature
email flags — unchecking it silences the whole digest regardless of which
feature sections are enabled. Defaults on so existing users keep receiving
the digest.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "d1e2s3t4v5w6"
down_revision: Union[str, None] = "em01a2b3c4d5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = {c["name"] for c in inspector.get_columns("users")}
    if "digest_email_enabled" not in existing:
        op.add_column(
            "users",
            sa.Column(
                "digest_email_enabled",
                sa.Boolean(),
                nullable=False,
                server_default=sa.true(),
            ),
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = {c["name"] for c in inspector.get_columns("users")}
    if "digest_email_enabled" in existing:
        op.drop_column("users", "digest_email_enabled")
