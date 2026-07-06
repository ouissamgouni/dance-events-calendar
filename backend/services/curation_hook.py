"""Post-sync curation hook.

Reads enabled ``CalendarCurationRule`` rows for the calendars touched by
a sync, then auto-adds each newly-synced event to the configured
admin-managed target user's Saved/Going list.

Called from ``SyncService.run_enrichment`` after the enrichment
pipeline completes. Curated Going entries trigger activity notifications
(``fan_out=True``) the same way UI RSVPs do.

Idempotent: re-running on the same (event, rule) pair is a no-op via
``set_event_engagement``.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Iterable, Optional
from uuid import UUID

from sqlmodel import Session, select

from backend.db.models import (
    CachedEvent,
    CalendarCurationRule,
    User,
)
from backend.services.engagement import set_event_engagement

logger = logging.getLogger(__name__)


@dataclass
class CurationHookResult:
    rules_evaluated: int = 0
    rows_changed: int = 0
    rules_skipped_target_invalid: int = 0


def apply_curation_rules(
    session: Session,
    event_ids: Iterable[str],
    *,
    admin_user_id: Optional[UUID] = None,
) -> CurationHookResult:
    """Apply per-calendar curation rules to ``event_ids``.

    Caller commits the session. Rules whose target user no longer
    exists, is soft-deleted, or has been un-flagged ``is_admin_managed``
    are skipped (counted, not raised) so the sync hook never blocks a
    sync over stale configuration.
    """
    result = CurationHookResult()
    event_ids_list = [eid for eid in event_ids if eid]
    if not event_ids_list:
        return result

    events = session.exec(
        select(CachedEvent.event_id, CachedEvent.calendar_id).where(
            CachedEvent.event_id.in_(event_ids_list)
        )
    ).all()
    if not events:
        return result
    events_by_cal: dict[str, list[str]] = {}
    for eid, cal_id in events:
        events_by_cal.setdefault(cal_id, []).append(eid)

    cal_ids = list(events_by_cal.keys())
    rules = session.exec(
        select(CalendarCurationRule).where(
            CalendarCurationRule.calendar_id.in_(cal_ids),
            CalendarCurationRule.enabled.is_(True),
        )
    ).all()
    if not rules:
        return result

    target_ids = {r.target_user_id for r in rules}
    targets = session.exec(select(User).where(User.id.in_(target_ids))).all()
    targets_by_id = {u.id: u for u in targets}

    for rule in rules:
        result.rules_evaluated += 1
        target = targets_by_id.get(rule.target_user_id)
        if (
            target is None
            or target.deleted_at is not None
            or not bool(getattr(target, "is_admin_managed", False))
        ):
            result.rules_skipped_target_invalid += 1
            logger.info("Skipping curation rule %s: target invalid", rule.id)
            continue
        for eid in events_by_cal.get(rule.calendar_id, []):
            res = set_event_engagement(
                session,
                target_user=target,
                event_id=eid,
                kind=rule.kind,  # type: ignore[arg-type]
                action="add",
                audience=rule.audience,  # type: ignore[arg-type]
                fan_out=True,
                created_by_admin_user_id=admin_user_id,
            )
            if res.changed:
                result.rows_changed += 1
    return result
