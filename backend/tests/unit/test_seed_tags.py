from datetime import datetime

import pytest
from sqlmodel import Session, SQLModel, create_engine, select

from backend.db.models import Tag, TagGroup, TagSynonym
from backend.db.seed import DatabaseSeeder


@pytest.fixture
def session():
    engine = create_engine("sqlite://")
    SQLModel.metadata.create_all(engine)
    with Session(engine) as sess:
        yield sess


def test_seed_tags_rewrites_existing_synonyms_without_unique_violation(
    session: Session, tmp_path
):
    group = TagGroup(
        slug="format",
        label="Format",
        ordinal=10,
        allow_multiple=True,
        enabled=True,
        scope="event",
    )
    session.add(group)
    session.flush()

    social = Tag(group_id=group.id, slug="social", label="Social", ordinal=0)
    class_tag = Tag(group_id=group.id, slug="class", label="Class", ordinal=1)
    session.add(social)
    session.add(class_tag)
    session.flush()
    session.add(
        TagSynonym(
            tag_id=social.id,
            term="social dance",
            created_at=datetime.utcnow(),
        )
    )
    session.commit()

    tags_yaml = tmp_path / "tags.yaml"
    tags_yaml.write_text(
        """
tag_groups:
  - slug: format
    label: Format
    ordinal: 10
    allow_multiple: true
    tags:
      - slug: social
        label: Social
        synonyms: [\"social dance\", \"fiesta\"]
      - slug: class
        label: Class
        synonyms: [\"lesson\"]
""".strip()
    )

    DatabaseSeeder(session)._seed_tags(tags_yaml)
    session.commit()

    social_synonyms = session.exec(
        select(TagSynonym.term)
        .where(TagSynonym.tag_id == social.id)
        .order_by(TagSynonym.term)
    ).all()
    class_synonyms = session.exec(
        select(TagSynonym.term)
        .where(TagSynonym.tag_id == class_tag.id)
        .order_by(TagSynonym.term)
    ).all()

    assert social_synonyms == ["fiesta", "social dance"]
    assert class_synonyms == ["lesson"]
