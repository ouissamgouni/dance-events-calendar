"""Drop all tables and recreate them. DESTRUCTIVE."""

import logging

from sqlmodel import SQLModel

from backend.db.database import get_engine
from backend.db.models import CachedEvent, CalendarSetting, EventView  # noqa: F401

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)


def main():
    engine = get_engine()
    logger.warning("Dropping all tables...")
    SQLModel.metadata.drop_all(engine)
    logger.info("Creating all tables...")
    SQLModel.metadata.create_all(engine)
    logger.info("Done.")


if __name__ == "__main__":
    main()
