"""Phase 3: calendar curation rules

Per-calendar pipeline rules that auto-add freshly-synced events to the
Saved/Going lists of admin-managed target users. The rule body
(``target_user_id``, ``kind``, optional ``audience``) is small and the
hot path is the post-sync hook in
``backend.services.sync_service.SyncService.run_enrichment`` which reads
all enabled rules for the touched calendars and calls
``set_event_engagement`` per (event, rule) pair (idempotent).

Indexes:
- ``calendar_id`` — hot path lookup per calendar after sync.
- ``target_user_id`` — admin UI lists a curator's active rules.

Foreign keys:
- ``calendar_id`` → ``calendar_settings.calendar_id`` (string PK).
- ``target_user_id`` → ``users.id``.
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "8c2f3d4e5a01"
down_revision = "fb71a8c9d0e1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "calendar_curation_rules",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column(
            "calendar_id",
            sa.String(),
            sa.ForeignKey("calendar_settings.calendar_id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "target_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("kind", sa.String(length=16), nullable=False),  # save|going
        sa.Column("audience", sa.String(length=16), nullable=True),
        sa.Column(
            "enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")
        ),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.UniqueConstraint(
            "calendar_id",
            "target_user_id",
            "kind",
            name="uq_curation_rule_cal_target_kind",
        ),
    )


def downgrade() -> None:
    op.drop_table("calendar_curation_rules")
