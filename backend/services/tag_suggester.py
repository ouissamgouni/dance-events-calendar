"""Heuristic tag suggester.

Pure, synchronous, no DB writes / no network calls. Given an event's textual
content (title + description + location) and the current tag taxonomy,
returns a list of ``(tag_id, confidence, matched_terms)`` tuples ranked by
confidence and capped at ``MAX_SUGGESTIONS_PER_EVENT``.

Design goals
------------
* **Deterministic** — same inputs → same outputs. Easy to unit-test, no
  external API dependencies.
* **Cheap** — runs in microseconds per event; safe to invoke inline during
  sync and on-demand from admin endpoints.
* **Pluggable** — the engine takes a ``TaxonomySnapshot`` so callers can
  cache the snapshot across many events (e.g. during a bulk run).

Confidence scoring
------------------
Per tag the highest-tier match wins:

* 0.95 — exact label or slug match (whole-word, case-insensitive)
* 0.80 — synonym from ``TAG_SYNONYMS`` map
* 0.70 — token from label/synonym appears in *title* only
* 0.55 — token from label/synonym appears in *description* only

After per-tag scoring:

* Tags below ``MIN_CONFIDENCE`` are dropped.
* When a ``TagGroup`` has ``allow_multiple=False`` only the top-scoring tag
  in that group is kept.
* The result is sorted by confidence desc, then by group ordinal/tag ordinal
  for stability, and capped at ``MAX_SUGGESTIONS_PER_EVENT``.
"""

from __future__ import annotations

import logging
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Iterable, Optional, Sequence

from sqlmodel import Session, select

from backend.db.models import Tag, TagGroup

logger = logging.getLogger(__name__)

MIN_CONFIDENCE: float = 0.5
MAX_SUGGESTIONS_PER_EVENT: int = 8

# Confidence tiers (kept as constants so tests can reference them).
SCORE_EXACT: float = 0.95
SCORE_SYNONYM: float = 0.80
SCORE_TITLE_ONLY: float = 0.70
SCORE_DESCRIPTION_ONLY: float = 0.55


@dataclass(frozen=True)
class TagCandidate:
    tag_id: int
    confidence: float
    matched_terms: tuple[str, ...]


@dataclass
class _IndexedTag:
    tag_id: int
    slug: str
    label: str
    group_id: int
    group_ordinal: int
    tag_ordinal: int
    allow_multiple: bool
    # Normalised search terms: (term, is_phrase). Phrases are substring-matched;
    # single tokens are whole-word matched.
    terms: tuple[tuple[str, bool], ...] = field(default_factory=tuple)


@dataclass
class TaxonomySnapshot:
    """Frozen view of the enabled, event-scope tag taxonomy.

    Built once per ``TagSuggester`` instance (or per bulk run) so we don't
    re-query the DB for every event.
    """

    tags: tuple[_IndexedTag, ...]


