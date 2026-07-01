"""push subscriptions user_id nullable

Revision ID: ca7ab554855a
Revises: d2e3f4a5b6c7
Create Date: 2026-07-01 14:00:36.504499

Web Push is a per-browser/device capability, not an account feature, so
anonymous visitors must be able to subscribe before ever signing in. Makes
``push_subscriptions.user_id`` nullable to allow that; the row is bound to a
user later when the same browser subscribes again post sign-in.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
import sqlmodel


# revision identifiers, used by Alembic.
revision: str = "ca7ab554855a"
down_revision: Union[str, None] = "d2e3f4a5b6c7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column(
        "push_subscriptions",
        "user_id",
        existing_type=sa.Uuid(),
        nullable=True,
    )


def downgrade() -> None:
    op.alter_column(
        "push_subscriptions",
        "user_id",
        existing_type=sa.Uuid(),
        nullable=False,
    )
