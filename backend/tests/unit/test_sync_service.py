"""Unit tests for `compute_content_hash` (the only logic remaining in sync_service)."""

from datetime import datetime

import pytest

from backend.services.sync_service import compute_content_hash


@pytest.mark.unit
class TestComputeContentHash:
    def test_hash_is_deterministic(self):
        start = datetime(2026, 5, 1, 20, 0)
        h1 = compute_content_hash("Salsa Night", start, "Paris")
        h2 = compute_content_hash("Salsa Night", start, "Paris")
        assert h1 == h2

    def test_hash_normalizes_title_case_and_whitespace(self):
        start = datetime(2026, 5, 1, 20, 0)
        h1 = compute_content_hash("Salsa Night", start, "Paris")
        h2 = compute_content_hash("  SALSA NIGHT  ", start, "Paris")
        assert h1 == h2

    def test_hash_normalizes_location_case_and_whitespace(self):
        start = datetime(2026, 5, 1, 20, 0)
        h1 = compute_content_hash("Salsa Night", start, "Paris")
        h2 = compute_content_hash("Salsa Night", start, "  PARIS  ")
        assert h1 == h2

    def test_hash_differs_for_different_title(self):
        start = datetime(2026, 5, 1, 20, 0)
        h1 = compute_content_hash("Salsa Night", start, "Paris")
        h2 = compute_content_hash("Bachata Night", start, "Paris")
        assert h1 != h2

    def test_hash_differs_for_different_start(self):
        h1 = compute_content_hash("Salsa Night", datetime(2026, 5, 1, 20, 0), "Paris")
        h2 = compute_content_hash("Salsa Night", datetime(2026, 5, 2, 20, 0), "Paris")
        assert h1 != h2

    def test_hash_differs_for_different_location(self):
        start = datetime(2026, 5, 1, 20, 0)
        h1 = compute_content_hash("Salsa Night", start, "Paris")
        h2 = compute_content_hash("Salsa Night", start, "Berlin")
        assert h1 != h2

    def test_hash_treats_none_location_as_empty(self):
        start = datetime(2026, 5, 1, 20, 0)
        h1 = compute_content_hash("Salsa Night", start, None)
        h2 = compute_content_hash("Salsa Night", start, "")
        assert h1 == h2
