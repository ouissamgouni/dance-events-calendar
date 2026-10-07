import asyncio
import functools
import logging
import time
from datetime import datetime, timedelta, timezone

from backend.config.loader import get_auto_sync_enabled, get_sync_interval_minutes
from backend.db.database import get_engine
from backend.db.models import SiteSetting
from backend.services.calendar.base import BaseCalendarService
from backend.services.sync_job_service import get_sync_job_service

from sqlmodel import Session

logger = logging.getLogger(__name__)

# Dedicated Postgres advisory-lock key for the notification dispatch tick, so
# multi-instance deployments don't
# double-send pushes in the select→send→stamp race. Distinct from the sync
# job's key (0x6D6F7669736E6373 / "movisncs").
_NOTIFY_DISPATCH_ADVISORY_LOCK_KEY = 0x6D6F76696E746679  # "movintfy"

_DAILY_SECONDS = 24 * 60 * 60
# Minimum seconds between runs of a dispatch sub-job when the loop respects
# cadence; unlisted jobs run every tick. One tick = one DB wake-up on Neon.
_DISPATCH_JOB_MIN_INTERVAL_SECONDS = {
    "milestone": _DAILY_SECONDS,
    "recurrence": _DAILY_SECONDS,
    "suggestion_images": _DAILY_SECONDS,
    "event_tickets": _DAILY_SECONDS,
    "data_retention": _DAILY_SECONDS,
    "ticket_prompt": 30 * 60,
    "memories_prompt": 30 * 60,
}
_dispatch_last_run: dict[str, float] = {}


def _dispatch_job_due(name: str) -> bool:
    last = _dispatch_last_run.get(name)
    interval = _DISPATCH_JOB_MIN_INTERVAL_SECONDS.get(name, 0)
    return last is None or time.monotonic() - last >= interval


# Older undelivered fan-out rows are stale news or channel-disabled; leave them.
_FANOUT_SWEEP_MAX_AGE = timedelta(hours=24)


def sweep_fanout_jobs() -> dict:
    """Re-run fan-out delivery jobs whose rows are still undelivered (a job
    lost to a restart or exhausted retries). Handlers skip stamped rows."""
    from sqlmodel import or_, select

    from backend.api.routes import promo_codes, schedules, suggestions
    from backend.db.models import EventPromoCode, Notification
    from backend.services import event_revisions, job_queue

    decision_kinds = tuple(suggestions._DECISION_STATUS)
    change_kinds = (event_revisions.EVENT_CHANGED, event_revisions.EVENT_CANCELLED)
    email_only_kinds = (*change_kinds, *decision_kinds)
    both_kinds = (*schedules._PUBLICATION_KINDS, promo_codes.PROMO_CODE_ADDED)
    cutoff = datetime.now(timezone.utc) - _FANOUT_SWEEP_MAX_AGE
    jobs: set[tuple[str, str]] = set()
    promo_refs: set[tuple[str, str | None]] = set()
    with Session(get_engine()) as session:
        rows = session.exec(
            select(Notification).where(
                Notification.created_at >= cutoff,
                or_(
                    Notification.kind.in_(email_only_kinds)  # type: ignore[union-attr]
                    & Notification.emailed_at.is_(None),  # type: ignore[union-attr]
                    Notification.kind.in_(both_kinds)  # type: ignore[union-attr]
                    & (
                        Notification.emailed_at.is_(None)  # type: ignore[union-attr]
                        | Notification.pushed_at.is_(None)  # type: ignore[union-attr]
                    ),
                ),
            )
        ).all()
        for row in rows:
            prefix, _, ref = (row.subject_key or "").partition(":")
            if row.kind in schedules._PUBLICATION_KINDS and prefix == "publication":
                jobs.add((schedules.PUBLICATION_DELIVERY_JOB, f"{row.event_id}:{ref}"))
            elif row.kind in change_kinds and prefix == "revision":
                jobs.add((event_revisions.CHANGE_EMAILS_JOB, ref))
            elif row.kind in decision_kinds and prefix == "suggestion":
                jobs.add((suggestions.SUGGESTION_DECISION_JOB, f"{ref}:{row.kind}"))
            elif row.kind == promo_codes.PROMO_CODE_ADDED and row.event_id:
                promo_refs.add((row.event_id, row.context))
        for event_id, code in promo_refs:
            promo_id = session.exec(
                select(EventPromoCode.id).where(
                    EventPromoCode.event_id == event_id,
                    EventPromoCode.code == code,
                    EventPromoCode.status == "approved",
                )
            ).first()
            if promo_id is not None:
                jobs.add((promo_codes.PROMO_CODE_ADDED_JOB, str(promo_id)))
    failed = 0
    for name, key in sorted(jobs):
        try:
            job_queue.run_job(name, key)
        except Exception:
            failed += 1
            logger.exception("Fan-out sweep job %s:%s failed", name, key)
    return {"jobs": len(jobs), "failed": failed}


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


