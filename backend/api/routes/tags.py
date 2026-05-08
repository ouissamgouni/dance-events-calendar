import logging
import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from slowapi import Limiter
from backend.api.rate_limit import client_ip
from sqlmodel import Session, col, select

from backend.api.deps import get_client_ip, require_admin
from backend.api.schemas import (
    BulkTagSuggestionReviewRequest,
    BulkTagSuggestionReviewResponse,
    EventTagAssignment,
    TagCreate,
    TagGroupCreate,
    TagGroupResponse,
    TagGroupUpdate,
    TagResponse,
    TagSuggestionApproveRequest,
    TagSuggestionCreate,
    TagSuggestionRejectRequest,
    TagSuggestionResponse,
    TagSynonymCreateRequest,
    TagSynonymResponse,
    TagUpdate,
)
from backend.db.database import get_session
from backend.db.models import (
    CachedEvent,
    EventTag,
    Tag,
    TagGroup,
    TagSuggestion,
    TagSynonym,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["tags"])

limiter = Limiter(key_func=client_ip)


def _slugify(text: str) -> str:
    """Convert a label to a URL-safe slug."""
    s = text.lower().strip()
    s = re.sub(r"[^\w\s-]", "", s)
    s = re.sub(r"[\s_]+", "-", s)
    return re.sub(r"-+", "-", s).strip("-")


def _tag_to_response(tag: Tag) -> TagResponse:
    return TagResponse(
        id=tag.id,
        slug=tag.slug,
        label=tag.label,
        color=tag.color,
        ordinal=tag.ordinal,
        group_slug=tag.group.slug if tag.group else "",
        group_label=tag.group.label if tag.group else "",
        group_color=tag.group.color if tag.group else None,
        enabled=tag.enabled,
        is_hero_filter=tag.is_hero_filter,
        hero_ordinal=tag.hero_ordinal,
    )


def _group_to_response(group: TagGroup) -> TagGroupResponse:
    return TagGroupResponse(
        id=group.id,
        slug=group.slug,
        label=group.label,
        color=group.color,
        ordinal=group.ordinal,
        allow_multiple=group.allow_multiple,
        enabled=group.enabled,
        scope=group.scope,
        tags=[_tag_to_response(t) for t in sorted(group.tags, key=lambda t: t.ordinal)],
    )


def _suggestion_to_response(
    suggestion: TagSuggestion,
    *,
    tag: Optional[Tag] = None,
    event_title: Optional[str] = None,
    event: Optional[CachedEvent] = None,
) -> TagSuggestionResponse:
    """Centralised serialiser so heuristic metadata (source/confidence/matched_terms)
    is always carried through, regardless of which endpoint built the row."""
    return TagSuggestionResponse(
        id=suggestion.id,
        event_id=suggestion.event_id,
        event_title=event_title
        if event_title is not None
        else (event.title if event else None),
        event_description=getattr(event, "description", None) if event else None,
        event_start=getattr(event, "start", None) if event else None,
        event_location=getattr(event, "location", None) if event else None,
        tag=_tag_to_response(tag) if tag else None,
        free_text=suggestion.free_text,
        group_slug=suggestion.group_slug,
        status=suggestion.status,
        submitter_device_id=suggestion.submitter_device_id,
        admin_notes=suggestion.admin_notes,
        reviewed_at=suggestion.reviewed_at,
        created_at=suggestion.created_at,
        source=suggestion.source,
        confidence=suggestion.confidence,
        matched_terms=suggestion.matched_terms,
    )


def _assert_event_scope_tag(session: Session, tag_id: int) -> Tag:
    """Reject attempts to attach a review-scoped tag to an event.

    Defence-in-depth: even if a future call site forgets to filter by scope,
    the routes that mutate the event-tag namespace will refuse review-scope
    ids. Returns the tag for convenience.
    """
    tag = session.get(Tag, tag_id)
    if not tag:
        raise HTTPException(status_code=404, detail=f"Tag {tag_id} not found")
    group = session.get(TagGroup, tag.group_id)
    if group and group.scope != "event":
        raise HTTPException(
            status_code=400,
            detail=(
                f"Tag {tag_id} belongs to a '{group.scope}'-scope group "
                f"and cannot be attached to events."
            ),
        )
    return tag


