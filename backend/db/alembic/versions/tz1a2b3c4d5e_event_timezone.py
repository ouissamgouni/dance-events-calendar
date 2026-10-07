"""event time zone

Revision ID: tz1a2b3c4d5e
Revises: ad1a2b3c4d5e
Create Date: 2026-10-05

Adds ``timezone`` (IANA name) to ``cached_events`` and ``event_suggestions``
and backfills it from the venue coordinates, falling back to the submitter's
browser zone for suggestions. Google-synced events are refilled on next sync.
"""

from typing import Optional, Union
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import sqlalchemy as sa
from alembic import op
from timezonefinder import TimezoneFinder

revision: str = "tz1a2b3c4d5e"
down_revision: Union[str, None] = "ad1a2b3c4d5e"
branch_labels = None
depends_on = None

TABLES = ("cached_events", "event_suggestions")
_finder: Optional[TimezoneFinder] = None


def valid_timezone(name: Optional[str]) -> Optional[str]:
    if not name:
        return None
    try:
        ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return None
    return name


def tz_for_point(lat: Optional[float], lng: Optional[float]) -> Optional[str]:
    if lat is None or lng is None:
        return None
    global _finder
    _finder = _finder or TimezoneFinder()
    try:
        return valid_timezone(_finder.timezone_at(lat=lat, lng=lng))
    except ValueError:
        return None


def _columns(table: str) -> set[str]:
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}


def upgrade() -> None:
    for table in TABLES:
        if "timezone" not in _columns(table):
            op.add_column(table, sa.Column("timezone", sa.String(64), nullable=True))

    bind = op.get_bind()
    suggestions = sa.table(
        "event_suggestions",
        sa.column("id"),
        sa.column("latitude"),
        sa.column("longitude"),
        sa.column("submitter_timezone"),
        sa.column("timezone"),
    )
    events = sa.table(
        "cached_events",
        sa.column("event_id"),
        sa.column("latitude"),
        sa.column("longitude"),
        sa.column("suggestion_id"),
        sa.column("timezone"),
    )

    by_suggestion: dict = {}
    for row in bind.execute(sa.select(suggestions)).all():
        tz = tz_for_point(row.latitude, row.longitude) or valid_timezone(
            row.submitter_timezone
        )
        by_suggestion[row.id] = tz
        if tz:
            bind.execute(
                suggestions.update()
                .where(suggestions.c.id == row.id)
                .values(timezone=tz)
            )

    rows = bind.execute(
        sa.select(events).where(
            sa.or_(events.c.latitude.is_not(None), events.c.suggestion_id.is_not(None))
        )
    ).all()
    for row in rows:
        tz = tz_for_point(row.latitude, row.longitude) or by_suggestion.get(
            row.suggestion_id
        )
        if tz:
            bind.execute(
                events.update()
                .where(events.c.event_id == row.event_id)
                .values(timezone=tz)
            )


def downgrade() -> None:
    for table in TABLES:
        with op.batch_alter_table(table) as batch:
            batch.drop_column("timezone")
