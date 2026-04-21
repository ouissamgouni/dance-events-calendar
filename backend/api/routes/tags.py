import logging
import re

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlmodel import Session, col, select

from backend.api.deps import get_client_ip, require_admin
from backend.api.schemas import (
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
    TagUpdate,
)
from backend.db.database import get_session
from backend.db.models import CachedEvent, EventTag, Tag, TagGroup, TagSuggestion

logger = logging.getLogger(__name__)

router = APIRouter(tags=["tags"])

limiter = Limiter(key_func=get_remote_address)


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
        tags=[_tag_to_response(t) for t in sorted(group.tags, key=lambda t: t.ordinal)],
    )


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
        )
        result.setdefault(et.event_id, []).append(tag_resp)
    return result


# ── Public endpoints ──────────────────────────────────────────────────


@router.get("/api/tags", response_model=list[TagGroupResponse])
@limiter.limit("60/minute")
def list_tag_groups(
    request: Request,
    session: Session = Depends(get_session),
):
    """List all tag groups with nested tags (for filter UI & tag picker)."""
    from sqlalchemy import func
    from fastapi.responses import JSONResponse

    groups = session.exec(
        select(TagGroup).where(TagGroup.enabled == True).order_by(TagGroup.ordinal)  # noqa: E712
    ).all()

    # Count events per tag (only non-deleted events)
    from backend.db.models import CachedEvent

    count_rows = session.exec(
        select(EventTag.tag_id, func.count(func.distinct(EventTag.event_id)))
        .join(CachedEvent, CachedEvent.event_id == EventTag.event_id)
        .where(CachedEvent.deleted_at == None)  # noqa: E711
        .group_by(EventTag.tag_id)
    ).all()
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
            status_code=422,
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

    # Build response
    tag_resp = None
    if suggestion.tag_id:
        tag = session.get(Tag, suggestion.tag_id)
        if tag:
            tag_resp = _tag_to_response(tag)

    return TagSuggestionResponse(
        id=suggestion.id,
        event_id=suggestion.event_id,
        event_title=event.title,
        tag=tag_resp,
        free_text=suggestion.free_text,
        status=suggestion.status,
        submitter_device_id=suggestion.submitter_device_id,
        created_at=suggestion.created_at,
    )


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

    # Cascade: delete event_tags and tag_suggestions referencing this tag
    for et in session.exec(select(EventTag).where(EventTag.tag_id == tag_id)).all():
        session.delete(et)
    for ts in session.exec(
        select(TagSuggestion).where(TagSuggestion.tag_id == tag_id)
    ).all():
        session.delete(ts)
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
        tag = session.get(Tag, tag_id)
        if not tag:
            raise HTTPException(status_code=404, detail=f"Tag {tag_id} not found")
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
    tag = session.get(Tag, tag_id)
    if not tag:
        raise HTTPException(status_code=404, detail="Tag not found")

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
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """List tag suggestions, optionally filtered by status."""
    query = select(TagSuggestion).order_by(col(TagSuggestion.created_at).desc())
    if status:
        query = query.where(TagSuggestion.status == status)
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
        tag_resp = None
        if s.tag_id:
            tag = session.get(Tag, s.tag_id)
            if tag:
                tag_resp = _tag_to_response(tag)
        result.append(
            TagSuggestionResponse(
                id=s.id,
                event_id=s.event_id,
                event_title=events_map.get(
                    s.event_id,
                    CachedEvent(
                        event_id="",
                        calendar_id="",
                        title="Unknown",
                        start=s.created_at,
                        end=s.created_at,
                    ),
                ).title,
                tag=tag_resp,
                free_text=s.free_text,
                status=s.status,
                submitter_device_id=s.submitter_device_id,
                admin_notes=s.admin_notes,
                reviewed_at=s.reviewed_at,
                created_at=s.created_at,
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

    tag = session.get(Tag, tag_id)
    if not tag:
        raise HTTPException(status_code=404, detail="Tag not found")

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

    tag_resp = _tag_to_response(tag)
    event = session.get(CachedEvent, suggestion.event_id)
    return TagSuggestionResponse(
        id=suggestion.id,
        event_id=suggestion.event_id,
        event_title=event.title if event else "Unknown",
        tag=tag_resp,
        free_text=suggestion.free_text,
        status=suggestion.status,
        submitter_device_id=suggestion.submitter_device_id,
        admin_notes=suggestion.admin_notes,
        reviewed_at=suggestion.reviewed_at,
        created_at=suggestion.created_at,
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

    tag_resp = None
    if suggestion.tag_id:
        tag = session.get(Tag, suggestion.tag_id)
        if tag:
            tag_resp = _tag_to_response(tag)

    event = session.get(CachedEvent, suggestion.event_id)
    return TagSuggestionResponse(
        id=suggestion.id,
        event_id=suggestion.event_id,
        event_title=event.title if event else "Unknown",
        tag=tag_resp,
        free_text=suggestion.free_text,
        status=suggestion.status,
        submitter_device_id=suggestion.submitter_device_id,
        admin_notes=suggestion.admin_notes,
        reviewed_at=suggestion.reviewed_at,
        created_at=suggestion.created_at,
    )
