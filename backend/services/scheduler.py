import asyncio
import functools
import logging

from backend.config.loader import get_sync_interval_minutes
from backend.db.database import get_engine
from backend.db.models import SiteSetting
from backend.services.calendar.base import BaseCalendarService
from backend.services.sync_service import SyncService

from sqlmodel import Session

logger = logging.getLogger(__name__)


def _get_effective_interval(session: Session) -> int:
    """Read sync interval from DB (site_settings), fall back to env/default."""
    try:
        row = session.get(SiteSetting, "sync_interval_minutes")
        if row and row.value.isdigit():
            return int(row.value)
    except Exception:
        pass
    return get_sync_interval_minutes()


def _run_sync(sync_service: SyncService) -> tuple[dict, int]:
    """Run a single sync iteration (called in a thread)."""
    engine = get_engine()
    with Session(engine) as session:
        interval = _get_effective_interval(session) * 60
        stats = sync_service.sync_all(session)
    return stats, interval


async def run_sync_loop(calendar_service: BaseCalendarService) -> None:
    """Background loop that syncs calendars on a configurable interval."""
    sync_service = SyncService(calendar_service)
    loop = asyncio.get_running_loop()

    while True:
        try:
            stats, interval = await loop.run_in_executor(
                None, functools.partial(_run_sync, sync_service)
            )
            logger.info("Sync completed: %s", stats)
        except Exception:
            logger.exception("Sync loop iteration failed")
            interval = get_sync_interval_minutes() * 60

        await asyncio.sleep(interval)
