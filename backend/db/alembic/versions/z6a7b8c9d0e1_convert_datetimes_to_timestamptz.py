"""convert absolute datetimes to timestamptz

Revision ID: z6a7b8c9d0e1
Revises: z5a6b7c8d9e0
Create Date: 2026-09-27
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "z6a7b8c9d0e1"
down_revision: Union[str, None] = "z5a6b7c8d9e0"
branch_labels = None
depends_on = None


DATETIME_COLUMNS = {
    "users": (
        "created_at",
        "last_visit_at",
        "deleted_at",
        "preferences_set_at",
        "installed_at",
        "onboarded_at",
        "last_digest_sent_at",
    ),
    "blocked_user_identities": ("created_at", "revoked_at"),
    "email_login_codes": ("created_at", "expires_at", "consumed_at"),
    "user_account_merges": ("created_at",),
    "calendar_settings": ("created_at", "updated_at"),
    "calendar_curation_rules": ("created_at",),
    "cached_events": ("start", "end", "updated_at", "deleted_at"),
    "event_schedules": ("created_at", "updated_at"),
    "event_schedule_editors": ("granted_at",),
    "schedule_sessions": ("start", "end", "deleted_at", "created_at", "updated_at"),
    "schedule_publications": ("published_at",),
    "user_plan_sessions": ("added_at",),
    "blocked_events": ("blocked_at",),
    "event_duplicate_groups": ("created_at", "resolved_at"),
    "event_duplicate_scan_log": ("started_at", "finished_at"),
    "event_series": ("created_at", "resolved_at"),
    "event_series_scan_log": ("started_at", "finished_at"),
    "event_calendar_sources": ("created_at",),
    "event_views": ("created_at",),
    "event_saves": ("created_at",),
    "user_saved_events": ("saved_at",),
    "share_tokens": ("created_at",),
    "passport_share_tokens": ("created_at",),
    "sync_logs": ("started_at", "finished_at"),
    "sync_job_runs": ("started_at", "finished_at", "heartbeat_at"),
    "event_suggestions": ("start", "end", "created_at", "reviewed_at"),
    "event_promo_codes": ("expires_at", "reviewed_at", "created_at", "updated_at"),
    "organizer_claims": ("reviewed_at", "created_at", "updated_at"),
    "organizer_claim_events": ("created_at",),
    "event_link_clicks": ("created_at",),
    "event_exports": ("created_at",),
    "tag_groups": ("created_at",),
    "tags": ("created_at",),
    "tag_synonyms": ("created_at",),
    "event_tags": ("created_at",),
    "user_preferred_tags": ("created_at",),
    "user_interest_profiles": ("created_at",),
    "user_interest_profile_tags": ("created_at",),
    "tag_suggestions": ("reviewed_at", "created_at"),
    "event_ratings": ("reviewed_at", "created_at", "updated_at"),
    "event_rating_aspect_scores": ("created_at",),
    "event_rating_aspect_tags": ("created_at",),
    "event_messages": ("deleted_at", "created_at", "updated_at"),
    "event_message_reports": ("created_at", "resolved_at"),
    "user_event_mutes": ("created_at",),
    "event_attendances": ("created_at",),
    "user_event_attendances": ("attending_since",),
    "calendar_default_tags": ("created_at",),
    "share_events": ("created_at",),
    "user_follows": ("created_at",),
    "user_referrals": ("created_at",),
    "calendar_subscriptions": ("created_at",),
    "notifications": (
        "created_at",
        "read_at",
        "emailed_at",
        "pushed_at",
        "instant_emailed_at",
    ),
    "notification_deliveries": ("delivered_at",),
    "push_subscriptions": ("created_at",),
    "user_milestones": ("unlocked_at", "seen_at"),
    "user_consistency_achievements": ("reached_at", "seen_at"),
}


def _alter_columns(*, timezone_enabled: bool) -> None:
    target_type = sa.DateTime(timezone=timezone_enabled)
    for table, columns in DATETIME_COLUMNS.items():
        for column in columns:
            op.alter_column(
                table,
                column,
                existing_type=sa.DateTime(timezone=not timezone_enabled),
                type_=target_type,
                postgresql_using=f"\"{column}\" AT TIME ZONE 'UTC'",
            )


def upgrade() -> None:
    _alter_columns(timezone_enabled=True)


def downgrade() -> None:
    _alter_columns(timezone_enabled=False)
