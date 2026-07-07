"""notification_deliveries_cascade

Revision ID: m6n7o8p9q0r1
Revises: l5m6n7o8p9q0
Create Date: 2026-07-07

Fixes a bug introduced by ``l5m6n7o8p9q0_add_notification_deliveries``: the
``notification_deliveries.notification_id`` FK was created without
``ON DELETE CASCADE`` (unlike every other child-of-notifications-style FK in
this codebase, e.g. ``notifications.recipient_user_id``/``actor_user_id`` ->
``users.id``). As soon as a notification acquired a delivery row (which
happens for every ``kind`` via ``record_delivery(..., "app")`` at emit time),
any code path that hard-deletes the parent ``Notification`` row directly —
``withdraw_going`` (Going -> private/off) and
``discard_follow_request_notification`` (follow request approved/declined) —
started raising ``ForeignKeyViolation``. Adds the missing ``ON DELETE
CASCADE`` so deleting a notification also deletes its delivery audit rows.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "m6n7o8p9q0r1"
down_revision: Union[str, None] = "l5m6n7o8p9q0"
branch_labels = None
depends_on = None

_FK_NAME = "notification_deliveries_notification_id_fkey"


def upgrade() -> None:
    with op.batch_alter_table("notification_deliveries") as batch:
        batch.drop_constraint(_FK_NAME, type_="foreignkey")
        batch.create_foreign_key(
            _FK_NAME,
            "notifications",
            ["notification_id"],
            ["id"],
            ondelete="CASCADE",
        )


def downgrade() -> None:
    with op.batch_alter_table("notification_deliveries") as batch:
        batch.drop_constraint(_FK_NAME, type_="foreignkey")
        batch.create_foreign_key(
            _FK_NAME,
            "notifications",
            ["notification_id"],
            ["id"],
        )
