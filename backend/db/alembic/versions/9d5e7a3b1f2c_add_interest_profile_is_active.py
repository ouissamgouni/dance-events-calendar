"""add_interest_profile_is_active

Revision ID: 9d5e7a3b1f2c
Revises: 8b3c4d5e6f7a
Create Date: 2026-07-03

Adds ``user_interest_profiles.is_active`` (bool, default false, not null) so
the explorer and For-You rails can default-filter to the user's chosen
"active" profile. Application code enforces "at most one active per user".
Backfill: for each user with any profiles, mark the oldest (min created_at,
then min id) profile as active. Safe to re-run.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "9d5e7a3b1f2c"
down_revision: Union[str, None] = "8b3c4d5e6f7a"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    existing_cols = {c["name"] for c in inspector.get_columns("user_interest_profiles")}
    if "is_active" not in existing_cols:
        op.add_column(
            "user_interest_profiles",
            sa.Column(
                "is_active",
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            ),
        )

    # Backfill: one active per user (the oldest profile). Guarded by
    # NOT EXISTS so re-running the migration doesn't overwrite a user's
    # explicit choice.
    op.execute(
        sa.text(
            """
            UPDATE user_interest_profiles
               SET is_active = TRUE
             WHERE id IN (
                 SELECT MIN(id)
                   FROM user_interest_profiles p
                  WHERE p.user_id = user_interest_profiles.user_id
                  GROUP BY p.user_id
             )
               AND NOT EXISTS (
                   SELECT 1 FROM user_interest_profiles p2
                    WHERE p2.user_id = user_interest_profiles.user_id
                      AND p2.is_active = TRUE
               )
            """
        )
    )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing_cols = {c["name"] for c in inspector.get_columns("user_interest_profiles")}
    if "is_active" in existing_cols:
        with op.batch_alter_table("user_interest_profiles") as batch:
            batch.drop_column("is_active")