def _log_effective_gates() -> None:
    """DEBUG-log the resolved (DB-override-or-env) notification gates at
    the start of each dispatch tick. Enable DEBUG logging to see exactly
    which gate/schedule value the running instance is using without
    needing DB access — the #1 cause of "nothing happened" tickets is a
    gate or schedule the operator didn't realize was already set."""
    if not logger.isEnabledFor(logging.DEBUG):
        return
    try:
        from backend.services.app_settings import (
            get_event_reminders_enabled,
            get_activity_digest_email_enabled,
            get_interest_match_notifications_enabled,
            get_web_push_enabled,
            get_activity_digest_schedule,
            get_reminder_lead_hours,
        )
        from backend.config.loader import get_scheduler_tick_minutes

        logger.debug(
            "Effective notification gates: reminders=%s (lead_hours=%s) "
            "activity_email=%s (schedule=%r) interest=%s web_push=%s "
            "tick_minutes=%s",
            get_event_reminders_enabled(),
            get_reminder_lead_hours(),
            get_activity_digest_email_enabled(),
            get_activity_digest_schedule(),
            get_interest_match_notifications_enabled(),
            get_web_push_enabled(),
            get_scheduler_tick_minutes(),
        )
    except Exception:
        logger.debug("Effective notification gates: failed to resolve", exc_info=True)


def run_notification_dispatch_once(
    force_activity_digest: bool = False,
    *,
    respect_cadence: bool = False,
    source: str = "admin",
) -> dict:
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

    ``respect_cadence`` (the in-app loop) skips sub-jobs that ran more
    recently than their ``_DISPATCH_JOB_MIN_INTERVAL_SECONDS``; manual
    triggers run everything. ``source`` is recorded on delivery-log rows.
    """
    # Imported lazily to keep scheduler import-light and avoid any import
    # cycle with the email/notification services.
    from backend.services import (
        activity_email,
        data_retention,
        event_asset_prompts,
        event_assets,
        event_images,
        interest_notification_service,
        milestone_notification_service,
        recurrence_extension,
        reminder_service,
        review_prompt_service,
    )

    _log_effective_gates()

    try:
        lock_conn = _try_acquire_dispatch_lock()
    except _DispatchLockHeld:
        # Another instance owns this tick — skip to avoid duplicate sends.
        return {"skipped": "locked"}

    try:
        # Interest runs before activity so new interest_event rows ship this tick.
        jobs = (
            ("reminders", reminder_service.run_once, "Reminder generation failed"),
            ("fanout", sweep_fanout_jobs, "Fan-out delivery sweep failed"),
            (
                "review_prompt",
                review_prompt_service.run_once,
                "Review prompt generation failed",
            ),
            (
                "ticket_prompt",
                event_asset_prompts.run_ticket_prompts,
                "Ticket prompt generation failed",
            ),
            (
                "memories_prompt",
                event_asset_prompts.run_memories_prompts,
                "Memories prompt generation failed",
            ),
            (
                "milestone",
                milestone_notification_service.run_once,
                "Milestone notification generation failed",
            ),
            (
                "interest",
                interest_notification_service.run_once,
                "Interest notification generation failed",
            ),
            (
                "activity",
                functools.partial(
                    activity_email.run_once, force=force_activity_digest, source=source
                ),
                "Activity digest failed",
            ),
            (
                "recurrence",
                recurrence_extension.run_once,
                "Recurring series extension failed",
            ),
            (
                "suggestion_images",
                event_images.run_sweep_once,
                "Suggestion image sweep failed",
            ),
            (
                "event_tickets",
                event_assets.run_sweep_once,
                "Event ticket sweep failed",
            ),
            (
                "data_retention",
                data_retention.run_once,
                "Data retention sweep failed",
            ),
        )
        stats: dict = {}
        for name, run, error_message in jobs:
            if respect_cadence and not _dispatch_job_due(name):
                stats[name] = {"skipped": "not_due"}
                continue
            _dispatch_last_run[name] = time.monotonic()
            try:
                stats[name] = run()
            except Exception:
                logger.exception(error_message)
                stats[name] = {"error": True}
        return stats
    finally:
        _release_dispatch_lock(lock_conn)


async def run_notification_dispatch_loop() -> None:
    """Background loop that delivers reminders + activity digests."""
    from backend.config.loader import (
        get_notification_debounce_seconds,
        get_scheduler_tick_minutes,
    )
    from backend.services import job_queue

    queue = job_queue.get_job_queue()
    logger.info(
        "Notification scheduler: tick=%d min, delivery debounce=%.0fs, job queue "
        "concurrency=%d max_attempts=%d retry_base=%.0fs, job min intervals=%s",
        get_scheduler_tick_minutes(),
        get_notification_debounce_seconds(),
        queue.concurrency,
        queue.max_attempts,
        queue.retry_base_seconds,
        _DISPATCH_JOB_MIN_INTERVAL_SECONDS,
    )
    loop = asyncio.get_running_loop()
    dispatch = functools.partial(
        run_notification_dispatch_once, respect_cadence=True, source="tick"
    )
    while True:
        tick_minutes = get_scheduler_tick_minutes()
        started = time.monotonic()
        try:
            stats = await loop.run_in_executor(None, dispatch)
            logger.info(
                "Notification dispatch tick took %.1fs, next in %d min: %s",
                time.monotonic() - started,
                tick_minutes,
                stats,
            )
        except Exception:
            logger.exception("Notification dispatch loop iteration failed")
        await asyncio.sleep(tick_minutes * 60)
