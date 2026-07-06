import asyncio
import functools
import logging

from backend.config.loader import get_auto_sync_enabled, get_sync_interval_minutes
from backend.db.database import get_engine
from backend.db.models import SiteSetting
from backend.services.calendar.base import BaseCalendarService
from backend.services.sync_job_service import get_sync_job_service

from sqlmodel import Session

logger = logging.getLogger(__name__)

# Dedicated Postgres advisory-lock key for the notification dispatch tick, so
# multi-instance deployments (e.g. staging's min_machines_running = 2) don't
# double-send pushes in the select→send→stamp race. Distinct from the sync
# job's key (0x6D6F7669736E6373 / "movisncs").
_NOTIFY_DISPATCH_ADVISORY_LOCK_KEY = 0x6D6F76696E746679  # "movintfy"


def _get_effective_interval(session: Session) -> int:
    """Read sync interval from DB (site_settings), fall back to env/default."""
    try:
        row = session.get(SiteSetting, "sync_interval_minutes")
        if row and row.value.isdigit():
            return int(row.value)
    except Exception:
        pass
    return get_sync_interval_minutes()


def _get_auto_sync_enabled_setting(session: Session) -> bool:
    """Read auto-sync flag from DB (site_settings), fall back to env/scenario/default."""
    try:
        row = session.get(SiteSetting, "auto_sync_enabled")
        if row:
            return row.value.lower() == "true"
    except Exception:
        pass
    return get_auto_sync_enabled()


def _get_since_date_setting(session: Session) -> str | None:
    """Read the admin-configured ``sync_since_date`` from site_settings (YYYY-MM-DD), or None.

    This is the lower bound used when fetching events from upstream calendars,
    independent from the display-only ``since_date`` setting.
    """
    try:
        row = session.get(SiteSetting, "sync_since_date")
        if row and row.value:
            return row.value
    except Exception:
        pass
    return None


def _get_auto_sync_mode_setting(session: Session) -> str:
    """Read auto_sync_mode from site_settings ('incremental' | 'reseed'), default 'incremental'."""
    try:
        row = session.get(SiteSetting, "auto_sync_mode")
        if row and row.value in {"incremental", "reseed"}:
            return row.value
    except Exception:
        pass
    return "incremental"


def _trigger_scheduled_sync(calendar_service: BaseCalendarService) -> tuple[dict, int]:
    """Trigger a single scheduled sync via SyncJobService (called in a thread)."""
    engine = get_engine()
    with Session(engine) as session:
        interval = _get_effective_interval(session) * 60
        if not _get_auto_sync_enabled_setting(session):
            return {"auto_sync_enabled": False, "skipped": 1}, interval
        since_date = _get_since_date_setting(session)
        mode = _get_auto_sync_mode_setting(session)

    # Late import to avoid circular dependency with backend.api.routes.admin.
    from backend.api.routes.admin import _run_sync_job_worker

    job_service = get_sync_job_service()
    try:
        job = job_service.start_job(
            worker=lambda job_id, service: _run_sync_job_worker(
                job_id, service, calendar_service, mode, since_date
            ),
            mode=mode,
            since_date=since_date,
        )
    except RuntimeError:
        # A job is already running — skip this tick.
        return {"skipped": 1, "reason": "job_already_running"}, interval

    return {
        "job_id": job.get("job_id"),
        "started": True,
        "mode": mode,
        "since_date": since_date,
    }, interval


async def run_sync_loop(calendar_service: BaseCalendarService) -> None:
    """Background loop that triggers a sync job on a configurable interval."""
    loop = asyncio.get_running_loop()

    while True:
        try:
            stats, interval = await loop.run_in_executor(
                None, functools.partial(_trigger_scheduled_sync, calendar_service)
            )
            if stats.get("skipped"):
                logger.info("Auto-sync tick skipped: %s", stats)
            else:
                logger.info("Auto-sync job started: %s", stats)
        except Exception:
            logger.exception("Sync loop iteration failed")
            interval = get_sync_interval_minutes() * 60

        await asyncio.sleep(interval)


