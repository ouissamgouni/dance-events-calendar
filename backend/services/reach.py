from typing import Literal

from sqlmodel import Session, select

from backend.db.models import CachedEvent, EventTag, Tag, TagGroup

EventReach = Literal["local", "regional", "international"]
ProfileReachFilter = Literal["any", "regional_plus", "international"]


def reach_matches(
    reach_filter: ProfileReachFilter | str,
    event_reach: EventReach | str | None,
) -> bool:
    if reach_filter == "any":
        return True
    if reach_filter == "regional_plus":
        return event_reach in {"regional", "international"}
    return event_reach == "international"


def event_reach_from_tag_ids(session: Session, tag_ids: list[int]) -> str | None:
    if not tag_ids:
        return None
    slugs = set(
        session.exec(
            select(Tag.slug)
            .join(TagGroup, TagGroup.id == Tag.group_id)
            .where(TagGroup.slug == "reach", Tag.id.in_(tag_ids))
        ).all()
    )
    if len(slugs) > 1:
        raise ValueError("An event can have at most one reach classification.")
    return next(iter(slugs), None)


def sync_event_reach(
    session: Session,
    event: CachedEvent,
    tag_ids: list[int],
) -> None:
    event.reach = event_reach_from_tag_ids(session, tag_ids)
    session.add(event)


def assign_event_tag(session: Session, event: CachedEvent, tag: Tag) -> bool:
    """Add a tag, replacing any prior reach classification when necessary."""
    existing = session.exec(
        select(EventTag).where(
            EventTag.event_id == event.event_id,
            EventTag.tag_id == tag.id,
        )
    ).first()
    group_slug = session.exec(
        select(TagGroup.slug).where(TagGroup.id == tag.group_id)
    ).first()
    if group_slug == "reach":
        prior_reach_tags = session.exec(
            select(EventTag)
            .join(Tag, Tag.id == EventTag.tag_id)
            .join(TagGroup, TagGroup.id == Tag.group_id)
            .where(
                EventTag.event_id == event.event_id,
                TagGroup.slug == "reach",
                EventTag.tag_id != tag.id,
            )
        ).all()
        for event_tag in prior_reach_tags:
            session.delete(event_tag)
        event.reach = tag.slug
        session.add(event)
    if existing:
        return False
    session.add(EventTag(event_id=event.event_id, tag_id=tag.id))
    return True
