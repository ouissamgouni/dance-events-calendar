"""merge_social_and_preferences_heads

Revision ID: f2b4fdf1c18d
Revises: aa01b2c3d4e5, bb20c3d4e5f7
Create Date: 2026-05-12 10:44:45.051439

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
import sqlmodel


# revision identifiers, used by Alembic.
revision: str = 'f2b4fdf1c18d'
down_revision: Union[str, None] = ('aa01b2c3d4e5', 'bb20c3d4e5f7')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
