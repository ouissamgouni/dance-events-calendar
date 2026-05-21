"""public defaults for managed curators

Revision ID: ad70e8f9a0b1
Revises: ac60d7e8f9a0
Create Date: 2026-05-21

"""

from typing import Union

from alembic import op


revision: str = "ad70e8f9a0b1"
down_revision: Union[str, None] = "ac60d7e8f9a0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE users
        SET share_attendance_default = TRUE,
            share_attendance_default_audience = 'public',
            share_attendance_default_set_by_user = TRUE
        WHERE is_admin_managed = TRUE
        """
    )


def downgrade() -> None:
    pass
