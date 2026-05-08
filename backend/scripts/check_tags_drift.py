"""Compare tag_groups + tags in the DB against a scenario's tags.yaml.

Reports rows present in DB but missing from YAML (extras) and rows present
in YAML but missing from DB (missing). Useful after deploys to spot
reference-data drift between the curated source-of-truth (scenarios/<env>/)
and what an Alembic migration or stale seed left in the database.

Exit codes:
  0 = no drift
  1 = drift detected
  2 = error (bad args, missing file, DB error)
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

import yaml
from sqlmodel import Session, select

from backend.db.database import get_engine
from backend.db.models import Tag, TagGroup
from backend.db.seed import SCENARIOS_DIR

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger(__name__)


def _load_yaml_tags(tags_yaml: Path) -> dict[str, set[str]]:
    """Return {group_slug: {tag_slug, ...}} from a scenarios/*/tags.yaml file."""
    with open(tags_yaml, encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    groups = data.get("tag_groups") or []
    result: dict[str, set[str]] = {}
    for g in groups:
        gslug = g.get("slug")
        if not gslug:
            continue
        result[gslug] = {t.get("slug") for t in (g.get("tags") or []) if t.get("slug")}
    return result


def _load_db_tags(session: Session) -> dict[str, set[str]]:
    """Return {group_slug: {tag_slug, ...}} from the DB."""
    result: dict[str, set[str]] = {}
    groups = session.exec(select(TagGroup)).all()
    for g in groups:
        tags = session.exec(select(Tag).where(Tag.group_id == g.id)).all()
        result[g.slug] = {t.slug for t in tags}
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--scenario",
        default="prod",
        help="Scenario name (folder under scenarios/) or explicit path. Default: prod",
    )
    args = parser.parse_args()

    candidate = Path(args.scenario)
    if candidate.is_absolute() or "/" in args.scenario:
        scenario_dir = candidate
    else:
        scenario_dir = SCENARIOS_DIR / args.scenario

    tags_yaml = scenario_dir / "tags.yaml"
    if not tags_yaml.exists():
        logger.error("❌ tags.yaml not found: %s", tags_yaml)
        return 2

    yaml_groups = _load_yaml_tags(tags_yaml)

    engine = get_engine()
    with Session(engine) as session:
        db_groups = _load_db_tags(session)

    yaml_group_slugs = set(yaml_groups)
    db_group_slugs = set(db_groups)

    missing_groups = sorted(yaml_group_slugs - db_group_slugs)
    extra_groups = sorted(db_group_slugs - yaml_group_slugs)

    drift = False
    print(f"Scenario : {scenario_dir}")
    print(f"YAML     : {len(yaml_group_slugs)} groups")
    print(f"DB       : {len(db_group_slugs)} groups")
    print()

    if missing_groups:
        drift = True
        print(f"❌ Groups in YAML but missing from DB ({len(missing_groups)}):")
        for slug in missing_groups:
            print(f"   - {slug}  (would add {len(yaml_groups[slug])} tags)")
        print()

    if extra_groups:
        drift = True
        print(f"⚠️  Groups in DB but absent from YAML ({len(extra_groups)}):")
        for slug in extra_groups:
            print(f"   - {slug}  ({len(db_groups[slug])} tags in DB)")
        print()

    for gslug in sorted(yaml_group_slugs & db_group_slugs):
        yaml_tags = yaml_groups[gslug]
        db_tags = db_groups[gslug]
        missing_tags = sorted(yaml_tags - db_tags)
        extra_tags = sorted(db_tags - yaml_tags)
        if not missing_tags and not extra_tags:
            continue
        drift = True
        print(f"Group '{gslug}':")
        if missing_tags:
            print(
                f"   ❌ in YAML, not in DB ({len(missing_tags)}): {', '.join(missing_tags)}"
            )
        if extra_tags:
            print(
                f"   ⚠️  in DB, not in YAML ({len(extra_tags)}): {', '.join(extra_tags)}"
            )
        print()

    if drift:
        print("Drift detected. To reconcile DB to YAML (additive only):")
        print(f"   task db:seed:{args.scenario}")
        print("Note: seed is upsert-only — extras in the DB will NOT be removed.")
        return 1

    print("✅ No drift — DB matches scenarios/{}/ tags.yaml".format(args.scenario))
    return 0


if __name__ == "__main__":
    sys.exit(main())