# ── helpers shared with other routes ──────────────────────────────────


def get_event_tags(
    session: Session, event_ids: list[str]
) -> dict[str, list[TagResponse]]:
    """Batch-load tags for a list of event_ids. Returns {event_id: [TagResponse]}."""
    if not event_ids:
        return {}
    rows = session.exec(
        select(EventTag, Tag, TagGroup)
        .join(Tag, EventTag.tag_id == Tag.id)
        .join(TagGroup, Tag.group_id == TagGroup.id)
        .where(EventTag.event_id.in_(event_ids))
        .order_by(TagGroup.ordinal, Tag.ordinal)
    ).all()
    result: dict[str, list[TagResponse]] = {}
    for et, tag, group in rows:
        tag_resp = TagResponse(
            id=tag.id,
            slug=tag.slug,
            label=tag.label,
            color=tag.color,
            ordinal=tag.ordinal,
            group_slug=group.slug,
            group_label=group.label,
            group_color=group.color,
            enabled=tag.enabled,
            is_hero_filter=tag.is_hero_filter,
            hero_ordinal=tag.hero_ordinal,
        )
        result.setdefault(et.event_id, []).append(tag_resp)
    return result


# ── Public endpoints ──────────────────────────────────────────────────


@router.get("/api/tags", response_model=list[TagGroupResponse])
@limiter.limit("60/minute")
def list_tag_groups(
    request: Request,
    session: Session = Depends(get_session),
    start_date: str | None = Query(
        default=None, description="ISO date string to scope event counts (YYYY-MM-DD)"
    ),
    end_date: str | None = Query(
        default=None, description="ISO date string to scope event counts (YYYY-MM-DD)"
    ),
    scope: str = Query(
        default="event",
        pattern="^(event|review)$",
        description=(
            "Tag namespace. 'event' (default) returns groups used for "
            "explorer filtering and event classification. 'review' returns "
            "review-only aspect tags used inside the rate-event modal and "
            "review-list filter chips."
        ),
    ),
):
    """List tag groups within a given scope (default: event).

    Review-scope groups are kept on a separate namespace so reviewer
    vocabulary cannot pollute the event filter taxonomy (mirrors how
    Google/Yelp/Airbnb separate place attributes from review aspects).
    """
    from datetime import datetime, timezone

    from sqlalchemy import func
    from fastapi.responses import JSONResponse

    groups = session.exec(
        select(TagGroup)
        .where(TagGroup.enabled == True)  # noqa: E712
        .where(TagGroup.scope == scope)
        .order_by(TagGroup.ordinal)
    ).all()

    # Count events per tag (only non-deleted events), optionally scoped to a date range
    count_q = (
        select(EventTag.tag_id, func.count(func.distinct(EventTag.event_id)))
        .join(CachedEvent, CachedEvent.event_id == EventTag.event_id)
        .where(CachedEvent.deleted_at == None)  # noqa: E711
    )
    if start_date:
        try:
            dt_start = datetime.fromisoformat(start_date).replace(tzinfo=timezone.utc)
            count_q = count_q.where(CachedEvent.end >= dt_start)
        except ValueError:
            pass
    if end_date:
        try:
            dt_end = datetime.fromisoformat(end_date).replace(tzinfo=timezone.utc)
            count_q = count_q.where(CachedEvent.start <= dt_end)
        except ValueError:
            pass
    count_rows = session.exec(count_q.group_by(EventTag.tag_id)).all()
    count_map = {tid: cnt for tid, cnt in count_rows}

    data = [_group_to_response(g) for g in groups]
    # Filter out disabled tags and inject event counts
    for group_resp in data:
        group_resp.tags = [t for t in group_resp.tags if t.enabled]
        for tag_resp in group_resp.tags:
            tag_resp.event_count = count_map.get(tag_resp.id, 0)

    response = JSONResponse(content=[d.model_dump(mode="json") for d in data])
    response.headers["Cache-Control"] = "public, max-age=30"
    return response


