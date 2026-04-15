"""Backfill price fields for existing events that have descriptions but no price data.

Usage:
    python -m backend.scripts.backfill_prices --dry-run
    python -m backend.scripts.backfill_prices --commit
"""

import argparse
import sys

from sqlmodel import Session, select

from backend.db.database import engine
from backend.db.models import CachedEvent
from backend.services.price_extractor import extract_price


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Backfill price data from event descriptions"
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
        help="Actually write price data to the database",
    )
    args = parser.parse_args()

    with Session(engine) as session:
        events = session.exec(
            select(CachedEvent).where(
                CachedEvent.description != None,
                CachedEvent.price_min == None,
                CachedEvent.deleted_at == None,
            )
        ).all()

        total = len(events)
        extracted = 0
        free_count = 0

        for event in events:
            price = extract_price(event.description)
            if price is None:
                continue

            extracted += 1
            if price["is_free"]:
                free_count += 1

            if args.dry_run:
                label = (
                    "FREE"
                    if price["is_free"]
                    else f"{price['currency']} {price['min']}-{price['max']}"
                )
                print(f"  {event.event_id}: {event.title} -> {label}")
            else:
                event.price_min = price["min"]
                event.price_max = price["max"]
                event.price_currency = price["currency"]
                event.price_is_free = price["is_free"]
                session.add(event)

        if args.commit:
            session.commit()

        print(
            f"\nSummary: {total} events scanned, {extracted} prices extracted, {free_count} free events"
        )
        if args.dry_run:
            print("(dry run — no changes written)")


if __name__ == "__main__":
    main()
