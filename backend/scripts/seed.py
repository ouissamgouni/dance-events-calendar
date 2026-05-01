"""Seed the database with scenario data."""

import argparse
import logging
from pathlib import Path

from sqlmodel import Session

from backend.db.database import get_engine
from backend.db.seed import SCENARIOS_DIR, DatabaseSeeder

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")


def main():
    parser = argparse.ArgumentParser(description="Seed the database")
    parser.add_argument(
        "--scenario",
        default="default",
        help=(
            "Scenario name (folder under scenarios/) or an explicit path. "
            "Defaults to 'default'."
        ),
    )
    args = parser.parse_args()

    # Accept either a bare name (resolved under scenarios/) or an explicit path.
    candidate = Path(args.scenario)
    if candidate.is_absolute() or "/" in args.scenario:
        scenario_dir = candidate
    else:
        scenario_dir = SCENARIOS_DIR / args.scenario

    if not scenario_dir.exists():
        raise FileNotFoundError(f"Scenario directory not found: {scenario_dir}")

    engine = get_engine()
    with Session(engine) as session:
        seeder = DatabaseSeeder(session)
        seeder.seed(scenario_dir)


if __name__ == "__main__":
    main()
