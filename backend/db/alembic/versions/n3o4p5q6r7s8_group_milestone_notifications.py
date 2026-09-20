"""group milestone notifications

Revision ID: n3o4p5q6r7s8
Revises: t5e3f4a7b8c9
Create Date: 2026-09-20
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "n3o4p5q6r7s8"
down_revision: Union[str, None] = "t5e3f4a7b8c9"
branch_labels = None
depends_on = None


def _merge_duplicate_interest_notifications(bind) -> None:
    rows = bind.execute(
        sa.text(
            "SELECT id, recipient_user_id, actor_user_id, event_id, created_at, "
            "read_at, emailed_at, instant_emailed_at, pushed_at "
            "FROM notifications "
            "WHERE kind = 'interest_event' AND event_id IS NOT NULL "
            "ORDER BY recipient_user_id, actor_user_id, event_id, created_at, id"
        )
    ).mappings()
    canonical_by_key: dict[tuple, dict] = {}
    for row in rows:
        key = (row["recipient_user_id"], row["actor_user_id"], row["event_id"])
        canonical = canonical_by_key.get(key)
        if canonical is None:
            canonical_by_key[key] = dict(row)
            continue

        bind.execute(
            sa.text(
                "UPDATE notification_deliveries SET notification_id = :canonical_id "
                "WHERE notification_id = :duplicate_id"
            ),
            {"canonical_id": canonical["id"], "duplicate_id": row["id"]},
        )
        channel_values = {
            column: canonical[column] or row[column]
            for column in ("emailed_at", "instant_emailed_at", "pushed_at")
        }
        read_at = (
            canonical["read_at"] or row["read_at"]
            if canonical["read_at"] is not None and row["read_at"] is not None
            else None
        )
        bind.execute(
            sa.text(
                "UPDATE notifications SET read_at = :read_at, emailed_at = :emailed_at, "
                "instant_emailed_at = :instant_emailed_at, pushed_at = :pushed_at "
                "WHERE id = :canonical_id"
            ),
            {
                "canonical_id": canonical["id"],
                "read_at": read_at,
                **channel_values,
            },
        )
        canonical["read_at"] = read_at
        canonical.update(channel_values)
        bind.execute(
            sa.text("DELETE FROM notifications WHERE id = :duplicate_id"),
            {"duplicate_id": row["id"]},
        )


def _drop_dedupe_indexes(inspector) -> None:
    existing_indexes = {
        index["name"] for index in inspector.get_indexes("notifications")
    }
    for name in ("uq_notification_dedupe", "uq_notif_no_event", "uq_notif_subject"):
        if name in existing_indexes:
            op.drop_index(name, table_name="notifications")


def _create_dedupe_indexes() -> None:
    op.create_index(
        "uq_notification_dedupe",
        "notifications",
        ["recipient_user_id", "kind", "actor_user_id", "event_id"],
        unique=True,
        postgresql_where=sa.text("event_id IS NOT NULL"),
        sqlite_where=sa.text("event_id IS NOT NULL"),
    )
    op.create_index(
        "uq_notif_no_event",
        "notifications",
        ["recipient_user_id", "kind", "actor_user_id"],
        unique=True,
        postgresql_where=sa.text("event_id IS NULL AND subject_key IS NULL"),
        sqlite_where=sa.text("event_id IS NULL AND subject_key IS NULL"),
    )
    op.create_index(
        "uq_notif_subject",
        "notifications",
        ["recipient_user_id", "kind", "actor_user_id", "subject_key"],
        unique=True,
        postgresql_where=sa.text("event_id IS NULL AND subject_key IS NOT NULL"),
        sqlite_where=sa.text("event_id IS NULL AND subject_key IS NOT NULL"),
    )


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    notification_columns = {
        column["name"] for column in inspector.get_columns("notifications")
    }
    if "group_key" not in notification_columns:
        op.add_column(
            "notifications", sa.Column("group_key", sa.String(length=64), nullable=True)
        )
        op.create_index("ix_notifications_group_key", "notifications", ["group_key"])

    _merge_duplicate_interest_notifications(bind)

    inspector = sa.inspect(bind)
    unique_constraints = {
        constraint["name"]
        for constraint in inspector.get_unique_constraints("notifications")
    }
    _drop_dedupe_indexes(inspector)
    if "uq_notification_dedupe" in unique_constraints:
        with op.batch_alter_table("notifications") as batch:
            batch.drop_constraint("uq_notification_dedupe", type_="unique")
    _create_dedupe_indexes()


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    notification_columns = {
        column["name"] for column in inspector.get_columns("notifications")
    }
    existing_indexes = {
        index["name"] for index in inspector.get_indexes("notifications")
    }
    if "ix_notifications_group_key" in existing_indexes:
        op.drop_index("ix_notifications_group_key", table_name="notifications")
    if "group_key" in notification_columns:
        op.drop_column("notifications", "group_key")
