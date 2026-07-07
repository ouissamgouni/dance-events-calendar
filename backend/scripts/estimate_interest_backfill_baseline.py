"""READ-ONLY: report prod migration + baseline data for interest backfill estimate.

Because ``user_interest_profiles`` doesn't yet exist in prod, adapt to the
subset of tables that DO exist and report:
  * current alembic revision
  * count of non-deleted users
  * count of geolocated future events with updated_at within 30/90/180d
  * per-user channel opt-in rate for email_interest_matches / push_interest_matches
  * distribution of future-event tag counts, to bound the "if profiles existed" estimate
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import text
from sqlmodel import Session

from backend.db.database import get_engine


def _utcnow_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def main() -> int:
    now = _utcnow_naive()
    windows = {"30d": 30, "90d": 90, "180d": 180}

    with Session(get_engine()) as session:
        rev = session.exec(
            text("SELECT version_num FROM alembic_version")
        ).first()
        rev_str = rev[0] if rev else "?"

        table_exists = lambda t: session.exec(
            text(
                "SELECT EXISTS (SELECT 1 FROM information_schema.tables "
                "WHERE table_schema='public' AND table_name=:t)"
            ),
            params={"t": t},
        ).first()[0]

        has_uip = table_exists("user_interest_profiles")
        has_uipt = table_exists("user_interest_profile_tags")
        has_notifs = table_exists("notifications")
        has_email_flag = session.exec(
            text(
                "SELECT EXISTS (SELECT 1 FROM information_schema.columns "
                "WHERE table_schema='public' AND table_name='users' "
                "AND column_name='email_interest_matches_enabled')"
            )
        ).first()[0]

        users_total = session.exec(
            text("SELECT count(*) FROM users WHERE deleted_at IS NULL")
        ).first()[0]

        events_geolocated_future = session.exec(
            text(
                "SELECT count(*) FROM cached_events "
                "WHERE deleted_at IS NULL AND is_hidden = false "
                "AND latitude IS NOT NULL AND longitude IS NOT NULL "
                "AND start > :now"
            ),
            params={"now": now},
        ).first()[0]

        window_counts = {}
        for label, days in windows.items():
            since = now - timedelta(days=days)
            n = session.exec(
                text(
                    "SELECT count(*) FROM cached_events "
                    "WHERE deleted_at IS NULL AND is_hidden = false "
                    "AND latitude IS NOT NULL AND longitude IS NOT NULL "
                    "AND start > :now "
                    "AND updated_at > :since AND updated_at <= :now"
                ),
                params={"now": now, "since": since},
            ).first()[0]
            window_counts[label] = n

        # Channel opt-in rate: default is True per model, but this reflects
        # actual current state.
        opt_in_email = opt_in_push = "n/a (column absent)"
        if has_email_flag:
            opt_in_email = session.exec(
                text(
                    "SELECT count(*) FROM users "
                    "WHERE deleted_at IS NULL AND email_interest_matches_enabled = true"
                )
            ).first()[0]
            opt_in_push = session.exec(
                text(
                    "SELECT count(*) FROM users "
                    "WHERE deleted_at IS NULL AND push_interest_matches_enabled = true"
                )
            ).first()[0]

        # Tag-density histogram over the 90d window's events, to bound
        # "typical" match sizes when profiles start being created.
        tag_density = session.exec(
            text(
                "SELECT "
                "  count(*) as ev, "
                "  avg(t.cnt) as mean_tags, "
                "  min(t.cnt) as min_tags, "
                "  max(t.cnt) as max_tags "
                "FROM ("
                "  SELECT ce.event_id, count(et.tag_id) as cnt "
                "  FROM cached_events ce "
                "  LEFT JOIN event_tags et ON et.event_id = ce.event_id "
                "  WHERE ce.deleted_at IS NULL AND ce.is_hidden = false "
                "    AND ce.latitude IS NOT NULL AND ce.start > :now "
                "    AND ce.updated_at > :since AND ce.updated_at <= :now "
                "  GROUP BY ce.event_id"
                ") t"
            ),
            params={"now": now, "since": now - timedelta(days=90)},
        ).first()

        print(f"Alembic revision                : {rev_str}")
        print(f"user_interest_profiles table    : {'YES' if has_uip else 'NO (feature not migrated to prod)'}")
        print(f"user_interest_profile_tags      : {'YES' if has_uipt else 'NO'}")
        print(f"notifications table             : {'YES' if has_notifs else 'NO'}")
        print(f"users.email_interest_matches_enabled column : {'YES' if has_email_flag else 'NO'}")
        print()
        print(f"Users (non-deleted)             : {users_total}")
        print(f"  opt-in email interest matches : {opt_in_email}")
        print(f"  opt-in push  interest matches : {opt_in_push}")
        print()
        print(f"Future geolocated events        : {events_geolocated_future}")
        for label, n in window_counts.items():
            print(f"  updated_at within {label:<5}          : {n}")
        print()
        print("Tag density in 90d window:")
        ev_count = tag_density[0] if tag_density else 0
        print(f"  events tallied                : {ev_count}")
        if ev_count:
            mean_t = tag_density[1] or 0
            min_t = tag_density[2] or 0
            max_t = tag_density[3] or 0
            print(f"  tags per event (min/mean/max) : {min_t} / {float(mean_t):.1f} / {max_t}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
