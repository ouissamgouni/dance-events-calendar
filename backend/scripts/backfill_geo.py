"""Backfill structured city/country for events that have coordinates but no place.

Reverse-geocodes each event's stored latitude/longitude into a
``city`` / ``country`` / ``country_code`` triple. Runs out-of-band (NOT as an
Alembic migration) because it makes throttled external geocoding calls — the
schema columns themselves ship via migration ``c1a2b3c4d5e6``, so a deploy
already has the columns; this script fills them in per environment.

Usage:
    python -m backend.scripts.backfill_geo --dry-run
    python -m backend.scripts.backfill_geo --commit
    python -m backend.scripts.backfill_geo --commit --limit 500
    python -m backend.scripts.backfill_geo --commit --refresh

By default only events missing a ``country`` are processed. Pass ``--refresh``
to re-derive and overwrite the place for events that already have one (repairs
stale city/country left behind by an earlier geocoding run).
"""

import argparse

from sqlmodel import Session, select

from backend.db.database import get_engine
from backend.db.models import CachedEvent
from backend.services.geocoding import reverse_geocode


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Backfill city/country from event coordinates via reverse geocoding"
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would be updated without writing",
    )
    group.add_argument(
        "--commit",
        action="store_true",
        help="Actually write city/country to the database",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Only process the first N matching events (throttle-friendly batches)",
    )
    parser.add_argument(
        "--refresh",
        action="store_true",
        help="Also re-derive events that already have a country, overwriting stale place",
    )
    args = parser.parse_args()

    with Session(get_engine()) as session:
        stmt = select(CachedEvent).where(
            CachedEvent.latitude != None,  # noqa: E711
            CachedEvent.longitude != None,  # noqa: E711
            CachedEvent.deleted_at == None,  # noqa: E711
        )
        if not args.refresh:
            stmt = stmt.where(CachedEvent.country == None)  # noqa: E711
        if args.limit is not None:
            stmt = stmt.limit(args.limit)
        events = session.exec(stmt).all()

        total = len(events)
        resolved = 0
        unresolved = 0

        for event in events:
            place = reverse_geocode(event.latitude, event.longitude)
            if place is None:
                unresolved += 1
                continue
            city, country, country_code = place
            resolved += 1
            if args.dry_run:
                label = ", ".join(p for p in (city, country) if p) or "(no place)"
                print(f"  {event.event_id}: {event.title} -> {label}")
            else:
                # With --refresh, overwrite unconditionally to repair stale place.
                if city and (args.refresh or not event.city):
                    event.city = city
                if country:
                    event.country = country
                if country_code:
                    event.country_code = country_code
                session.add(event)

        if args.commit:
            session.commit()

        print(
            f"\nSummary: {total} events scanned, {resolved} resolved, "
            f"{unresolved} unresolved"
        )
        if args.dry_run:
            print("(dry run — no changes written)")


if __name__ == "__main__":
    main()
