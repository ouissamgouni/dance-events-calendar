"""Curated synonym map for the heuristic tag suggester.

Keys are tag *slugs* (matching ``Tag.slug``). Values are lists of additional
terms (lowercase, whole-word matched) that should also count as a hit for that
tag — beyond the tag's own ``slug`` and ``label``.

This is intentionally a hand-curated module rather than a DB-backed table so
the v1 ships without an admin editor. A future iteration can move this into
a ``tag_synonyms`` table with a Configuration-tab editor; the engine in
``tag_suggester.py`` only depends on the dict shape.

Notes:
- Multi-word phrases are matched as substrings (no word boundary at internal
  spaces); single-word terms are matched as whole words (``\\b...\\b``).
- Keep entries in lowercase. Hyphens and accents are normalised by the engine.
"""

from __future__ import annotations

# Mapping ``tag_slug`` -> list of synonym terms.
# Tag slugs not present here still match on their own slug/label.
TAG_SYNONYMS: dict[str, list[str]] = {
    # Dance styles
    "salsa": ["salsa cubana", "salsa on1", "salsa on2", "casino", "rueda"],
    "bachata": ["bachata sensual", "bachata moderna", "bachata dominicana"],
    "kizomba": ["urban kiz", "kiz", "tarraxo", "tarraxinha", "ghetto zouk"],
    "zouk": ["brazilian zouk", "lambazouk"],
    "merengue": [],
    "cha-cha": ["chachacha", "cha cha cha", "cha-cha-cha"],
    "reggaeton": ["reggaetón", "perreo"],
    # Format
    "social": ["social dance", "fiesta", "party", "soirée", "soiree", "noche"],
    "workshop": [
        "workshops",
        "class",
        "classes",
        "lesson",
        "lessons",
        "course",
        "stage",
    ],
    "festival": ["congress", "weekender", "marathon", "encuentro"],
    "bootcamp": ["intensive", "boot camp"],
    "show": ["showcase", "performance", "demo", "exhibition"],
    "competition": ["jack and jill", "j&j", "battle", "contest"],
    # Level
    "beginner": ["beginners", "absolute beginner", "intro", "introduction", "starter"],
    "intermediate": ["improver", "improvers", "int", "intermediate-advanced"],
    "advanced": ["advanced level", "adv"],
    "all-levels": ["all level", "open level", "tous niveaux"],
    # Music / vibe
    "live-music": ["live band", "live orchestra", "live percussion", "live drummers"],
    "dj": ["dj set", "djs", "live dj set"],
    # Setting
    "outdoor": ["open air", "open-air", "park", "rooftop", "terrace", "beach"],
    "indoor": ["indoors"],
    # Pricing
    "free": ["free entry", "no cover", "gratis", "gratuit", "free admission"],
    "donation": ["pay what you want", "pwyc", "donation based"],
}
