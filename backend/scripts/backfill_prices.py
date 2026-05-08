"""Backfill price fields for existing events that have descriptions but no price data.

Usage:
    python -m backend.scripts.backfill_prices --dry-run
    python -m backend.scripts.backfill_prices --commit
    python -m backend.scripts.backfill_prices --commit --re-extract
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
    parser.add_argument(
        "--re-extract",
        action="store_true",
        help=(
            "Also re-extract events that already have a price set "
            "(useful after tightening the price regex). Events whose "
            "description no longer matches will have their price cleared."
        ),
    )
    args = parser.parse_args()

    with Session(engine) as session:
        stmt = select(CachedEvent).where(
            CachedEvent.description != None,
            CachedEvent.deleted_at == None,
        )
        if not args.re_extract:
            stmt = stmt.where(CachedEvent.price_min == None)
        events = session.exec(stmt).all()

        total = len(events)
        extracted = 0
        cleared = 0
        free_count = 0

        for event in events:
            price = extract_price(event.description)
            if price is None:
                if args.re_extract and event.price_min is not None:
                    cleared += 1
                    if args.dry_run:
                        print(f"  CLEAR {event.event_id}: {event.title}")
                    else:
                        event.price_min = None
                        event.price_max = None
                        event.price_currency = None
                        event.price_is_free = False
                        session.add(event)
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
            f"\nSummary: {total} events scanned, {extracted} prices extracted, "
            f"{free_count} free events, {cleared} cleared"
        )
        if args.dry_run:
            print("(dry run — no changes written)")


if __name__ == "__main__":
    main()
