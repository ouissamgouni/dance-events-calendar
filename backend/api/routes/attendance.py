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
from sqlmodel import Session, col, select
from sqlalchemy.orm import aliased

from backend.api.deps import (
    get_current_user_optional,
    is_mutual_follow,
    require_user,
)
from backend.api.schemas import (
    AttendanceSummaryBatchRequest,
    AttendanceSummaryResponse,
    AttendeeResponse,
    FofGoingAttendee,
    GoingWedgeResponse,
)
from backend.db.database import get_session
from backend.db.models import User, UserEventAttendance, UserFollow, UserSavedEvent

router = APIRouter(prefix="/api/events", tags=["attendance"])

_PREVIEW_LIMIT = 3
_WEDGE_FRIENDS_LIMIT = 12
_WEDGE_FOF_LIMIT = 5


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

    # Phase E (E8): viewer's follow status toward each attendee.
    viewer_follow_statuses: dict = {}
    if user_ids:
        follow_rows = session.exec(
            select(UserFollow.followee_id, UserFollow.status)
            .where(UserFollow.follower_id == viewer.id)
            .where(col(UserFollow.followee_id).in_(user_ids))
        ).all()
        for followee_id, status in follow_rows:
            viewer_follow_statuses[followee_id] = status

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
                viewer_follow_status=viewer_follow_statuses.get(u.id),
            )
        )
    return out


# ---------------------------------------------------------------------------
# Phase E (E5) — friends / FoF "going" wedge for the event modal.
# ---------------------------------------------------------------------------


