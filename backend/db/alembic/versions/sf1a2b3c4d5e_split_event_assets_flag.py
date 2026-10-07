"""split event_assets_enabled into tickets / memories flags

Revision ID: sf1a2b3c4d5e
Revises: pv1a2b3c4d5e
Create Date: 2026-10-05
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "sf1a2b3c4d5e"
down_revision: Union[str, None] = "pv1a2b3c4d5e"
branch_labels = None
depends_on = None

OLD = "event_assets_enabled"
NEW = ("event_tickets_enabled", "event_memories_enabled")


def upgrade() -> None:
    bind = op.get_bind()
    value = bind.execute(
        sa.text("SELECT value FROM site_settings WHERE key = :k"), {"k": OLD}
    ).scalar()
    if value is not None:
        for key in NEW:
            bind.execute(
                sa.text(
                    "INSERT INTO site_settings (key, value) VALUES (:k, :v) "
                    "ON CONFLICT (key) DO NOTHING"
                ),
                {"k": key, "v": value},
            )
    bind.execute(sa.text("DELETE FROM site_settings WHERE key = :k"), {"k": OLD})


def downgrade() -> None:
    bind = op.get_bind()
    values = [
        bind.execute(
            sa.text("SELECT value FROM site_settings WHERE key = :k"), {"k": key}
        ).scalar()
        for key in NEW
    ]
    if any(v is not None for v in values):
        enabled = any(str(v).lower() == "true" for v in values)
        bind.execute(
            sa.text(
                "INSERT INTO site_settings (key, value) VALUES (:k, :v) "
                "ON CONFLICT (key) DO NOTHING"
            ),
            {"k": OLD, "v": "true" if enabled else "false"},
        )
    bind.execute(
        sa.text("DELETE FROM site_settings WHERE key IN (:a, :b)"),
        {"a": NEW[0], "b": NEW[1]},
    )