def _normalise(text: str) -> str:
    """Lowercase + strip accents + collapse whitespace.

    Hyphens are kept (they're meaningful for "all-levels", "cha-cha" etc.).
    """
    if not text:
        return ""
    nfkd = unicodedata.normalize("NFKD", text)
    no_accents = "".join(c for c in nfkd if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", no_accents.lower()).strip()


def _candidate_terms(slug: str, label: str, synonyms: list[str]) -> list[str]:
    """Build the base set of search terms for a tag (slug + label + synonyms).

    Slugs use ``-``; we also add the space-separated form so "all-levels"
    matches "all levels".
    """
    out: set[str] = set()
    for raw in (slug, label, *synonyms):
        n = _normalise(raw)
        if not n:
            continue
        out.add(n)
        if "-" in n:
            out.add(n.replace("-", " "))
    return [t for t in out if t]


def _build_indexed_tag(
    tag: Tag,
    group: TagGroup,
    synonyms: Optional[list[str]] = None,
) -> _IndexedTag:
    raw_terms = _candidate_terms(tag.slug, tag.label, list(synonyms or []))
    terms: list[tuple[str, bool]] = []
    for term in raw_terms:
        terms.append((term, " " in term))
    return _IndexedTag(
        tag_id=tag.id,
        slug=tag.slug,
        label=tag.label,
        group_id=group.id,
        group_ordinal=group.ordinal,
        tag_ordinal=tag.ordinal,
        allow_multiple=group.allow_multiple,
        terms=tuple(terms),
    )


def load_taxonomy(session: Session) -> TaxonomySnapshot:
    """Load enabled, event-scope tags + their groups into an immutable snapshot.

    Synonym terms come exclusively from the ``tag_synonyms`` table — the
    runtime engine never falls back to the static seed map. The static map
    in :mod:`backend.services.tag_synonyms` is a one-time *seed* used by
    :meth:`backend.db.seed.SeedManager._seed_tag_synonyms_defaults` on fresh
    installs and by scenario seeds; admins are then free to add, edit or
    delete every term via the admin UI without the deleted terms re-appearing.
    """
    from backend.db.models import TagSynonym  # local import: avoid cycles in tests

    rows = session.exec(
        select(Tag, TagGroup)
        .join(TagGroup, TagGroup.id == Tag.group_id)
        .where(Tag.enabled.is_(True))
        .where(TagGroup.enabled.is_(True))
        .where(TagGroup.scope == "event")
    ).all()

    # Bulk-load synonyms for all loaded tags (single query).
    tag_ids = [t.id for t, _ in rows if t.id]
    syn_map: dict[int, list[str]] = {}
    if tag_ids:
        syn_rows = session.exec(
            select(TagSynonym).where(TagSynonym.tag_id.in_(tag_ids))
        ).all()
        for s in syn_rows:
            syn_map.setdefault(s.tag_id, []).append(s.term)

    indexed: list[_IndexedTag] = []
    for tag, group in rows:
        if not tag.id:
            continue
        synonyms = syn_map.get(tag.id, [])
        indexed.append(_build_indexed_tag(tag, group, synonyms))
    return TaxonomySnapshot(tags=tuple(indexed))


def _match_term(term: str, is_phrase: bool, haystack: str) -> bool:
    """Whole-word for single tokens, substring for multi-word phrases."""
    if not haystack:
        return False
    if is_phrase:
        return term in haystack
    # Whole-word match. The term may contain hyphens (e.g. "all-levels"); treat
    # those as part of the word. Wrap in lookarounds to avoid \b weirdness.
    pattern = rf"(?<![\w-]){re.escape(term)}(?![\w-])"
    return re.search(pattern, haystack) is not None


def _score_tag(
    indexed: _IndexedTag,
    norm_title: str,
    norm_description: str,
    norm_location: str,
) -> Optional[TagCandidate]:
    """Return the best (highest-confidence) match for a single tag, or None."""
    matched_in_title: list[str] = []
    matched_in_description: list[str] = []
    matched_in_location: list[str] = []
    matched_synonym = False
    canonical_terms = {_normalise(indexed.slug), _normalise(indexed.label)}

    for term, is_phrase in indexed.terms:
        in_title = _match_term(term, is_phrase, norm_title)
        in_desc = _match_term(term, is_phrase, norm_description)
        in_loc = _match_term(term, is_phrase, norm_location)
        if not (in_title or in_desc or in_loc):
            continue
        if in_title:
            matched_in_title.append(term)
        if in_desc:
            matched_in_description.append(term)
        if in_loc:
            matched_in_location.append(term)
        if term not in canonical_terms:
            matched_synonym = True

    all_matched = matched_in_title + matched_in_description + matched_in_location
    if not all_matched:
        return None

    has_canonical_hit = any(t in canonical_terms for t in all_matched)
    in_anywhere = bool(matched_in_title or matched_in_location) or bool(
        matched_in_description
    )

    if has_canonical_hit and in_anywhere:
        confidence = SCORE_EXACT
    elif matched_synonym:
        confidence = SCORE_SYNONYM
    elif matched_in_title or matched_in_location:
        confidence = SCORE_TITLE_ONLY
    else:
        confidence = SCORE_DESCRIPTION_ONLY

    # Dedup matched terms while preserving first-seen order.
    seen: set[str] = set()
    unique_terms: list[str] = []
    for term in all_matched:
        if term in seen:
            continue
        seen.add(term)
        unique_terms.append(term)

    return TagCandidate(
        tag_id=indexed.tag_id,
        confidence=confidence,
        matched_terms=tuple(unique_terms),
    )


def suggest_tags(
    snapshot: TaxonomySnapshot,
    *,
    title: Optional[str],
    description: Optional[str],
    location: Optional[str] = None,
    excluded_tag_ids: Iterable[int] = (),
) -> list[TagCandidate]:
    """Score every tag in ``snapshot`` against the event text and return the
    top candidates above ``MIN_CONFIDENCE``.

    ``excluded_tag_ids`` removes tags the event already has (no point
    suggesting an already-applied tag) or tags rejected within the
    suppression window.
    """
    norm_title = _normalise(title or "")
    norm_description = _normalise(description or "")
    norm_location = _normalise(location or "")
    if not (norm_title or norm_description or norm_location):
        return []

    excluded = set(excluded_tag_ids)
    scored: list[tuple[_IndexedTag, TagCandidate]] = []
    for indexed in snapshot.tags:
        if indexed.tag_id in excluded:
            continue
        candidate = _score_tag(indexed, norm_title, norm_description, norm_location)
        if candidate is None or candidate.confidence < MIN_CONFIDENCE:
            continue
        scored.append((indexed, candidate))

    # Enforce single-pick groups: keep only the top candidate per
    # ``allow_multiple=False`` group.
    by_group_top: dict[int, tuple[_IndexedTag, TagCandidate]] = {}
    multi_keep: list[tuple[_IndexedTag, TagCandidate]] = []
    for indexed, candidate in scored:
        if indexed.allow_multiple:
            multi_keep.append((indexed, candidate))
            continue
        cur = by_group_top.get(indexed.group_id)
        if cur is None or candidate.confidence > cur[1].confidence:
            by_group_top[indexed.group_id] = (indexed, candidate)

    final = multi_keep + list(by_group_top.values())
    final.sort(
        key=lambda pair: (
            -pair[1].confidence,
            pair[0].group_ordinal,
            pair[0].tag_ordinal,
            pair[0].tag_id,
        )
    )
    return [c for _, c in final[:MAX_SUGGESTIONS_PER_EVENT]]


class TagSuggester:
    """Thin convenience wrapper around the snapshot + suggest_tags fn.

    Holds a cached snapshot for the lifetime of the instance so a bulk run
    doesn't re-query the taxonomy per event.
    """

    def __init__(self, session: Session) -> None:
        self._session = session
        self._snapshot: Optional[TaxonomySnapshot] = None

    @property
    def snapshot(self) -> TaxonomySnapshot:
        if self._snapshot is None:
            self._snapshot = load_taxonomy(self._session)
        return self._snapshot

    def suggest(
        self,
        *,
        title: Optional[str],
        description: Optional[str],
        location: Optional[str] = None,
        excluded_tag_ids: Sequence[int] = (),
    ) -> list[TagCandidate]:
        return suggest_tags(
            self.snapshot,
            title=title,
            description=description,
            location=location,
            excluded_tag_ids=excluded_tag_ids,
        )
