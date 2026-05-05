"""Endpoints for the privacy-respecting "Who's going" feature.

Visibility rule:
- Logged-out viewers see only the total going count for an event.
- Logged-in viewers see the full breakdown (public / private / total) and
  the list of public attendees, regardless of whether they themselves are
  going. Marking yourself going is only required if you want *your* name
  to appear on the list.
- Private logged-in attendees and anonymous device-only attendees are
  counted but never named.
"""

from collections import defaultdict
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from backend.api.deps import get_current_user_optional
from backend.api.schemas import (
    AttendanceSummaryBatchRequest,
    AttendanceSummaryResponse,
    AttendeeResponse,
)
from backend.db.database import get_session
from backend.db.models import User, UserEventAttendance

router = APIRouter(prefix="/api/events", tags=["attendance"])

# Inline preview attendees included with each summary response, to avoid a
# second round-trip from the event-card avatar stack. The full list endpoint
# returns everyone.
_PREVIEW_LIMIT = 3


def _summarize_for_event(
    session: Session,
    event_id: str,
    viewer: Optional[User],
) -> AttendanceSummaryResponse:
    rows = session.exec(
        select(UserEventAttendance).where(UserEventAttendance.event_id == event_id)
    ).all()

    total = len(rows)
    if viewer is None:
        # Don't telegraph the public/private split to anonymous viewers.
        return AttendanceSummaryResponse(
            event_id=event_id,
            total_going=total,
            can_view_attendees=False,
        )

    public_rows = [r for r in rows if r.share_publicly and r.user_id is not None]
    public_count = len(public_rows)
    viewer_is_sharing = any(r.user_id == viewer.id and r.share_publicly for r in rows)

    preview: list[AttendeeResponse] = []
    if public_rows:
        public_user_ids = [r.user_id for r in public_rows[:_PREVIEW_LIMIT]]
        users = session.exec(select(User).where(User.id.in_(public_user_ids))).all()
        users_by_id = {u.id: u for u in users}
        for row in public_rows[:_PREVIEW_LIMIT]:
            u = users_by_id.get(row.user_id)
            if u is None or u.deleted_at is not None:
                continue
            preview.append(
                AttendeeResponse(
                    user_id=u.id,
                    display_name=u.display_name,
                    avatar_url=u.avatar_url,
                )
            )

    return AttendanceSummaryResponse(
        event_id=event_id,
        total_going=total,
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

    # Resolve every public user in one query for the whole batch.
    public_user_ids: set[UUID] = {
        r.user_id for r in rows if r.share_publicly and r.user_id is not None
    }
    users_by_id: dict[UUID, User] = {}
    if viewer is not None and public_user_ids:
        users = session.exec(
            select(User).where(User.id.in_(list(public_user_ids)))
        ).all()
        users_by_id = {u.id: u for u in users if u.deleted_at is None}

    results: list[AttendanceSummaryResponse] = []
    for event_id in payload.event_ids:
        event_rows = by_event.get(event_id, [])
        total = len(event_rows)
        if viewer is None:
            results.append(
                AttendanceSummaryResponse(
                    event_id=event_id,
                    total_going=total,
                    can_view_attendees=False,
                )
            )
            continue

        public_rows = [
            r for r in event_rows if r.share_publicly and r.user_id is not None
        ]
        viewer_is_sharing = any(
            r.user_id == viewer.id and r.share_publicly for r in event_rows
        )
        preview: list[AttendeeResponse] = []
        for row in public_rows[:_PREVIEW_LIMIT]:
            u = users_by_id.get(row.user_id)
            if u is None:
                continue
            preview.append(
                AttendeeResponse(
                    user_id=u.id,
                    display_name=u.display_name,
                    avatar_url=u.avatar_url,
                )
            )
        results.append(
            AttendanceSummaryResponse(
                event_id=event_id,
                total_going=total,
                public_going=len(public_rows),
                anonymous_going=total - len(public_rows),
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
    """Full public attendee list for an event. Authenticated users only —
    no reciprocity requirement (you don't need to be going to view it)."""
    if viewer is None:
        raise HTTPException(status_code=401, detail="Not authenticated")

    rows = session.exec(
        select(UserEventAttendance)
        .where(
            UserEventAttendance.event_id == event_id,
            UserEventAttendance.share_publicly == True,  # noqa: E712
            UserEventAttendance.user_id.is_not(None),
        )
        .order_by(UserEventAttendance.attending_since.asc())
    ).all()
    if not rows:
        return []

    user_ids = [r.user_id for r in rows]
    users = session.exec(select(User).where(User.id.in_(user_ids))).all()
    users_by_id = {u.id: u for u in users if u.deleted_at is None}

    out: list[AttendeeResponse] = []
    for row in rows:
        u = users_by_id.get(row.user_id)
        if u is None:
            continue
        out.append(
            AttendeeResponse(
                user_id=u.id,
                display_name=u.display_name,
                avatar_url=u.avatar_url,
            )
        )
    return out