@router.post(
    "/api/tags/suggestions",
    response_model=TagSuggestionResponse,
    status_code=201,
)
@limiter.limit("10/hour")
def submit_tag_suggestion(
    body: TagSuggestionCreate,
    request: Request,
    session: Session = Depends(get_session),
):
    """Public: suggest a tag for an existing event."""
    # Honeypot
    if body.website:
        from datetime import datetime

        return TagSuggestionResponse(
            id=0,
            event_id=body.event_id,
            status="pending",
            created_at=datetime.utcnow(),
        )

    # Validate: at least one of tag_id or free_text
    if not body.tag_id and not body.free_text:
        raise HTTPException(
            status_code=400,
            detail="Either tag_id or free_text is required",
        )

    # Validate event exists
    event = session.get(CachedEvent, body.event_id)
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    # Validate tag_id if provided
    if body.tag_id:
        tag = session.get(Tag, body.tag_id)
        if not tag:
            raise HTTPException(status_code=404, detail="Tag not found")
        group = session.get(TagGroup, tag.group_id)
        if group and group.scope != "event":
            raise HTTPException(
                status_code=400,
                detail=(
                    "Review-scope tags cannot be suggested as event tags. "
                    "Attach them through the rate-event flow instead."
                ),
            )

    # Free-text suggestions targeting a review-scope group are also rejected.
    if body.group_slug:
        target_group = session.exec(
            select(TagGroup).where(TagGroup.slug == body.group_slug)
        ).first()
        if target_group and target_group.scope != "event":
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Group '{body.group_slug}' is review-scope and does not "
                    "accept event-tag suggestions."
                ),
            )

    client_ip = get_client_ip(request)

    suggestion = TagSuggestion(
        event_id=body.event_id,
        tag_id=body.tag_id,
        free_text=body.free_text,
        group_slug=body.group_slug,
        submitter_device_id=body.device_id,
        submitter_ip=client_ip,
    )
    session.add(suggestion)
    session.commit()
    session.refresh(suggestion)

    tag = session.get(Tag, suggestion.tag_id) if suggestion.tag_id else None
    return _suggestion_to_response(suggestion, tag=tag, event=event)


# ── Admin: Tag Group listing with event counts ───────────────────────


