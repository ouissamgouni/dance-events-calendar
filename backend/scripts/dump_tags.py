"""Read-only dump of tag_groups + tags for reconciling YAML to a live DB."""

from __future__ import annotations

from sqlmodel import Session, select

from backend.db.database import get_engine
from backend.db.models import Tag, TagGroup, TagSynonym


def main() -> None:
    engine = get_engine()
    with Session(engine) as session:
        groups = session.exec(select(TagGroup).order_by(TagGroup.ordinal)).all()
        print(f"# {len(groups)} groups")
        for g in groups:
            print(
                f"GROUP slug={g.slug!r} label={g.label!r} ordinal={g.ordinal} "
                f"scope={g.scope!r} enabled={g.enabled} allow_multiple={g.allow_multiple} "
                f"color={g.color!r} onboarding_eligible={g.onboarding_eligible} "
                f"condition={g.condition_tag_slugs!r}"
            )
            tags = session.exec(
                select(Tag).where(Tag.group_id == g.id).order_by(Tag.ordinal)
            ).all()
            for t in tags:
                syns = session.exec(
                    select(TagSynonym.term)
                    .where(TagSynonym.tag_id == t.id)
                    .order_by(TagSynonym.term)
                ).all()
                syn_str = f" synonyms={list(syns)!r}" if syns else ""
                print(
                    f"    TAG slug={t.slug!r} label={t.label!r} ordinal={t.ordinal} "
                    f"enabled={t.enabled} polarity={t.polarity!r} "
                    f"hero={t.is_hero_filter} hero_ordinal={t.hero_ordinal} color={t.color!r}{syn_str}"
                )


if __name__ == "__main__":
    main()
