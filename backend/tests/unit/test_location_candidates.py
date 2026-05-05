"""Unit tests for location_candidates.extract_candidates."""

import pytest

from backend.services.location_candidates import (
    _decode_maps_url,
    extract_candidates,
)


@pytest.mark.unit
class TestDecodeMapsUrl:
    def test_q_param(self):
        url = "https://www.google.com/maps?q=9+Rue+de+Lappe%2C+Paris"
        assert _decode_maps_url(url) == "9 Rue de Lappe, Paris"

    def test_query_param(self):
        url = "https://maps.google.com/maps?query=Eiffel+Tower%2C+Paris"
        assert _decode_maps_url(url) == "Eiffel Tower, Paris"

    def test_place_path(self):
        url = "https://www.google.com/maps/place/Le+Balajo/@48.8547,2.3680"
        assert _decode_maps_url(url) == "Le Balajo"

    def test_invalid_url_returns_none(self):
        assert _decode_maps_url("not-a-url") is None

    def test_maps_url_without_q_or_place_returns_none(self):
        url = "https://maps.google.com/maps"
        assert _decode_maps_url(url) is None


@pytest.mark.unit
class TestExtractCandidates:
    # ── Location only ────────────────────────────────────────────────────────

    def test_raw_location_is_first_candidate(self):
        candidates = extract_candidates("Studio Latina, Paris", None)
        assert candidates[0] == "Studio Latina, Paris"

    def test_locale_hint_appended_as_second_candidate(self):
        candidates = extract_candidates(
            "Salsa O'sulli", None, locale_hint="Paris, France"
        )
        assert candidates == ["Salsa O'sulli", "Salsa O'sulli, Paris, France"]

    def test_no_location_no_description_returns_empty(self):
        assert extract_candidates(None, None) == []

    def test_empty_location_treated_as_none(self):
        candidates = extract_candidates("   ", None)
        assert candidates == []

    # ── Description Maps URL ─────────────────────────────────────────────────

    def test_maps_url_decoded_from_description(self):
        desc = (
            "See you at https://maps.google.com/maps?q=Le+Balajo%2C+Paris for the party"
        )
        candidates = extract_candidates(None, desc)
        assert "Le Balajo, Paris" in candidates

    def test_maps_url_appended_with_locale_hint(self):
        desc = "At https://maps.google.com/maps?q=O%27sullivans for salsa"
        candidates = extract_candidates(None, desc, locale_hint="Paris, France")
        assert "O'sullivans" in candidates
        assert "O'sullivans, Paris, France" in candidates

    # ── Description address fragments ────────────────────────────────────────

    def test_address_fragment_extracted_from_description(self):
        desc = "Come to 9 Rue de Lappe for the event. Doors open at 21h."
        candidates = extract_candidates(None, desc)
        assert any("9 Rue de Lappe" in c for c in candidates)

    # ── Deduplication ────────────────────────────────────────────────────────

    def test_duplicates_not_repeated(self):
        # location and a maps URL decode to the same string
        desc = "https://maps.google.com/maps?q=Le+Balajo"
        candidates = extract_candidates("Le Balajo", desc)
        assert candidates.count("Le Balajo") == 1

    # ── Ordering ─────────────────────────────────────────────────────────────

    def test_raw_location_before_description_fragments(self):
        desc = "Located at 42 Avenue Montaigne, Paris."
        candidates = extract_candidates("Club Salsa", desc)
        assert candidates.index("Club Salsa") < candidates.index(
            next(c for c in candidates if "42 Avenue" in c)
        )

    # ── Full real-world-like scenario ────────────────────────────────────────

    def test_venue_name_with_locale_hint_and_description(self):
        candidates = extract_candidates(
            location="L'Ampli",
            description="Join us at https://maps.google.com/maps/place/L%27Ampli/@48.8,2.3 for salsa night.",
            locale_hint="Fontenay-le-Fleury, France",
        )
        # Raw location should be first
        assert candidates[0] == "L'Ampli"
        # Locale-hinted raw location should be second
        assert candidates[1] == "L'Ampli, Fontenay-le-Fleury, France"
        # No duplicates
        assert len(candidates) == len(set(candidates))
