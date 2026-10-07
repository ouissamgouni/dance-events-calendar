"""Changes to public events proposed by signed-in users.

Anyone signed in suggests a change that waits for an admin. The event's
organizer also goes through review, and alone may request a cancellation.
Both are ``EventRevision`` rows so the admin history and attendee
notifications work the same as for other sources.
"""

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from slowapi import Limiter
from sqlmodel import Session, and_, col, func, or_, select

from backend.api.deps import require_user
from backend.api.rate_limit import client_ip
from backend.api.schemas import EventChangeCreate, OwnEventChangeResponse
from backend.db.database import get_session
from backend.db.models import BlockedEvent, CachedEvent, EventRevision, User
from backend.services import event_revisions
from backend.services.event_visibility import event_is_user_facing
from backend.services.recurrence import normalize_all_day

router = APIRouter(tags=["event-changes"])

limiter = Limiter(key_func=client_ip)

MAX_OPEN_CHANGES = 10
USER_FIELDS = event_revisions.REVISABLE_FIELDS + ("latitude", "longitude")


def _changes(
    session: Session, event: CachedEvent, body: EventChangeCreate, *, organizer: bool
) -> dict:
    data = body.model_dump(exclude_unset=True)
    tag_ids = data.pop("tag_ids", None)
    data.pop("suggested_new_tags", None)
    if not organizer and set(event_revisions.CANCEL_FIELDS) & data.keys():
        raise HTTPException(
            status_code=403, detail="Only the event's organizer can cancel it"
        )
    if data.get("all_day", event.all_day) and {"start", "end", "all_day"} & data.keys():
        data["start"], data["end"] = normalize_all_day(
            data.get("start", event.start), data.get("end", event.end)
        )
    changes = {}
    for field in USER_FIELDS + event_revisions.CANCEL_FIELDS:
        if field not in data:
            continue
        old = event_revisions.to_json(getattr(event, field))
        new = event_revisions.to_json(data[field])
        if new != old:
            changes[field] = {"old": old, "new": new}
    if tag_ids is not None:
        old_tags = event_revisions.current_tag_ids(session, event.event_id)
        try:
            new_tags = sorted(
                event_revisions.validate_tag_ids(session, tag_ids, old_tags)
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        if new_tags != old_tags:
            changes[event_revisions.TAG_FIELD] = {"old": old_tags, "new": new_tags}
    start = changes.get("start", {}).get("new") or event_revisions.to_json(event.start)
    end = changes.get("end", {}).get("new") or event_revisions.to_json(event.end)
    if end <= start:
        raise HTTPException(status_code=422, detail="End must be after start")
    if "title" in changes and not (changes["title"]["new"] or "").strip():
        raise HTTPException(status_code=422, detail="title is required")
    return changes


def _open_changes(session: Session, user_id, event_id: str | None = None) -> int:
    # Withdrawing and resending within a day still counts against the limit.
    since = datetime.now(timezone.utc) - timedelta(days=1)
    stmt = select(func.count()).where(
        EventRevision.proposed_by_user_id == user_id,
        EventRevision.source == event_revisions.SOURCE_USER,
        or_(
            EventRevision.status == event_revisions.STATUS_PENDING,
            and_(
                EventRevision.status == event_revisions.STATUS_WITHDRAWN,
                EventRevision.created_at >= since,
            ),
        ),
    )
    if event_id is not None:
        stmt = select(func.count()).where(
            EventRevision.proposed_by_user_id == user_id,
            EventRevision.source == event_revisions.SOURCE_USER,
            EventRevision.status == event_revisions.STATUS_PENDING,
            EventRevision.event_id == event_id,
        )
    return session.exec(stmt).one()


def _own_response(session: Session, revision: EventRevision) -> OwnEventChangeResponse:
    event = session.get(CachedEvent, revision.event_id)
    return OwnEventChangeResponse(
        id=revision.id,
        event_id=revision.event_id,
        event_title=event.title if event else None,
        source=revision.source,
        status=revision.status,
        changes=revision.changes,
        created_at=revision.created_at,
        decided_at=revision.decided_at,
    )


@router.post(
    "/api/events/{event_id}/changes",
    response_model=OwnEventChangeResponse,
    status_code=201,
)
@limiter.limit("20/hour")
def propose_event_change(
    event_id: str,
    body: EventChangeCreate,
    request: Request,
    session: Session = Depends(get_session),
    user: User = Depends(require_user),
):
    """Suggest a change to a public event; every change waits for an admin."""
    event = session.get(CachedEvent, event_id)
    if (
        event is None
        or event.deleted_at is not None
        or event.is_hidden
        or session.get(BlockedEvent, event_id) is not None
        or not event_is_user_facing(session, event)
    ):
        raise HTTPException(status_code=404, detail="Event not found")
    if event.owner_user_id == user.id and (
        not body.model_fields_set
        or body.model_fields_set - set(event_revisions.CANCEL_FIELDS)
    ):
        raise HTTPException(
            status_code=409, detail="Edit your own event from Events I added"
        )
    organizer = event.organizer_user_id == user.id
    if not organizer and event.review_status != "reviewed":
        raise HTTPException(
            status_code=409, detail="This event is still being reviewed"
        )

    # Owners, like organizers, may only ask for a cancellation here.
    changes = _changes(
        session, event, body, organizer=organizer or event.owner_user_id == user.id
    )
    new_tags = [item.model_dump() for item in body.suggested_new_tags or []]
    if not changes and new_tags:
        event_revisions.request_new_tags(session, event_id, new_tags, user.id)
        session.commit()
        return Response(status_code=202)
    if not changes:
        raise HTTPException(status_code=422, detail="Nothing changed")
    event_revisions.request_new_tags(session, event_id, new_tags, user.id)

    if organizer:
        # The organizer's latest proposal replaces their previous pending one.
        for previous in session.exec(
            select(EventRevision).where(
                EventRevision.event_id == event_id,
                EventRevision.proposed_by_user_id == user.id,
                EventRevision.source == event_revisions.SOURCE_ORGANIZER,
                EventRevision.status == event_revisions.STATUS_PENDING,
            )
        ).all():
            previous.status = event_revisions.STATUS_SUPERSEDED
            previous.updated_at = datetime.now(timezone.utc)
            session.add(previous)
        revision = EventRevision(
            event_id=event_id,
            source=event_revisions.SOURCE_ORGANIZER,
            status=event_revisions.STATUS_PENDING,
            changes=changes,
            proposed_by_user_id=user.id,
        )
        session.add(revision)
        session.commit()
        session.refresh(revision)
        return _own_response(session, revision)

    if _open_changes(session, user.id, event_id):
        raise HTTPException(
            status_code=409,
            detail="You already suggested a change to this event; withdraw it to send a new one",
        )
    if _open_changes(session, user.id) >= MAX_OPEN_CHANGES:
        raise HTTPException(
            status_code=429,
            detail=f"You can have at most {MAX_OPEN_CHANGES} suggestions waiting for review",
        )
    revision = EventRevision(
        event_id=event_id,
        source=event_revisions.SOURCE_USER,
        status=event_revisions.STATUS_PENDING,
        changes=changes,
        proposed_by_user_id=user.id,
    )
    session.add(revision)
    session.commit()
    session.refresh(revision)
    return _own_response(session, revision)


@router.get("/api/me/changes", response_model=list[OwnEventChangeResponse])
def list_own_changes(
    session: Session = Depends(get_session),
    user: User = Depends(require_user),
):
    revisions = session.exec(
        select(EventRevision)
        .where(
            EventRevision.proposed_by_user_id == user.id,
            col(EventRevision.source).in_(
                (event_revisions.SOURCE_USER, event_revisions.SOURCE_ORGANIZER)
            ),
        )
        .order_by(col(EventRevision.created_at).desc())
    ).all()
    return [_own_response(session, r) for r in revisions]


@router.delete("/api/me/changes/{revision_id}", response_model=OwnEventChangeResponse)
def withdraw_own_change(
    revision_id: int,
    session: Session = Depends(get_session),
    user: User = Depends(require_user),
):
    revision = session.get(EventRevision, revision_id)
    if (
        revision is None
        or revision.proposed_by_user_id != user.id
        or revision.source
        not in (event_revisions.SOURCE_USER, event_revisions.SOURCE_ORGANIZER)
    ):
        raise HTTPException(status_code=404, detail="Suggestion not found")
    if revision.status != event_revisions.STATUS_PENDING:
        raise HTTPException(
            status_code=409, detail=f"Suggestion is already {revision.status}"
        )
    revision.status = event_revisions.STATUS_WITHDRAWN
    revision.updated_at = datetime.now(timezone.utc)
    session.add(revision)
    session.commit()
    session.refresh(revision)
    return _own_response(session, revision)
