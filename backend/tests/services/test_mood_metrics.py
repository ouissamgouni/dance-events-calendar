"""Unit tests for the pure overall-mood computation helpers.

Covers the sentiment-weighted average, positive/neutral/negative percentages,
the label bands (keyed on the *unrounded* average), and the review-count
display gate — plus the series-level edition-fair headline.
"""

from __future__ import annotations

import pytest

from backend.services.experience_aspects import (
    compute_mood_metrics,
    mood_label_for,
    mood_metrics_from_averages,
)


@pytest.mark.unit
def test_no_reviews_is_none_state():
    m = compute_mood_metrics({}, min_reviews=3)
    assert m.review_count == 0
    assert m.average_mood == 0.0
    assert m.mood_label is None
    assert m.display_state == "none"


@pytest.mark.unit
def test_below_threshold_is_early_without_label():
    m = compute_mood_metrics({"amazing": 2}, min_reviews=3)
    assert m.review_count == 2
    assert m.display_state == "early"
    assert m.mood_label is None
    # Percentages still computed for the "early feedback" UI.
    assert m.positive_percentage == 100.0


@pytest.mark.unit
def test_full_state_average_and_percentages():
    # 2 amazing(5) + 1 great(4) + 1 okay(3) + 1 bad(1) = 18 / 5 = 3.6
    counts = {"amazing": 2, "great": 1, "okay": 1, "bad": 1}
    m = compute_mood_metrics(counts, min_reviews=3)
    assert m.review_count == 5
    assert m.average_mood == pytest.approx(3.6)
    assert m.positive_percentage == pytest.approx(60.0)
    assert m.neutral_percentage == pytest.approx(20.0)
    assert m.negative_percentage == pytest.approx(20.0)
    assert m.display_state == "full"
    assert m.mood_label == "Well received"  # 3.50–3.99 band


@pytest.mark.unit
@pytest.mark.parametrize(
    "avg,label",
    [
        (5.0, "Exceptional"),
        (4.5, "Exceptional"),
        (4.49, "Highly enjoyed"),
        (4.0, "Highly enjoyed"),
        (3.99, "Well received"),
        (3.5, "Well received"),
        (3.49, "Mixed experiences"),
        (2.75, "Mixed experiences"),
        (2.74, "Disappointing overall"),
        (2.0, "Disappointing overall"),
        (1.99, "Mostly negative"),
        (1.0, "Mostly negative"),
    ],
)
def test_label_bands(avg, label):
    assert mood_label_for(avg) == label


@pytest.mark.unit
def test_series_headline_is_unweighted_mean_of_editions():
    # Two editions: one small 5.0-avg edition, one large 3.0-avg edition.
    # Unweighted headline = (5.0 + 3.0) / 2 = 4.0, NOT pooled toward the big one.
    m = mood_metrics_from_averages(
        edition_averages=[5.0, 3.0],
        total_reviews=100,
        positive_percentages=[100.0, 20.0],
        min_reviews=3,
    )
    assert m.average_mood == pytest.approx(4.0)
    assert m.positive_percentage == pytest.approx(60.0)
    assert m.review_count == 100
    assert m.display_state == "full"
    assert m.mood_label == "Highly enjoyed"


@pytest.mark.unit
def test_series_below_threshold_is_early():
    m = mood_metrics_from_averages(
        edition_averages=[4.0],
        total_reviews=2,
        positive_percentages=[80.0],
        min_reviews=3,
    )
    assert m.display_state == "early"
    assert m.mood_label is None


@pytest.mark.unit
def test_series_no_reviewed_editions_is_none():
    m = mood_metrics_from_averages(
        edition_averages=[],
        total_reviews=0,
        positive_percentages=[],
        min_reviews=3,
    )
    assert m.display_state == "none"
    assert m.average_mood == 0.0
