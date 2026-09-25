"""add schedule import external ids

Revision ID: w2x3y4z5a6b7
Revises: v1a2b3c4d5e6
Create Date: 2026-09-24
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "w2x3y4z5a6b7"
down_revision: Union[str, None] = "v1a2b3c4d5e6"
branch_labels = None
depends_on = None


_TABLES = (
    ("schedule_venues", "venue"),
    ("schedule_rooms", "room"),
    ("schedule_levels", "level"),
    ("schedule_activity_types", "activity"),
    ("schedule_sessions", "session"),
)


def upgrade() -> None:
    bind = op.get_bind()
    for table, prefix in _TABLES:
        op.add_column(
            table, sa.Column("external_id", sa.String(length=120), nullable=True)
        )
        if bind.dialect.name == "postgresql":
            id_expr = "id::text"
        else:
            id_expr = "CAST(id AS TEXT)"
        bind.execute(
            sa.text(
                f"UPDATE {table} SET external_id = :prefix || '-' || {id_expr} "
                "WHERE external_id IS NULL"
            ),
            {"prefix": prefix},
        )
        op.create_index(f"ix_{table}_external_id", table, ["external_id"])
        op.create_unique_constraint(
            f"uq_{table}_schedule_external_id",
            table,
            ["schedule_id", "external_id"],
        )
    op.drop_index("uq_notification_dedupe", table_name="notifications")
    op.create_index(
        "uq_notification_dedupe",
        "notifications",
        ["recipient_user_id", "kind", "actor_user_id", "event_id"],
        unique=True,
        postgresql_where=sa.text("event_id IS NOT NULL AND subject_key IS NULL"),
        sqlite_where=sa.text("event_id IS NOT NULL AND subject_key IS NULL"),
    )
    op.create_index(
        "uq_notif_event_subject",
        "notifications",
        ["recipient_user_id", "kind", "actor_user_id", "event_id", "subject_key"],
        unique=True,
        postgresql_where=sa.text("event_id IS NOT NULL AND subject_key IS NOT NULL"),
        sqlite_where=sa.text("event_id IS NOT NULL AND subject_key IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_notif_event_subject", table_name="notifications")
    op.drop_index("uq_notification_dedupe", table_name="notifications")
    op.create_index(
        "uq_notification_dedupe",
        "notifications",
        ["recipient_user_id", "kind", "actor_user_id", "event_id"],
        unique=True,
        postgresql_where=sa.text("event_id IS NOT NULL"),
        sqlite_where=sa.text("event_id IS NOT NULL"),
    )
    for table, _prefix in reversed(_TABLES):
        op.drop_constraint(f"uq_{table}_schedule_external_id", table, type_="unique")
        op.drop_index(f"ix_{table}_external_id", table_name=table)
        op.drop_column(table, "external_id")
