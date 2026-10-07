"""all-day events submitted through the app use UTC-midnight dates

Revision ID: ad1a2b3c4d5e
Revises: tp1a2b3c4d5e
Create Date: 2026-10-05

The submit form stored all-day events as the submitter's local midnight with
an inclusive end; Google-synced ones are UTC midnight with an exclusive end.
Rewrites the submitted ones (``event_suggestions`` and the ``cached_events``
materialised from them) to the Google shape. Local midnights within ±12h of
UTC round to their own date, so no time zone is needed. Not reversible.
"""

from datetime import datetime, timedelta, timezone
from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "ad1a2b3c4d5e"
down_revision: Union[str, None] = "tp1a2b3c4d5e"
branch_labels = None
depends_on = None


def _as_utc(value) -> datetime:
    if isinstance(value, str):
        value = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _midnight(value) -> datetime:
    day = (_as_utc(value) + timedelta(hours=12)).date()
    return datetime(day.year, day.month, day.day, tzinfo=timezone.utc)


def all_day_bounds(start, end) -> tuple[datetime, datetime]:
    first = _midnight(start)
    return first, max(_midnight(end), first) + timedelta(days=1)


def _store(bind, value: datetime) -> datetime:
    # SQLite columns are naive UTC; Postgres ones are timestamptz.
    return value if bind.dialect.name == "postgresql" else value.replace(tzinfo=None)


def upgrade() -> None:
    bind = op.get_bind()
    suggestions = sa.table(
        "event_suggestions",
        sa.column("id"),
        sa.column("start", sa.DateTime),
        sa.column("end", sa.DateTime),
        sa.column("all_day", sa.Boolean),
        sa.column("recurrence_dates", sa.JSON),
    )
    events = sa.table(
        "cached_events",
        sa.column("event_id"),
        sa.column("start", sa.DateTime),
        sa.column("end", sa.DateTime),
        sa.column("all_day", sa.Boolean),
        sa.column("suggestion_id"),
    )

    rows = bind.execute(
        sa.select(
            suggestions.c.id,
            suggestions.c.start,
            suggestions.c.end,
            suggestions.c.recurrence_dates,
        ).where(suggestions.c.all_day == sa.true())
    ).all()
    for row in rows:
        start, end = all_day_bounds(row.start, row.end)
        values = {"start": _store(bind, start), "end": _store(bind, end)}
        if row.recurrence_dates:
            values["recurrence_dates"] = [
                dict(
                    zip(
                        ("start", "end"),
                        (v.isoformat() for v in all_day_bounds(d["start"], d["end"])),
                    )
                )
                for d in row.recurrence_dates
            ]
        bind.execute(
            suggestions.update().where(suggestions.c.id == row.id).values(**values)
        )

    rows = bind.execute(
        sa.select(events.c.event_id, events.c.start, events.c.end).where(
            events.c.all_day == sa.true(), events.c.suggestion_id.is_not(None)
        )
    ).all()
    for row in rows:
        start, end = all_day_bounds(row.start, row.end)
        bind.execute(
            events.update()
            .where(events.c.event_id == row.event_id)
            .values(start=_store(bind, start), end=_store(bind, end))
        )


def downgrade() -> None:
    pass
