"""Post-request background jobs (push delivery, milestone checks).

Contract that keeps the transport swappable: a job is ``(name, key)`` with a
string key, and every handler reads its state from the DB and is idempotent.
The transport therefore only needs at-least-once delivery with an optional
delay — the in-process queue below today, or a managed queue (QStash,
Cloudflare Queues) whose signed callback calls :func:`run_job`.

The dispatch tick sweeps deliveries a job missed (restart, exhausted retries),
so losing a job only delays delivery: activity kinds for their full age window,
fan-out kinds (schedule publication, promo codes, event changes, suggestion
decisions) for 24h.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from typing import Protocol

logger = logging.getLogger(__name__)


class RetryLater(Exception):
    """Raised by a handler to have the job retried with backoff."""


_HANDLERS: dict[str, Callable[[str], None]] = {}


def register(name: str, handler: Callable[[str], None]) -> None:
    _HANDLERS[name] = handler


def run_job(name: str, key: str) -> None:
    _HANDLERS[name](key)


class JobQueue(Protocol):
    def enqueue(self, name: str, key: str, delay_seconds: float = 0) -> None: ...


class InProcessJobQueue:
    """asyncio-based queue living in the API process.

    Jobs already waiting for the same ``(name, key)`` are coalesced, which is
    what turns the enqueue delay into a per-recipient debounce window.
    """

    max_attempts = 4
    retry_base_seconds = 60.0

    def __init__(self, concurrency: int = 4) -> None:
        self.concurrency = concurrency
        self._loop: asyncio.AbstractEventLoop | None = None
        self._sem: asyncio.Semaphore | None = None
        self._pending: set[tuple[str, str]] = set()
        self._tasks: set[asyncio.Task] = set()

    @property
    def active(self) -> bool:
        return self._loop is not None and not self._loop.is_closed()

    def start(self) -> None:
        self._loop = asyncio.get_running_loop()
        self._sem = asyncio.Semaphore(self.concurrency)

    async def stop(self) -> None:
        self._loop = None
        for task in list(self._tasks):
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._pending.clear()

    def enqueue(self, name: str, key: str, delay_seconds: float = 0) -> None:
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        # Request handlers run in the threadpool, not on the event loop.
        loop.call_soon_threadsafe(self._schedule, name, key, delay_seconds, 1)

    def _schedule(self, name: str, key: str, delay: float, attempt: int) -> None:
        if self._loop is None:
            return
        job = (name, key)
        if attempt == 1 and job in self._pending:
            return
        self._pending.add(job)
        task = self._loop.create_task(self._run(name, key, delay, attempt))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _run(self, name: str, key: str, delay: float, attempt: int) -> None:
        scheduled_at = time.monotonic()
        await asyncio.sleep(delay)
        # Released before running so work enqueued meanwhile gets its own pass.
        self._pending.discard((name, key))
        assert self._sem is not None
        async with self._sem:
            logger.info(
                "Job %s:%s attempt %d starting %.1fs after enqueue (delay %.0fs)",
                name,
                key,
                attempt,
                time.monotonic() - scheduled_at,
                delay,
            )
            try:
                await asyncio.get_running_loop().run_in_executor(
                    None, run_job, name, key
                )
            except RetryLater:
                if attempt < self.max_attempts:
                    backoff = self.retry_base_seconds * 2 ** (attempt - 1)
                    logger.info(
                        "Job %s:%s attempt %d asked to retry in %.0fs",
                        name,
                        key,
                        attempt,
                        backoff,
                    )
                    self._schedule(name, key, backoff, attempt + 1)
                else:
                    logger.warning(
                        "Job %s:%s gave up after %d attempts; left for the sweep",
                        name,
                        key,
                        attempt,
                    )
            except Exception:
                logger.exception("Job %s:%s failed", name, key)


_queue = InProcessJobQueue()


def get_job_queue() -> InProcessJobQueue:
    return _queue


def is_active() -> bool:
    return _queue.active


def enqueue(name: str, key: str, delay_seconds: float = 0) -> None:
    """Best-effort: a no-op when no queue is running (the tick sweeps instead)."""
    _queue.enqueue(name, key, delay_seconds)
