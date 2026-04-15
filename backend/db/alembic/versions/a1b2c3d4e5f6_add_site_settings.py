"""add_site_settings

Revision ID: a1b2c3d4e5f6
Revises: eade39d48e73
Create Date: 2026-04-15 12:00:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
import sqlmodel


# revision identifiers, used by Alembic.
revision: str = "a1b2c3d4e5f6"
down_revision: Union[str, None] = "eade39d48e73"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS site_settings (
            key VARCHAR NOT NULL,
            value VARCHAR DEFAULT '' NOT NULL,
            PRIMARY KEY (key)
        )
    """)
    # Seed default since_date (2 years ago from ~now)
    op.execute("""
        INSERT INTO site_settings (key, value) VALUES ('since_date', '2024-04-15')
        ON CONFLICT (key) DO NOTHING
    """)


def downgrade() -> None:
    op.drop_table("site_settings")
