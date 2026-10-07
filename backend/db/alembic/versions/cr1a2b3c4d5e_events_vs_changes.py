"""events vs changes: event statuses new/unpublished, change kinds and outcomes

Revision ID: cr1a2b3c4d5e
Revises: gd1a2b3c4d5e
Create Date: 2026-10-06
"""

import json
from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "cr1a2b3c4d5e"
down_revision: Union[str, None] = "gd1a2b3c4d5e"
branch_labels = None
depends_on = None

_EVENT_STATUS = {"pending": "new", "hidden": "unpublished"}
_GO_PUBLIC = json.dumps({"visibility": {"old": "private", "new": "public"}})


def _rewrite_revisions(bind, status_map: dict, with_kind: bool) -> None:
    rows = bind.execute(sa.text("SELECT id, changes FROM event_revisions")).fetchall()
    for revision_id, changes in rows:
        if isinstance(changes, str):
            changes = json.loads(changes)
        changes = changes or {}
        status = changes.get("status")
        if isinstance(status, dict):
            changes["status"] = {
                key: status_map.get(value, value) for key, value in status.items()
            }
        params = {"id": revision_id, "changes": json.dumps(changes)}
        sql = "UPDATE event_revisions SET changes = CAST(:changes AS json)"
        if with_kind:
            if (changes.get("status") or {}).get("new") == "removed":
                params["kind"] = "remove"
            elif "is_cancelled" in changes:
                params["kind"] = "cancel"
            else:
                params["kind"] = "edit"
            sql += " , kind = :kind"
        bind.execute(sa.text(sql + " WHERE id = :id"), params)


def upgrade() -> None:
    bind = op.get_bind()
    for old, new in _EVENT_STATUS.items():
        op.execute(f"UPDATE cached_events SET status = '{new}' WHERE status = '{old}'")
    op.alter_column("cached_events", "status", server_default="new")
    # Private submissions are live for their owner; going public is the change.
    op.execute(
        "UPDATE cached_events SET status = 'published', review_status = 'reviewed' "
        "WHERE status = 'new' AND visibility = 'private'"
    )

    op.add_column(
        "event_revisions",
        sa.Column("kind", sa.String(length=16), nullable=False, server_default="edit"),
    )
    op.create_index("ix_event_revisions_kind", "event_revisions", ["kind"])
    op.execute(
        "UPDATE event_revisions SET status = 'accepted' WHERE status = 'applied'"
    )
    op.execute(
        "UPDATE event_revisions SET status = 'closed' "
        "WHERE status = 'discarded' AND decided_by = 'system'"
    )
    op.execute(
        "UPDATE event_revisions SET status = 'rejected' WHERE status = 'discarded'"
    )
    _rewrite_revisions(bind, _EVENT_STATUS, with_kind=True)

    op.execute(
        """
        INSERT INTO event_revisions
            (event_id, kind, source, status, changes, notified_count, created_at, updated_at)
        SELECT event_id, 'create',
            CASE WHEN suggestion_id IS NULL THEN 'sync' ELSE 'submitter' END,
            'pending', CAST('{}' AS json), 0, now(), now()
        FROM cached_events
        WHERE status = 'new' AND visibility = 'public'
        """
    )
    op.execute(
        f"""
        INSERT INTO event_revisions
            (suggestion_id, kind, source, status, changes, proposed_by_user_id,
             notified_count, created_at, updated_at)
        SELECT id, 'go_public', 'submitter', 'pending', CAST('{_GO_PUBLIC}' AS json),
            submitter_user_id, 0, created_at, now()
        FROM event_suggestions
        WHERE status = 'pending'
        """
    )


def downgrade() -> None:
    bind = op.get_bind()
    op.execute("DELETE FROM event_revisions WHERE kind IN ('create', 'go_public')")
    op.execute(
        "UPDATE event_revisions SET status = 'applied' WHERE status = 'accepted'"
    )
    op.execute(
        "UPDATE event_revisions SET status = 'discarded' "
        "WHERE status IN ('rejected', 'closed')"
    )
    _rewrite_revisions(bind, {v: k for k, v in _EVENT_STATUS.items()}, with_kind=False)
    op.drop_index("ix_event_revisions_kind", table_name="event_revisions")
    op.drop_column("event_revisions", "kind")
    op.alter_column("cached_events", "status", server_default="pending")
    for old, new in _EVENT_STATUS.items():
        op.execute(f"UPDATE cached_events SET status = '{old}' WHERE status = '{new}'")
