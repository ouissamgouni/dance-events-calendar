#!/usr/bin/env python3
"""One-off: enhance review tags in scenarios/{prod,staging,default}/tags.yaml.

Text-based edits (not a YAML round-trip) so the extensive taxonomy comments and
existing formatting are preserved. Idempotent: re-running is a no-op once applied.

Changes:
  1. Remove the disabled `live-band` tag from the event-scope `venue` group.
  2. Add a new `refreshments` aspect group (water / coffee / snacks / food).
  3. Add lead/follow balance tags to the `atmosphere` aspect group.
  4. Trim the `audience` group (drop 6 redundant tags, add `foodies`).
"""

from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
FILES = [
    REPO_ROOT / "scenarios" / s / "tags.yaml" for s in ("prod", "staging", "default")
]

# 1. Disabled venue tag to strip (present only in prod + staging).
VENUE_LIVE_BAND_OLD = """      - slug: rooftop
        label: Rooftop
        synonyms: ["roof top", "terrace"]
      - slug: live-band
        label: Live band
        enabled: false
        synonyms:
          ["live music", "live orchestra", "live percussion", "live drummers"]
      - slug: pool
        label: Pool
        ordinal: 4"""
VENUE_LIVE_BAND_NEW = """      - slug: rooftop
        label: Rooftop
        synonyms: ["roof top", "terrace"]
      - slug: pool
        label: Pool
        ordinal: 4"""

# 2. New refreshments aspect group, inserted between the `shows` group and the
#    audience comment banner.
REFRESHMENTS_ANCHOR = """      - { slug: delayed-shows, label: Delayed, polarity: negative }

  # ─────────────────────────────────────────────────────────────────────
  # Recommendation audience (scope: audience)."""
REFRESHMENTS_NEW = """      - { slug: delayed-shows, label: Delayed, polarity: negative }

  - slug: refreshments
    label: 🥤 Refreshments
    ordinal: 107
    allow_multiple: true
    color: "#f59e0b"
    scope: aspect
    tags:
      - { slug: free-water, label: Free water, polarity: positive }
      - { slug: free-coffee, label: "Free coffee & tea", polarity: positive }
      - { slug: free-snacks, label: Free snacks, polarity: positive }
      - { slug: free-food, label: Free food, polarity: positive }
      - { slug: food-available, label: Food available }
      - { slug: drinks-available, label: Drinks available }

  # ─────────────────────────────────────────────────────────────────────
  # Recommendation audience (scope: audience)."""

# 3. Lead/follow balance tags appended to the `atmosphere` group.
ATMOSPHERE_OLD = """      - { slug: large-event, label: Large event }

  - slug: venue-quality"""
ATMOSPHERE_NEW = """      - { slug: large-event, label: Large event }
      - {
          slug: good-gender-balance,
          label: Good lead/follow balance,
          polarity: positive,
        }
      - {
          slug: gender-imbalance,
          label: Lead/follow imbalance,
          polarity: negative,
        }

  - slug: venue-quality"""

# 4. Trim the audience group.
AUDIENCE_OLD = """      - { slug: budget-friendly, label: Budget-friendly }
      - { slug: drinks-lovers, label: Drinks lovers }
      - { slug: food-lovers, label: Food lovers }
      - { slug: performance-lovers, label: 🎭 Performance lovers }
      - { slug: beginners, label: Beginner }
      - { slug: intermediate, label: Intermediate }
      - { slug: advanced, label: Advanced }
      - { slug: live-music-fans, label: 🎺 Live music lovers }"""
AUDIENCE_NEW = """      - { slug: budget-friendly, label: Budget-friendly }
      - { slug: performance-lovers, label: 🎭 Performance lovers }
      - { slug: foodies, label: "Food & drinks lovers" }"""


def apply(text: str) -> str:
    if "slug: refreshments" in text:
        return text  # already applied

    # Required replacements (must be present in every file).
    for old, new, name in (
        (REFRESHMENTS_ANCHOR, REFRESHMENTS_NEW, "refreshments group"),
        (ATMOSPHERE_OLD, ATMOSPHERE_NEW, "atmosphere tags"),
        (AUDIENCE_OLD, AUDIENCE_NEW, "audience trim"),
    ):
        if old not in text:
            raise SystemExit(f"Anchor not found for {name}")
        text = text.replace(old, new, 1)

    # Optional replacement (disabled venue tag only exists in prod + staging).
    if VENUE_LIVE_BAND_OLD in text:
        text = text.replace(VENUE_LIVE_BAND_OLD, VENUE_LIVE_BAND_NEW, 1)

    return text


def main() -> None:
    for path in FILES:
        original = path.read_text()
        updated = apply(original)
        if updated == original:
            print(f"skip (already applied): {path}")
            continue
        # Validate the result parses and contains the new tags.
        parsed = yaml.safe_load(updated)
        slugs = {t["slug"] for g in parsed["tag_groups"] for t in g.get("tags", [])}
        assert "free-water" in slugs and "foodies" in slugs, (
            "post-edit sanity check failed"
        )
        path.write_text(updated)
        print(f"updated: {path}")


if __name__ == "__main__":
    main()