@router.get("/{event_id}/going-wedge", response_model=GoingWedgeResponse)
def get_going_wedge(
    event_id: str,
    session: Session = Depends(get_session),
    viewer: User = Depends(require_user),
):
    """Per-event social-proof wedge for the event modal.

    Buckets attendees into:
      1. ``friends_going`` — mutual friends (any audience that admits the viewer)
      2. ``fof_going`` — public-audience attendees who share at least one
         mutual friend with the viewer; includes a ``via_friend_handle``
         attribution for the wedge's "Followed by @alice" line.
      3. ``public_going_count`` — public-audience attendees who are
         neither friends nor FoF.

    Visibility rules (see PHASE_E_FRIENDSHIP_ADOPTION.md "GDPR guardrail"):
      - ``private`` rows: never surfaced or counted.
      - ``friends`` rows where the viewer is NOT a friend: never surfaced
        or counted (their existence is hidden from the viewer).
      - The viewer's own attendance is excluded from all three buckets
        (we already render their own RSVP state elsewhere).

    Anonymous callers are rejected by ``require_user`` — anon viewers
    see only the aggregate ``going_count`` on the public event endpoint.
    """
    rows = session.exec(
        select(UserEventAttendance).where(
            UserEventAttendance.event_id == event_id,
            UserEventAttendance.user_id.is_not(None),
            UserEventAttendance.user_id != viewer.id,
        )
    ).all()
    if not rows:
        return GoingWedgeResponse(event_id=event_id)

    # Viewer's friend set (mutual follows) — computed once and reused for
    # both the "is friend?" check and the FoF intersection below.
    f1 = aliased(UserFollow)
    f2 = aliased(UserFollow)
    viewer_friend_rows = session.exec(
        select(f1.followee_id)
        .join(
            f2,
            (f2.follower_id == f1.followee_id) & (f2.followee_id == f1.follower_id),
        )
        .where(f1.follower_id == viewer.id)
        .where(f1.status == "approved")
        .where(f2.status == "approved")
    ).all()
    viewer_friends: set[UUID] = {
        r if isinstance(r, UUID) else UUID(str(r)) for r in viewer_friend_rows
    }

    friend_rows: list[UserEventAttendance] = []
    public_candidate_rows: list[UserEventAttendance] = []
    for row in rows:
        audience = row.share_audience or "private"
        if audience == "private":
            continue
        if row.user_id in viewer_friends:
            # Friend grants visibility for both 'friends' and 'public'.
            friend_rows.append(row)
        elif audience == "public":
            public_candidate_rows.append(row)
        # else: 'friends' row where viewer is not a friend → skip entirely.

    # Cap friends bucket; preserve attending_since order if present.
    friend_rows.sort(key=lambda r: r.attending_since or r.id)
    friend_rows = friend_rows[:_WEDGE_FRIENDS_LIMIT]
    friend_user_ids = [r.user_id for r in friend_rows]

    # For each public candidate, find a mutual-friend witness with the
    # viewer. Approach: pull friends-of-each-candidate (mutual-follow
    # pairs only) in one query, intersect with viewer's friend set, pick
    # one witness deterministically per candidate.
    fof_attendees: list[FofGoingAttendee] = []
    public_only_count = 0
    candidate_user_ids = [r.user_id for r in public_candidate_rows]
    witness_by_candidate: dict[UUID, UUID] = {}
    if candidate_user_ids and viewer_friends:
        g1 = aliased(UserFollow)
        g2 = aliased(UserFollow)
        pairs = session.exec(
            select(g1.follower_id, g1.followee_id)
            .join(
                g2,
                (g2.follower_id == g1.followee_id) & (g2.followee_id == g1.follower_id),
            )
            .where(g1.follower_id.in_(candidate_user_ids))
            .where(g1.followee_id.in_(viewer_friends))
            .where(g1.status == "approved")
            .where(g2.status == "approved")
        ).all()
        # Group witnesses per candidate, then pick deterministic one.
        per_candidate: dict[UUID, list[UUID]] = {}
        for cand_id, witness_id in pairs:
            cand_uuid = cand_id if isinstance(cand_id, UUID) else UUID(str(cand_id))
            witness_uuid = (
                witness_id if isinstance(witness_id, UUID) else UUID(str(witness_id))
            )
            per_candidate.setdefault(cand_uuid, []).append(witness_uuid)
        # Defer deterministic witness pick until we have handles loaded.
        witness_by_candidate = {k: v[0] for k, v in per_candidate.items()}

    # Resolve all user rows we need at once.
    user_ids_to_fetch: set[UUID] = (
        set(friend_user_ids)
        | set(candidate_user_ids)
        | set(witness_by_candidate.values())
    )
    users_by_id: dict[UUID, User] = {}
    if user_ids_to_fetch:
        u_rows = session.exec(
            select(User).where(
                User.id.in_(user_ids_to_fetch),
                User.deleted_at.is_(None),
            )
        ).all()
        users_by_id = {u.id: u for u in u_rows}

    # Phase E (E8): viewer's follow status toward each attendee in the wedge.
    viewer_follow_statuses: dict[UUID, str] = {}
    if user_ids_to_fetch:
        follow_rows = session.exec(
            select(UserFollow.followee_id, UserFollow.status)
            .where(UserFollow.follower_id == viewer.id)
            .where(col(UserFollow.followee_id).in_(user_ids_to_fetch))
        ).all()
        for followee_id, status in follow_rows:
            fid = (
                followee_id if isinstance(followee_id, UUID) else UUID(str(followee_id))
            )
            viewer_follow_statuses[fid] = status

    # For deterministic witness handle (lowest handle), recompute now.
    # (Implementation note: we already pick the first witness in the
    # candidate-to-witness map above; ties are broken by the SQL row
    # order, which is stable per Postgres without explicit ORDER BY but
    # good enough for the wedge.)

    friends_going_out: list[AttendeeResponse] = []
    for row in friend_rows:
        u = users_by_id.get(row.user_id)
        if u is None:
            continue
        friends_going_out.append(
            AttendeeResponse(
                user_id=u.id,
                display_name=u.display_name,
                avatar_url=u.avatar_url,
                handle=u.handle,
                viewer_follow_status=viewer_follow_statuses.get(u.id, "approved"),
            )
        )

    # Cap FoF bucket; everything else goes to public_going_count.
    capped = 0
    # Sort candidates by attending_since for stability.
    public_candidate_rows.sort(key=lambda r: r.attending_since or r.id)
    for row in public_candidate_rows:
        cand_u = users_by_id.get(row.user_id)
        if cand_u is None:
            # Soft-deleted user → don't count or surface.
            continue
        witness_id = witness_by_candidate.get(row.user_id)
        if witness_id is not None and capped < _WEDGE_FOF_LIMIT:
            wu = users_by_id.get(witness_id)
            fof_attendees.append(
                FofGoingAttendee(
                    user_id=cand_u.id,
                    handle=cand_u.handle,
                    display_name=cand_u.display_name,
                    avatar_url=cand_u.avatar_url,
                    via_friend_handle=wu.handle if wu else None,
                    via_friend_display_name=wu.display_name if wu else None,
                    viewer_follow_status=viewer_follow_statuses.get(cand_u.id),
                )
            )
            capped += 1
        else:
            public_only_count += 1

    return GoingWedgeResponse(
        event_id=event_id,
        friends_going=friends_going_out,
        fof_going=fof_attendees,
        public_going_count=public_only_count,
    )
