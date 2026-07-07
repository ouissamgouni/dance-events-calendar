"""add onboarding_version and last_digest_sent_at to users

Revision ID: h3i4j5k6l7m8
Revises: g2h3i4j5k6l7
Create Date: 2026-07-06

Two additions in one migration since both are small ``users`` columns
and both ship in the same PR:

1. ``users.onboarding_version`` (int, default 0, NOT NULL) — bump the
   server-side ``CURRENT_ONBOARDING_VERSION`` constant to force
   existing users back through the wizard. Existing users with
   ``onboarded_at IS NOT NULL`` are backfilled to version 1; the new
   constant lands at 2, so they will be prompted once on their next
   signed-in navigation.

2. ``users.last_digest_sent_at`` (datetime, nullable) — activity
   digest scheduler uses this to enforce twice-a-week cadence
   (see ``activity_email.run_once``). NULL means no digest ever sent.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "h3i4j5k6l7m8"
down_revision: Union[str, None] = "g2h3i4j5k6l7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = {c["name"] for c in inspector.get_columns("users")}

    if "onboarding_version" not in existing:
        op.add_column(
            "users",
            sa.Column(
                "onboarding_version",
                sa.Integer(),
                nullable=False,
                server_default="0",
            ),
        )
        # Backfill: users who already finished onboarding are at v1.
        op.execute(
            "UPDATE users SET onboarding_version = 1 WHERE onboarded_at IS NOT NULL"
        )
        # Drop the server_default now that all rows have a value; new
        # inserts go through SQLAlchemy which supplies the model default.
        with op.batch_alter_table("users") as batch_op:
            batch_op.alter_column("onboarding_version", server_default=None)

    if "last_digest_sent_at" not in existing:
        op.add_column(
            "users",
            sa.Column("last_digest_sent_at", sa.DateTime(), nullable=True),
        )


def downgrade() -> None:
    with op.batch_alter_table("users") as batch_op:
        batch_op.drop_column("last_digest_sent_at")
        batch_op.drop_column("onboarding_version")
