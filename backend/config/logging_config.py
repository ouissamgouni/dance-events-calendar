"""Application logging configuration.

Configures the root logger so ``logging.getLogger(__name__)`` output from
``backend.*`` modules is actually emitted. Under uvicorn only uvicorn's own
loggers are configured; without this the app's loggers propagate to a root
logger that defaults to WARNING, silently dropping every ``logger.info(...)``.

Level is read from ``LOG_LEVEL`` (default ``info``) — the same env var uvicorn
and the Dockerfile use — so it stays configurable per environment.
"""

from __future__ import annotations

import logging
import os

# Third-party loggers that flood the output at DEBUG. Capped so an app-level
# ``LOG_LEVEL=debug`` stays readable.
_NOISY_LOGGERS = ("sqlalchemy.engine", "httpx", "httpcore")


def configure_logging() -> None:
    """Configure the root logger from ``LOG_LEVEL`` (default ``info``)."""
    level = getattr(
        logging, os.getenv("LOG_LEVEL", "info").strip().upper(), logging.INFO
    )
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        force=True,
    )
    if level <= logging.DEBUG:
        for name in _NOISY_LOGGERS:
            logging.getLogger(name).setLevel(logging.WARNING)
