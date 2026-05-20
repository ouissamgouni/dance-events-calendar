"""Admin bulk-curation service.

Wraps ``backend.services.engagement.set_event_engagement`` with:

- the ownership gate (target must be ``is_admin_managed=True`` or the
  admin themselves);
- batch iteration over (target, event) pairs;
- per-pair outcome reporting so the UI can surface partial success.

The route layer in [backend/api/routes/admin.py](backend/api/routes/admin.py)
handles auth (``require_admin``) before delegating here.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Literal, Optional
from uuid import UUID

from sqlmodel import Session, select

from backend.db.models import CachedEvent, User
from backend.services.engagement import (
    EngagementAction,
    EngagementKind,
    set_event_engagement,
)

Audience = Literal["public", "friends", "private"]


@dataclass
class BulkItemResult:
    handle: str
    event_id: str
    status: Literal[
        "changed", "noop", "skipped_not_managed", "skipped_no_user", "skipped_no_event"
    ]
    detail: Optional[str] = None


@dataclass
class BulkResult:
    items: list[BulkItemResult]

    @property
    def changed_count(self) -> int:
        return sum(1 for i in self.items if i.status == "changed")

    @property
    def skipped_count(self) -> int:
        return sum(1 for i in self.items if i.status.startswith("skipped"))


def _eligible_target(user: Optional[User], admin_user_id: Optional[UUID]) -> bool:
    """Ownership gate: only admin-managed accounts (or the admin themselves)
    are valid write targets for curation."""
    if user is None:
        return False
    if bool(getattr(user, "is_admin_managed", False)):
        return True
    return admin_user_id is not None and user.id == admin_user_id


def bulk_set_engagement(
    session: Session,
    *,
    handles: Iterable[str],
    event_ids: Iterable[str],
    kind: EngagementKind,
    action: EngagementAction,
    audience: Optional[Audience] = None,
    fan_out: bool = False,
    admin_user_id: Optional[UUID] = None,
) -> BulkResult:
    """Apply ``(kind, action)`` to the cross-product of handles × event_ids.

    Unknown handles, non-managed targets, and unknown event ids are
    reported as ``skipped_*`` rather than raising — the UI shows a
    per-row breakdown so the admin can fix data and re-run.

    Caller owns the transaction (this only flushes via the underlying
    primitive); the route layer commits once on success.
    """
    handles_list = list(handles)
    event_ids_list = list(event_ids)

    users_by_handle: dict[str, Optional[User]] = {}
    if handles_list:
        rows = session.exec(
            select(User).where(
                User.handle.in_(handles_list),
                User.deleted_at.is_(None),
            )
        ).all()
        for u in rows:
            if u.handle:
                users_by_handle[u.handle] = u

    valid_event_ids: set[str] = set()
    if event_ids_list:
        rows_e = session.exec(
            select(CachedEvent.event_id).where(CachedEvent.event_id.in_(event_ids_list))
        ).all()
        valid_event_ids = {str(r) for r in rows_e}

    items: list[BulkItemResult] = []
    for handle in handles_list:
        user = users_by_handle.get(handle)
        if user is None:
            for eid in event_ids_list:
                items.append(
                    BulkItemResult(
                        handle=handle, event_id=eid, status="skipped_no_user"
                    )
                )
            continue
        if not _eligible_target(user, admin_user_id):
            for eid in event_ids_list:
                items.append(
                    BulkItemResult(
                        handle=handle,
                        event_id=eid,
                        status="skipped_not_managed",
                        detail="Target is not an admin-managed account.",
                    )
                )
            continue
        for eid in event_ids_list:
            if eid not in valid_event_ids:
                items.append(
                    BulkItemResult(
                        handle=handle, event_id=eid, status="skipped_no_event"
                    )
                )
                continue
            res = set_event_engagement(
                session,
                target_user=user,
                event_id=eid,
                kind=kind,
                action=action,
                audience=audience,
                fan_out=fan_out,
                created_by_admin_user_id=admin_user_id,
            )
            items.append(
                BulkItemResult(
                    handle=handle,
                    event_id=eid,
                    status="changed" if res.changed else "noop",
                )
            )
    return BulkResult(items=items)