@router.get("/api/admin/tags/groups")
def list_admin_tag_groups(
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """List all tag groups with nested tags and event_count per tag."""
    from sqlalchemy import func as sa_func

    groups = session.exec(select(TagGroup).order_by(TagGroup.ordinal)).all()

    # Count events per tag in one query
    count_rows = session.exec(
        select(EventTag.tag_id, sa_func.count(EventTag.event_id).label("cnt")).group_by(
            EventTag.tag_id
        )
    ).all()
    counts: dict[int, int] = {row[0]: row[1] for row in count_rows}

    result = []
    for group in groups:
        group_data = _group_to_response(group).model_dump(mode="json")
        for tag_data in group_data["tags"]:
            tag_data["event_count"] = counts.get(tag_data["id"], 0)
        result.append(group_data)
    return result


# ── Admin: Tag Group CRUD ────────────────────────────────────────────


@router.post("/api/admin/tags/groups", response_model=TagGroupResponse, status_code=201)
def create_tag_group(
    body: TagGroupCreate,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    slug = body.slug or _slugify(body.label)
    existing = session.exec(select(TagGroup).where(TagGroup.slug == slug)).first()
    if existing:
        raise HTTPException(
            status_code=409, detail=f"Tag group '{slug}' already exists"
        )

    max_ordinal = session.exec(
        select(TagGroup.ordinal).order_by(col(TagGroup.ordinal).desc())
    ).first()
    group = TagGroup(
        slug=slug,
        label=body.label,
        color=body.color,
        ordinal=(max_ordinal or 0) + 1,
        scope=body.scope or "event",
    )
    session.add(group)
    session.commit()
    session.refresh(group)
    return _group_to_response(group)


@router.patch("/api/admin/tags/groups/{group_id}", response_model=TagGroupResponse)
def update_tag_group(
    group_id: int,
    body: TagGroupUpdate,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    group = session.get(TagGroup, group_id)
    if not group:
        raise HTTPException(status_code=404, detail="Tag group not found")

    update_data = body.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(group, field, value)
    session.add(group)
    session.commit()
    session.refresh(group)
    return _group_to_response(group)


@router.delete("/api/admin/tags/groups/{group_id}", status_code=204)
def delete_tag_group(
    group_id: int,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    group = session.get(TagGroup, group_id)
    if not group:
        raise HTTPException(status_code=404, detail="Tag group not found")

    # Cascade: delete event_tags → tags → group
    tag_ids = [t.id for t in group.tags]
    if tag_ids:
        session.exec(select(EventTag).where(EventTag.tag_id.in_(tag_ids)))
        # Delete event_tags for these tags
        for et in session.exec(
            select(EventTag).where(EventTag.tag_id.in_(tag_ids))
        ).all():
            session.delete(et)
        # Delete tag_suggestions for these tags
        for ts in session.exec(
            select(TagSuggestion).where(TagSuggestion.tag_id.in_(tag_ids))
        ).all():
            session.delete(ts)
        # Delete tags
        for tag in group.tags:
            session.delete(tag)
    session.delete(group)
    session.commit()


# ── Admin: Tag CRUD ──────────────────────────────────────────────────


@router.post("/api/admin/tags", response_model=TagResponse, status_code=201)
def create_tag(
    body: TagCreate,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    group = session.get(TagGroup, body.group_id)
    if not group:
        raise HTTPException(status_code=404, detail="Tag group not found")

    slug = body.slug or _slugify(body.label)
    existing = session.exec(
        select(Tag).where(Tag.group_id == body.group_id, Tag.slug == slug)
    ).first()
    if existing:
        raise HTTPException(
            status_code=409, detail=f"Tag '{slug}' already exists in this group"
        )

    max_ordinal = session.exec(
        select(Tag.ordinal)
        .where(Tag.group_id == body.group_id)
        .order_by(col(Tag.ordinal).desc())
    ).first()
    tag = Tag(
        group_id=body.group_id,
        slug=slug,
        label=body.label,
        color=body.color,
        ordinal=(max_ordinal or 0) + 1,
    )
    session.add(tag)
    session.commit()
    session.refresh(tag)
    return _tag_to_response(tag)


@router.patch("/api/admin/tags/{tag_id}", response_model=TagResponse)
def update_tag(
    tag_id: int,
    body: TagUpdate,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    tag = session.get(Tag, tag_id)
    if not tag:
        raise HTTPException(status_code=404, detail="Tag not found")

    update_data = body.model_dump(exclude_unset=True)

    # Handle moving the tag to another group/category.
    new_group_id = update_data.pop("group_id", None)
    if new_group_id is not None and new_group_id != tag.group_id:
        target_group = session.get(TagGroup, new_group_id)
        if not target_group:
            raise HTTPException(status_code=404, detail="Target tag group not found")
        current_group = session.get(TagGroup, tag.group_id)
        if current_group and target_group.scope != current_group.scope:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Cannot move tag across scopes "
                    f"({current_group.scope} → {target_group.scope})"
                ),
            )
        # Slug collision check against the target group's existing tags.
        collision = session.exec(
            select(Tag.id).where(
                Tag.group_id == new_group_id,
                Tag.slug == tag.slug,
                Tag.id != tag.id,
            )
        ).first()
        if collision is not None:
            raise HTTPException(
                status_code=409,
                detail=f"Target group already has a tag with slug '{tag.slug}'",
            )
        # Append at the end of the target group unless caller also set ordinal.
        if "ordinal" not in update_data:
            max_ordinal = session.exec(
                select(Tag.ordinal)
                .where(Tag.group_id == new_group_id)
                .order_by(col(Tag.ordinal).desc())
            ).first()
            update_data["ordinal"] = (max_ordinal or 0) + 1
        tag.group_id = new_group_id

    for field, value in update_data.items():
        setattr(tag, field, value)
    session.add(tag)
    session.commit()
    session.refresh(tag)
    return _tag_to_response(tag)


@router.delete("/api/admin/tags/{tag_id}", status_code=204)
def delete_tag(
    tag_id: int,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    tag = session.get(Tag, tag_id)
    if not tag:
        raise HTTPException(status_code=404, detail="Tag not found")

    # Cascade: delete event_tags, tag_suggestions, and tag_synonyms referencing this tag
    for et in session.exec(select(EventTag).where(EventTag.tag_id == tag_id)).all():
        session.delete(et)
    for ts in session.exec(
        select(TagSuggestion).where(TagSuggestion.tag_id == tag_id)
    ).all():
        session.delete(ts)
    for syn in session.exec(
        select(TagSynonym).where(TagSynonym.tag_id == tag_id)
    ).all():
        session.delete(syn)
    session.delete(tag)
    session.commit()


# ── Admin: Event-Tag assignment ──────────────────────────────────────


@router.put(
    "/api/admin/events/{event_id}/tags",
    response_model=list[TagResponse],
)
def set_event_tags(
    event_id: str,
    body: EventTagAssignment,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """Replace all tags for an event."""
    event = session.get(CachedEvent, event_id)
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    # Delete existing
    existing = session.exec(select(EventTag).where(EventTag.event_id == event_id)).all()
    for et in existing:
        session.delete(et)

    # Add new
    for tag_id in body.tag_ids:
        _assert_event_scope_tag(session, tag_id)
        session.add(EventTag(event_id=event_id, tag_id=tag_id))

    session.commit()

    # Return updated tags
    tags_map = get_event_tags(session, [event_id])
    return tags_map.get(event_id, [])


@router.post("/api/admin/events/{event_id}/tags/{tag_id}", status_code=201)
def add_event_tag(
    event_id: str,
    tag_id: int,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """Add a single tag to an event."""
    event = session.get(CachedEvent, event_id)
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    _assert_event_scope_tag(session, tag_id)

    existing = session.exec(
        select(EventTag).where(EventTag.event_id == event_id, EventTag.tag_id == tag_id)
    ).first()
    if not existing:
        session.add(EventTag(event_id=event_id, tag_id=tag_id))
        session.commit()

    return {"status": "ok"}


@router.delete("/api/admin/events/{event_id}/tags/{tag_id}", status_code=204)
def remove_event_tag(
    event_id: str,
    tag_id: int,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """Remove a single tag from an event."""
    et = session.exec(
        select(EventTag).where(EventTag.event_id == event_id, EventTag.tag_id == tag_id)
    ).first()
    if et:
        session.delete(et)
        session.commit()


# ── Admin: Tag Suggestions ───────────────────────────────────────────


@router.get("/api/admin/tags/suggestions", response_model=list[TagSuggestionResponse])
def list_tag_suggestions(
    status: str | None = Query(default=None),
    source: str | None = Query(default=None, regex="^(user|heuristic)$"),
    event_id: str | None = Query(default=None),
    include_past: bool = Query(default=False),
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """List tag suggestions, optionally filtered by status, source, or event.

    Defaults to suggestions whose underlying event has not finished yet
    (``CachedEvent.end > now``). Pass ``include_past=true`` to include
    suggestions for past events too — typically only useful for audits.
    """
    from datetime import datetime as _dt

    query = select(TagSuggestion).order_by(col(TagSuggestion.created_at).desc())
    if status:
        query = query.where(TagSuggestion.status == status)
    if source:
        query = query.where(TagSuggestion.source == source)
    if event_id:
        query = query.where(TagSuggestion.event_id == event_id)
    if not include_past:
        upcoming_ids = select(CachedEvent.event_id).where(
            CachedEvent.deleted_at == None,  # noqa: E711
            CachedEvent.end > _dt.utcnow(),
        )
        query = query.where(TagSuggestion.event_id.in_(upcoming_ids))
    suggestions = session.exec(query).all()

    # Enrich with event titles and tag info
    event_ids = list({s.event_id for s in suggestions})
    events_map: dict[str, CachedEvent] = {}
    if event_ids:
        events = session.exec(
            select(CachedEvent).where(CachedEvent.event_id.in_(event_ids))
        ).all()
        events_map = {e.event_id: e for e in events}

    result = []
    for s in suggestions:
        tag = session.get(Tag, s.tag_id) if s.tag_id else None
        ev = events_map.get(s.event_id)
        result.append(
            _suggestion_to_response(
                s,
                tag=tag,
                event=ev,
                event_title=ev.title if ev else "Unknown",
            )
        )
    return result


@router.post(
    "/api/admin/tags/suggestions/{suggestion_id}/approve",
    response_model=TagSuggestionResponse,
)
def approve_tag_suggestion(
    suggestion_id: int,
    body: TagSuggestionApproveRequest,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """Approve a tag suggestion. Creates EventTag linking."""
    from datetime import datetime

    suggestion = session.get(TagSuggestion, suggestion_id)
    if not suggestion:
        raise HTTPException(status_code=404, detail="Tag suggestion not found")
    if suggestion.status != "pending":
        raise HTTPException(
            status_code=400, detail=f"Suggestion is already {suggestion.status}"
        )

    # Determine tag_id to assign
    tag_id = suggestion.tag_id
    if not tag_id:
        # Free-text suggestion: admin must specify which tag to assign
        tag_id = body.tag_id
        if not tag_id:
            raise HTTPException(
                status_code=422,
                detail="tag_id is required when approving a free-text suggestion",
            )
    elif body.tag_id:
        # Admin can override the suggested tag
        tag_id = body.tag_id

    tag = _assert_event_scope_tag(session, tag_id)

    # Create EventTag (idempotent)
    existing_et = session.exec(
        select(EventTag).where(
            EventTag.event_id == suggestion.event_id,
            EventTag.tag_id == tag_id,
        )
    ).first()
    if not existing_et:
        session.add(EventTag(event_id=suggestion.event_id, tag_id=tag_id))

    suggestion.status = "approved"
    suggestion.reviewed_at = datetime.utcnow()
    session.add(suggestion)
    session.commit()
    session.refresh(suggestion)

    event = session.get(CachedEvent, suggestion.event_id)
    return _suggestion_to_response(
        suggestion,
        tag=tag,
        event=event,
        event_title=event.title if event else "Unknown",
    )


@router.post(
    "/api/admin/tags/suggestions/{suggestion_id}/reject",
    response_model=TagSuggestionResponse,
)
def reject_tag_suggestion(
    suggestion_id: int,
    body: TagSuggestionRejectRequest,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """Reject a tag suggestion."""
    from datetime import datetime

    suggestion = session.get(TagSuggestion, suggestion_id)
    if not suggestion:
        raise HTTPException(status_code=404, detail="Tag suggestion not found")
    if suggestion.status != "pending":
        raise HTTPException(
            status_code=400, detail=f"Suggestion is already {suggestion.status}"
        )

    suggestion.status = "rejected"
    suggestion.admin_notes = body.admin_notes or suggestion.admin_notes
    suggestion.reviewed_at = datetime.utcnow()
    session.add(suggestion)
    session.commit()
    session.refresh(suggestion)

    tag = session.get(Tag, suggestion.tag_id) if suggestion.tag_id else None
    event = session.get(CachedEvent, suggestion.event_id)
    return _suggestion_to_response(
        suggestion,
        tag=tag,
        event=event,
        event_title=event.title if event else "Unknown",
    )


@router.post(
    "/api/admin/tags/suggestions/bulk-review",
    response_model=BulkTagSuggestionReviewResponse,
)
def bulk_review_tag_suggestions(
    body: BulkTagSuggestionReviewRequest,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """Approve or reject multiple tag suggestions in a single transaction.

    Free-text suggestions (no tag_id) cannot be bulk-approved — they are
    counted as skipped. All other pending suggestions are processed.
    """
    from datetime import datetime

    if body.action not in ("approve", "reject"):
        raise HTTPException(
            status_code=422, detail="action must be 'approve' or 'reject'"
        )
    if not body.ids:
        return BulkTagSuggestionReviewResponse(ok=0, skipped=0)

    suggestions = session.exec(
        select(TagSuggestion).where(TagSuggestion.id.in_(body.ids))
    ).all()

    now = datetime.utcnow()
    ok = 0
    skipped = 0

    for suggestion in suggestions:
        if suggestion.status != "pending":
            skipped += 1
            continue

        if body.action == "approve":
            tag_id = suggestion.tag_id
            if not tag_id:
                # Free-text suggestion — requires manual tag assignment
                skipped += 1
                continue
            # Validate tag is event-scoped
            tag = session.get(Tag, tag_id)
            if not tag:
                skipped += 1
                continue
            # Create EventTag idempotently
            existing = session.exec(
                select(EventTag).where(
                    EventTag.event_id == suggestion.event_id,
                    EventTag.tag_id == tag_id,
                )
            ).first()
            if not existing:
                session.add(EventTag(event_id=suggestion.event_id, tag_id=tag_id))
            suggestion.status = "approved"
        else:
            suggestion.status = "rejected"

        suggestion.reviewed_at = now
        session.add(suggestion)
        ok += 1

    session.commit()
    return BulkTagSuggestionReviewResponse(ok=ok, skipped=skipped)


# ── Admin: Tag synonyms (heuristic suggester) ────────────────────────


def _synonym_to_response(syn: TagSynonym) -> TagSynonymResponse:
    return TagSynonymResponse(
        id=syn.id,
        tag_id=syn.tag_id,
        term=syn.term,
        created_at=syn.created_at,
    )


@router.get(
    "/api/admin/tags/{tag_id}/synonyms",
    response_model=list[TagSynonymResponse],
)
def list_tag_synonyms(
    tag_id: int,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """List all synonym terms configured for a tag (used by the heuristic suggester)."""
    tag = session.get(Tag, tag_id)
    if not tag:
        raise HTTPException(status_code=404, detail=f"Tag {tag_id} not found")
    rows = session.exec(
        select(TagSynonym).where(TagSynonym.tag_id == tag_id).order_by(TagSynonym.term)
    ).all()
    return [_synonym_to_response(r) for r in rows]


@router.post(
    "/api/admin/tags/{tag_id}/synonyms",
    response_model=TagSynonymResponse,
    status_code=201,
)
def create_tag_synonym(
    tag_id: int,
    body: TagSynonymCreateRequest,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """Add a synonym term to a tag."""
    tag = session.get(Tag, tag_id)
    if not tag:
        raise HTTPException(status_code=404, detail=f"Tag {tag_id} not found")
    term = (body.term or "").strip().lower()
    if not term:
        raise HTTPException(status_code=422, detail="term must not be empty")
    existing = session.exec(
        select(TagSynonym).where(
            TagSynonym.tag_id == tag_id,
            TagSynonym.term == term,
        )
    ).first()
    if existing:
        raise HTTPException(
            status_code=409, detail="Synonym already exists for this tag"
        )
    syn = TagSynonym(tag_id=tag_id, term=term)
    session.add(syn)
    session.commit()
    session.refresh(syn)
    return _synonym_to_response(syn)


@router.delete(
    "/api/admin/tags/synonyms/{synonym_id}",
    status_code=204,
)
def delete_tag_synonym(
    synonym_id: int,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """Remove a synonym term."""
    syn = session.get(TagSynonym, synonym_id)
    if not syn:
        raise HTTPException(status_code=404, detail="Synonym not found")
    session.delete(syn)
    session.commit()
    return None
