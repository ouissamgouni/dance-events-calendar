"""add_sync_job_runs

Revision ID: w1x2y3z4a5b6
Revises: v1w2x3y4z5a6
Create Date: 2026-05-04

Persists sync job runs so that:
  - history survives backend restarts,
  - the job-detail drawer can show per-calendar logs/events after the fact.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "w1x2y3z4a5b6"
down_revision: Union[str, None] = "v1w2x3y4z5a6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "sync_job_runs",
        sa.Column("job_id", sa.String(length=64), primary_key=True),
        sa.Column("status", sa.String(length=32), nullable=False, index=True),
        sa.Column(
            "mode", sa.String(length=32), nullable=False, server_default="incremental"
        ),
        sa.Column("since_date", sa.String(), nullable=True),
        sa.Column("started_at", sa.DateTime(), nullable=False, index=True),
        sa.Column("finished_at", sa.DateTime(), nullable=True),
        sa.Column("heartbeat_at", sa.DateTime(), nullable=True),
        sa.Column(
            "abort_requested",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column("warning_message", sa.Text(), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column(
            "totals_json",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "stage_totals_json",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "calendar_statuses_json",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "metadata_json",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )
    op.create_index(
        "ix_sync_job_runs_started_at_desc",
        "sync_job_runs",
        [sa.text("started_at DESC")],
    )


def downgrade() -> None:
    op.drop_index("ix_sync_job_runs_started_at_desc", table_name="sync_job_runs")
    op.drop_table("sync_job_runs")
