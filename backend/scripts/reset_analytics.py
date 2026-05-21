"""Wipe all analytics rows from the configured database. DESTRUCTIVE.

Truncates the six append-only / aggregate analytics tables and resets their
identity sequences. Functional state tables (``user_saved_events``,
``user_event_attendances``, ``share_tokens``) are deliberately left intact —
those represent user choices, not analytics observations.

Safety: refuses to run unless ``CONFIRM=WIPE-<ENV_NAME>`` is set, and prints
the target DB host/name first so the operator can verify.

Usage::

    ENV_NAME=staging \\
    CONFIRM=WIPE-staging \\
    DATABASE_URL=postgresql://... \\
    python -m backend.scripts.reset_analytics
"""

import logging
import os
import sys
from urllib.parse import urlparse

from sqlalchemy import text

from backend.config.loader import get_env_name
from backend.db.database import get_engine

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

# Append-only / aggregate analytics tables. Order does not matter because we
# use TRUNCATE ... CASCADE in a single statement.
ANALYTICS_TABLES = (
    "event_views",
    "event_saves",
    "event_attendances",
    "event_link_clicks",
    "event_exports",
    "share_events",
)


def main() -> int:
    env_name = get_env_name()
    expected = f"WIPE-{env_name}"
    confirm = os.getenv("CONFIRM", "")

    engine = get_engine()
    parsed = urlparse(str(engine.url))
    target = f"{parsed.hostname or '?'}:{parsed.port or '?'}{parsed.path or ''}"

    logger.warning("ENV_NAME=%s — target DB: %s", env_name, target)
    logger.warning("Tables to truncate: %s", ", ".join(ANALYTICS_TABLES))

    if confirm != expected:
        logger.error(
            "Aborting: CONFIRM must be set to %r (got %r). Re-run with "
            "CONFIRM=%s to proceed.",
            expected,
            confirm,
            expected,
        )
        return 2

    statement = "TRUNCATE TABLE {} RESTART IDENTITY CASCADE".format(
        ", ".join(ANALYTICS_TABLES)
    )
    with engine.begin() as conn:
        conn.execute(text(statement))

    logger.info("Done. %d analytics tables truncated.", len(ANALYTICS_TABLES))
    return 0


if __name__ == "__main__":
    sys.exit(main())
