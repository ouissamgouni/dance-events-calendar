from datetime import datetime

from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from backend.db.models import CachedEvent, EventTag, Tag, TagGroup
from backend.services.reach import assign_event_tag


def test_assign_event_tag_replaces_existing_reach_classification():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)

    with Session(engine) as session:
        reach_group = TagGroup(slug="reach", label="Event reach", allow_multiple=False)
        session.add(reach_group)
        session.commit()
        session.refresh(reach_group)
        local = Tag(group_id=reach_group.id, slug="local", label="Local")
        international = Tag(
            group_id=reach_group.id,
            slug="international",
            label="International",
        )
        event = CachedEvent(
            event_id="reach-event",
            calendar_id="test-calendar",
            title="Reach event",
            start=datetime(2025, 1, 1, 20),
            end=datetime(2025, 1, 1, 23),
        )
        session.add_all([local, international, event])
        session.commit()

        assign_event_tag(session, event, local)
        session.commit()
        assign_event_tag(session, event, international)
        session.commit()
        session.refresh(event)

        reach_slugs = session.exec(
            select(Tag.slug)
            .join(EventTag, EventTag.tag_id == Tag.id)
            .where(EventTag.event_id == event.event_id)
        ).all()
        assert reach_slugs == ["international"]
        assert event.reach == "international"
