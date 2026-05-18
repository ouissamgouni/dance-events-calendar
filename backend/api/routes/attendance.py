"""Endpoints for the privacy-respecting "Who's going" feature.

Visibility rule:
- Logged-out viewers see only the total going count for an event. Names
  are NEVER shown to anonymous viewers, regardless of audience tier.
- Logged-in viewers see the full breakdown (named / anonymous / total)
  and the list of attendees whose ``share_audience`` admits them
  (``public`` to all signed-in viewers, ``friends`` only to mutual
  followers, ``private`` never named).
- Anonymous device-only attendees (``user_id IS NULL``) are always
  counted but never named.
"""

from collections import defaultdict
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from backend.api.deps import (
    get_current_user_optional,
    is_mutual_follow,
)
from backend.api.schemas import (
    AttendanceSummaryBatchRequest,
    AttendanceSummaryResponse,
    AttendeeResponse,
)
from backend.db.database import get_session
from backend.db.models import User, UserEventAttendance, UserSavedEvent

router = APIRouter(prefix="/api/events", tags=["attendance"])

_PREVIEW_LIMIT = 3


def _row_visible_to(
    session: Session,
    viewer: User,
    row: UserEventAttendance,
) -> bool:
    """Whether ``viewer`` (signed-in, non-None) is allowed to see ``row``'s
    user identity in the attendee list. Anonymous device-only rows
    (``user_id IS NULL``) are never visible. Public always; friends iff
    mutual follow; private never (except the owner sees themselves)."""
    if row.user_id is None:
        return False
    if row.user_id == viewer.id:
        return True
    audience = row.share_audience or "private"
    if audience == "public":
        return True
    if audience == "private":
        return False
    return is_mutual_follow(session, viewer.id, row.user_id)


def _summarize_for_event(
    session: Session,
    event_id: str,
    viewer: Optional[User],
) -> AttendanceSummaryResponse:
    rows = session.exec(
        select(UserEventAttendance).where(UserEventAttendance.event_id == event_id)
    ).all()
    saved_rows = session.exec(
        select(UserSavedEvent).where(UserSavedEvent.event_id == event_id)
    ).all()
    saved_count = len(saved_rows)

    total = len(rows)
    if viewer is None:
        return AttendanceSummaryResponse(
            event_id=event_id,
            total_going=total,
            total_saved=saved_count,
            can_view_attendees=False,
        )

    visible_rows = [r for r in rows if _row_visible_to(session, viewer, r)]
    public_count = len(visible_rows)
    viewer_is_sharing = any(
        r.user_id == viewer.id and (r.share_audience or "private") != "private"
        for r in rows
    )

    preview: list[AttendeeResponse] = []
    if visible_rows:
        preview_user_ids = [r.user_id for r in visible_rows[:_PREVIEW_LIMIT]]
        users = session.exec(select(User).where(User.id.in_(preview_user_ids))).all()
        users_by_id = {u.id: u for u in users}
        for row in visible_rows[:_PREVIEW_LIMIT]:
            u = users_by_id.get(row.user_id)
            if u is None or u.deleted_at is not None:
                continue
            preview.append(
                AttendeeResponse(
                    user_id=u.id,
                    display_name=u.display_name,
                    avatar_url=u.avatar_url,
                    handle=u.handle,
                )
            )

    return AttendanceSummaryResponse(
        event_id=event_id,
        total_going=total,
        total_saved=saved_count,
        public_going=public_count,
        anonymous_going=total - public_count,
        can_view_attendees=True,
        viewer_is_sharing=viewer_is_sharing,
        preview_attendees=preview,
    )


@router.get("/{event_id}/attendance-summary", response_model=AttendanceSummaryResponse)
def get_attendance_summary(
    event_id: str,
    session: Session = Depends(get_session),
    viewer: Optional[User] = Depends(get_current_user_optional),
):
    return _summarize_for_event(session, event_id, viewer)


