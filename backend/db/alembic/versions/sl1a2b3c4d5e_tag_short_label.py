"""tag short label for compact chips

Revision ID: sl1a2b3c4d5e
Revises: dh1a2b3c4d5e
Create Date: 2026-10-14
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "sl1a2b3c4d5e"
down_revision: Union[str, None] = "dh1a2b3c4d5e"
branch_labels = None
depends_on = None

_DANCE_SHORT_LABELS = {
    "salsa": "Salsa",
    "salsa-on1": "On1",
    "mambo": "On2",
    "cuban": "Cuban",
    "afro-cuban": "Afro",
    "argentine-tango": "Tango",
    "west-coast-swing": "WCS",
    "lindy-hop": "Lindy",
}


def upgrade() -> None:
    op.add_column("tags", sa.Column("short_label", sa.String(length=32), nullable=True))
    conn = op.get_bind()
    for slug, short in _DANCE_SHORT_LABELS.items():
        conn.execute(
            sa.text(
                "UPDATE tags SET short_label = :short WHERE slug = :slug "
                "AND group_id IN (SELECT id FROM tag_groups WHERE slug = 'dance-style')"
            ),
            {"short": short, "slug": slug},
        )


def downgrade() -> None:
    op.drop_column("tags", "short_label")
