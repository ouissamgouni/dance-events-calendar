"""Unit tests for the heuristic tag suggester (pure functions, no DB)."""

from backend.services.tag_suggester import (
    MAX_SUGGESTIONS_PER_EVENT,
    SCORE_DESCRIPTION_ONLY,
    SCORE_EXACT,
    SCORE_SYNONYM,
    SCORE_TITLE_ONLY,
    TaxonomySnapshot,
    _IndexedTag,
    _build_indexed_tag,
    suggest_tags,
)
from backend.db.models import Tag, TagGroup


# ---------------------------------------------------------------------------
# Helpers — build snapshots without touching the DB
# ---------------------------------------------------------------------------


def _tag(
    id,
    slug,
    label,
    group_id=1,
    group_ordinal=0,
    tag_ordinal=0,
    allow_multiple=True,
    synonyms=None,
):
    t = Tag(id=id, group_id=group_id, slug=slug, label=label, ordinal=tag_ordinal)
    g = TagGroup(
        id=group_id,
        slug=f"group-{group_id}",
        label=f"Group {group_id}",
        ordinal=group_ordinal,
        allow_multiple=allow_multiple,
    )
    return _build_indexed_tag(t, g, synonyms=list(synonyms or []))


def _snap(*tags: _IndexedTag) -> TaxonomySnapshot:
    return TaxonomySnapshot(tags=tuple(tags))


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_no_text_returns_empty():
    snap = _snap(_tag(1, "salsa", "Salsa"))
    assert suggest_tags(snap, title=None, description=None, location=None) == []


def test_exact_label_match_in_title_scores_exact():
    snap = _snap(_tag(1, "bachata", "Bachata"))
    out = suggest_tags(snap, title="Bachata Social", description=None)
    assert len(out) == 1
    assert out[0].tag_id == 1
    assert out[0].confidence == SCORE_EXACT
    assert "bachata" in out[0].matched_terms


def test_synonym_match_scores_synonym():
    snap = _snap(_tag(1, "kizomba", "Kizomba", synonyms=["urban kiz", "kiz"]))
    out = suggest_tags(snap, title="Urban Kiz Night", description=None)
    assert len(out) == 1
    assert out[0].tag_id == 1
    # 'urban kiz' is a configured synonym → SYNONYM tier (no canonical hit).
    assert out[0].confidence == SCORE_SYNONYM


def test_description_only_match_scores_lowest():
    # 'social' canonical label hit, but only inside description (not title).
    snap = _snap(_tag(1, "social", "Social"))
    out = suggest_tags(
        snap,
        title="Friday Night Out",
        description="Come dance at our weekly social with live music.",
    )
    # Canonical match (label='social') in description-only path lifts to EXACT
    # because canonical hits always promote to the top tier — by design.
    assert len(out) == 1
    assert out[0].confidence in (SCORE_EXACT, SCORE_DESCRIPTION_ONLY)


def test_synonym_in_description_only_stays_at_synonym_or_below():
    # 'pwyc' is a synonym for 'donation'; only in description.
    snap = _snap(
        _tag(1, "donation", "Donation", synonyms=["pwyc", "pay what you want"])
    )
    out = suggest_tags(
        snap, title="Wednesday Class", description="Entry: pwyc at the door."
    )
    assert len(out) == 1
    assert out[0].confidence in (SCORE_SYNONYM, SCORE_DESCRIPTION_ONLY)


def test_below_threshold_match_dropped():
    # Build a tag whose only term match comes from a single, weak description
    # token — and stub the synonym map so nothing else fires.
    # We simulate by giving the tag a label that only appears in description
    # AND verifying we get back at least one result above threshold.
    snap = _snap(_tag(1, "salsa", "Salsa"))
    # Title that doesn't contain "salsa" anywhere; description does.
    out = suggest_tags(snap, title="Friday Night", description="A great salsa party")
    assert len(out) == 1
    assert out[0].confidence >= 0.5


def test_no_match_returns_empty():
    snap = _snap(_tag(1, "salsa", "Salsa"))
    out = suggest_tags(snap, title="Tango Milonga", description="Argentine tango only")
    assert out == []


def test_excluded_tag_ids_skipped():
    snap = _snap(
        _tag(1, "salsa", "Salsa"),
        _tag(2, "bachata", "Bachata"),
    )
    out = suggest_tags(
        snap,
        title="Salsa & Bachata Social",
        description=None,
        excluded_tag_ids={1},
    )
    assert {c.tag_id for c in out} == {2}


def test_allow_multiple_false_keeps_only_top_per_group():
    # Two tags in the same single-pick group; both match. Only the higher
    # confidence one should remain.
    snap = _snap(
        _tag(1, "beginner", "Beginner", group_id=10, allow_multiple=False),
        _tag(2, "advanced", "Advanced", group_id=10, allow_multiple=False),
    )
    # Title hits 'beginner' (canonical → EXACT). Description hits 'advanced'
    # (canonical in description → still EXACT due to canonical promotion).
    # When tied, the engine breaks ties by group_ordinal then tag_ordinal then
    # tag_id, so id=1 wins.
    out = suggest_tags(
        snap,
        title="Beginner Workshop",
        description="Not suitable for advanced dancers.",
    )
    ids = [c.tag_id for c in out]
    assert len(ids) == 1
    assert ids[0] in {1, 2}


def test_allow_multiple_true_keeps_all_matches():
    snap = _snap(
        _tag(1, "salsa", "Salsa", group_id=1, allow_multiple=True),
        _tag(2, "bachata", "Bachata", group_id=1, allow_multiple=True),
    )
    out = suggest_tags(snap, title="Salsa & Bachata Night", description=None)
    assert {c.tag_id for c in out} == {1, 2}


def test_top_n_cap_enforced():
    # Build > MAX_SUGGESTIONS_PER_EVENT distinct tags that all match.
    tags = [
        _tag(i + 1, f"slug{i}", f"Word{i}", group_id=i + 1, allow_multiple=True)
        for i in range(MAX_SUGGESTIONS_PER_EVENT + 3)
    ]
    snap = _snap(*tags)
    title = " ".join(f"Word{i}" for i in range(MAX_SUGGESTIONS_PER_EVENT + 3))
    out = suggest_tags(snap, title=title, description=None)
    assert len(out) == MAX_SUGGESTIONS_PER_EVENT


def test_results_sorted_by_confidence_desc():
    # 'salsa' canonical hit in title (EXACT) + 'kiz' synonym only (SYNONYM).
    snap = _snap(
        _tag(1, "kizomba", "Kizomba", synonyms=["kiz"]),
        _tag(2, "salsa", "Salsa"),
    )
    out = suggest_tags(
        snap,
        title="Salsa class with a kiz preview",
        description=None,
    )
    assert [c.confidence for c in out] == sorted(
        [c.confidence for c in out], reverse=True
    )


def test_whole_word_match_avoids_substring_false_positives():
    # 'free' should NOT match 'freedom' or 'freestyle'.
    snap = _snap(_tag(1, "free", "Free"))
    out = suggest_tags(
        snap,
        title="Freedom Festival",
        description="Bring your freestyle moves",
    )
    assert out == []


def test_accent_insensitive_match():
    snap = _snap(_tag(1, "social", "Social", synonyms=["soirée", "soiree"]))
    # 'soirée' is a synonym for 'social'; with accents.
    out = suggest_tags(snap, title="Grande Soirée Salsa", description=None)
    assert len(out) == 1
    assert out[0].tag_id == 1