@router.post("/attendance-summary", response_model=list[AttendanceSummaryResponse])
def get_attendance_summary_batch(
    payload: AttendanceSummaryBatchRequest,
    session: Session = Depends(get_session),
    viewer: Optional[User] = Depends(get_current_user_optional),
):
    """Batch variant used by the event list to populate avatar stacks in a
    single round-trip (avoids N+1 fetches on /attendance-summary)."""
    rows = session.exec(
        select(UserEventAttendance).where(
            UserEventAttendance.event_id.in_(payload.event_ids)
        )
    ).all()
    by_event: dict[str, list[UserEventAttendance]] = defaultdict(list)
    for r in rows:
        by_event[r.event_id].append(r)

    saved_rows = session.exec(
        select(UserSavedEvent).where(UserSavedEvent.event_id.in_(payload.event_ids))
    ).all()
    saved_count_by_event: dict[str, int] = defaultdict(int)
    for r in saved_rows:
        saved_count_by_event[r.event_id] += 1

    candidate_user_ids: set[UUID] = {
        r.user_id
        for r in rows
        if r.user_id is not None and (r.share_audience or "private") != "private"
    }
    users_by_id: dict[UUID, User] = {}
    if viewer is not None and candidate_user_ids:
        users = session.exec(
            select(User).where(User.id.in_(list(candidate_user_ids)))
        ).all()
        users_by_id = {u.id: u for u in users if u.deleted_at is None}

    results: list[AttendanceSummaryResponse] = []
    for event_id in payload.event_ids:
        event_rows = by_event.get(event_id, [])
        total = len(event_rows)
        saved_count = saved_count_by_event.get(event_id, 0)
        if viewer is None:
            results.append(
                AttendanceSummaryResponse(
                    event_id=event_id,
                    total_going=total,
                    total_saved=saved_count,
                    can_view_attendees=False,
                )
            )
            continue

        visible_rows = [r for r in event_rows if _row_visible_to(session, viewer, r)]
        viewer_is_sharing = any(
            r.user_id == viewer.id and (r.share_audience or "private") != "private"
            for r in event_rows
        )
        preview: list[AttendeeResponse] = []
        for row in visible_rows[:_PREVIEW_LIMIT]:
            u = users_by_id.get(row.user_id)
            if u is None:
                continue
            preview.append(
                AttendeeResponse(
                    user_id=u.id,
                    display_name=u.display_name,
                    avatar_url=u.avatar_url,
                    handle=u.handle,
                )
            )
        results.append(
            AttendanceSummaryResponse(
                event_id=event_id,
                total_going=total,
                total_saved=saved_count,
                public_going=len(visible_rows),
                anonymous_going=total - len(visible_rows),
                can_view_attendees=True,
                viewer_is_sharing=viewer_is_sharing,
                preview_attendees=preview,
            )
        )
    return results


@router.get("/{event_id}/attendees", response_model=list[AttendeeResponse])
def get_event_attendees(
    event_id: str,
    session: Session = Depends(get_session),
    viewer: Optional[User] = Depends(get_current_user_optional),
):
    """Full attendee list for an event. Authenticated users only — anonymous
    callers get a 401 (parity with prior behavior).

    Each row's ``share_audience`` decides whether the viewer sees that
    user: ``public`` to anyone signed in, ``friends`` only to mutual
    followers, ``private`` never named.
    """
    if viewer is None:
        raise HTTPException(status_code=401, detail="Not authenticated")

    rows = session.exec(
        select(UserEventAttendance)
        .where(
            UserEventAttendance.event_id == event_id,
            UserEventAttendance.user_id.is_not(None),
        )
        .order_by(UserEventAttendance.attending_since.asc())
    ).all()
    if not rows:
        return []

    visible_rows = [r for r in rows if _row_visible_to(session, viewer, r)]
    if not visible_rows:
        return []

    user_ids = [r.user_id for r in visible_rows]
    users = session.exec(select(User).where(User.id.in_(user_ids))).all()
    users_by_id = {u.id: u for u in users if u.deleted_at is None}

    out: list[AttendeeResponse] = []
    for row in visible_rows:
        u = users_by_id.get(row.user_id)
        if u is None:
            continue
        out.append(
            AttendeeResponse(
                user_id=u.id,
                display_name=u.display_name,
                avatar_url=u.avatar_url,
                handle=u.handle,
            )
        )
    return out