class _DispatchLockHeld(Exception):
    """Raised when another instance already holds the dispatch advisory lock."""


def _try_acquire_dispatch_lock():
    """Acquire a Postgres session-level advisory lock on a dedicated
    connection for the notification dispatch tick.

    Returns the connection on success and ``None`` when advisory locking is
    not applicable (non-Postgres dialect), the DB is temporarily unreachable,
    or the lock query fails — in which case the caller proceeds best-effort,
    mirroring ``sync_job_service``. Raises ``_DispatchLockHeld`` only when
    another instance genuinely holds the lock, so the loop lets that instance
    own this tick.
    """
    engine = get_engine()
    if engine.dialect.name != "postgresql":
        return None
    try:
        conn = engine.connect()
    except Exception:
        logger.warning(
            "notification dispatch lock skipped: DB unreachable", exc_info=True
        )
        return None
    try:
        acquired = conn.exec_driver_sql(
            f"SELECT pg_try_advisory_lock({_NOTIFY_DISPATCH_ADVISORY_LOCK_KEY})"
        ).scalar()
    except Exception:
        try:
            conn.close()
        except Exception:
            pass
        logger.warning("notification dispatch lock query failed", exc_info=True)
        return None
    if not acquired:
        try:
            conn.close()
        except Exception:
            pass
        raise _DispatchLockHeld()
    return conn


def _release_dispatch_lock(conn) -> None:
    if conn is None:
        return
    try:
        conn.exec_driver_sql(
            f"SELECT pg_advisory_unlock({_NOTIFY_DISPATCH_ADVISORY_LOCK_KEY})"
        )
    except Exception:
        logger.warning("notification dispatch unlock failed", exc_info=True)
    finally:
        try:
            conn.close()
        except Exception:
            pass


def run_notification_dispatch_once(force_activity_digest: bool = False) -> dict:
    """Run one pass of user-facing notification delivery.

    Generates due event reminders and sends batched activity digest emails.
    Safe to call from the in-app loop (executor thread) or the external
    scheduler endpoint. Each sub-task owns its own DB session/transaction
    and never raises into the caller.

    Guarded by a Postgres advisory lock so that on multi-instance deployments
    only one machine sends per tick; instances that don't win the lock skip
    (return ``{"skipped": "locked"}``) to avoid duplicate pushes/emails.

    ``force_activity_digest`` bypasses the per-user schedule window in the
    activity digest step; used by admin manual triggers so operators can
    flush queued digests on demand.
    """
    # Imported lazily to keep scheduler import-light and avoid any import
    # cycle with the email/notification services.
    from backend.services import activity_email, interest_notification_service, reminder_service

    try:
        lock_conn = _try_acquire_dispatch_lock()
    except _DispatchLockHeld:
        # Another instance owns this tick — skip to avoid duplicate sends.
        return {"skipped": "locked"}

    try:
        stats: dict = {}
        try:
            stats["reminders"] = reminder_service.run_once()
        except Exception:
            logger.exception("Reminder generation failed")
            stats["reminders"] = {"error": True}
        try:
            # Runs before the activity digest so newly created interest_event
            # rows are picked up by the same tick's digest below.
            stats["interest"] = interest_notification_service.run_once()
        except Exception:
            logger.exception("Interest notification generation failed")
            stats["interest"] = {"error": True}
        try:
            stats["activity"] = activity_email.run_once(force=force_activity_digest)
        except Exception:
            logger.exception("Activity digest failed")
            stats["activity"] = {"error": True}
        return stats
    finally:
        _release_dispatch_lock(lock_conn)


async def run_notification_dispatch_loop() -> None:
    """Background loop that delivers reminders + activity digests."""
    from backend.config.loader import get_notification_interval_minutes

    loop = asyncio.get_running_loop()
    while True:
        interval = get_notification_interval_minutes() * 60
        try:
            stats = await loop.run_in_executor(None, run_notification_dispatch_once)
            logger.info("Notification dispatch tick: %s", stats)
        except Exception:
            logger.exception("Notification dispatch loop iteration failed")
        await asyncio.sleep(interval)
