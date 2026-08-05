"""Catalog + helpers for the adaptive review system.

Review *aspects* (Music, Venue, ...) are admin-managed as ``TagGroup`` rows
with ``scope='aspect'`` whose tags each carry a ``polarity``. ``DEFAULT_ASPECTS``
below is only the seed set used to create those groups on first boot; runtime
validation and aggregation read the live aspect slugs from the database via
``get_aspect_slugs``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, NamedTuple

if TYPE_CHECKING:
    from sqlmodel import Session


class ExperienceAspect(NamedTuple):
    slug: str
    label: str
    ordinal: int
    # scope='aspect' groups are offered in the review flow only when the event
    # carries one of these tag slugs. Empty tuple = always shown.
    condition_tag_slugs: tuple[str, ...] = ()


DEFAULT_ASPECTS: list[ExperienceAspect] = [
    ExperienceAspect("music", "Music", 0),
    ExperienceAspect("atmosphere", "Atmosphere", 1),
    ExperienceAspect("venue", "Venue", 2),
    ExperienceAspect("organization", "Organization", 3),
    ExperienceAspect("value", "Value", 4),
    ExperienceAspect("workshop", "Workshop", 5, ("format:workshop", "format:class")),
]

# Headline sentiment drives the internal 1-5 ``stars`` score used only to
# order reviews (no overall star is ever shown to users).
SENTIMENT_VALUES: list[str] = ["amazing", "great", "okay", "disappointing", "bad"]
SENTIMENT_TO_SCORE: dict[str, int] = {
    "amazing": 5,
    "great": 4,
    "okay": 3,
    "disappointing": 2,
    "bad": 1,
}

# Public "Overall Mood" label bands, keyed on the *unrounded* average mood.
# (lower_bound_inclusive, label). Ordered high → low; first match wins.
MOOD_LABEL_BANDS: list[tuple[float, str]] = [
    (4.50, "Exceptional"),
    (4.00, "Highly enjoyed"),
    (3.50, "Well received"),
    (2.75, "Mixed experiences"),
    (2.00, "Disappointing overall"),
    (1.00, "Mostly negative"),
]


class MoodMetrics(NamedTuple):
    """Computed overall-mood figures for one aggregation (event or series).

    Percentages are unrounded (0-100); callers round for display. ``mood_label``
    is ``None`` until the review count clears the configured threshold, and
    ``display_state`` is one of ``none`` / ``early`` / ``full``.
    """

    review_count: int
    average_mood: float
    positive_percentage: float
    neutral_percentage: float
    negative_percentage: float
    mood_label: str | None
    display_state: str


def mood_label_for(average_mood: float) -> str | None:
    """Return the public headline label for an *unrounded* average mood."""
    for lower, label in MOOD_LABEL_BANDS:
        if average_mood >= lower:
            return label
    return None


def compute_mood_metrics(
    sentiment_counts: dict[str, int], min_reviews: int
) -> MoodMetrics:
    """Derive overall-mood figures from per-sentiment counts.

    ``sentiment_counts`` maps each sentiment value (amazing…bad) to its count;
    unknown keys are ignored. Average mood weights each sentiment by
    :data:`SENTIMENT_TO_SCORE`. The computed ``mood_label`` is only populated
    once ``review_count >= min_reviews`` (``display_state == 'full'``).
    """
    counts = {s: int(sentiment_counts.get(s, 0) or 0) for s in SENTIMENT_VALUES}
    review_count = sum(counts.values())
    if review_count == 0:
        return MoodMetrics(0, 0.0, 0.0, 0.0, 0.0, None, "none")

    weighted = sum(counts[s] * SENTIMENT_TO_SCORE[s] for s in SENTIMENT_VALUES)
    average_mood = weighted / review_count
    positive = (counts["amazing"] + counts["great"]) / review_count * 100
    neutral = counts["okay"] / review_count * 100
    negative = (counts["disappointing"] + counts["bad"]) / review_count * 100

    if review_count >= max(1, min_reviews):
        display_state = "full"
        label = mood_label_for(average_mood)
    else:
        display_state = "early"
        label = None

    return MoodMetrics(
        review_count=review_count,
        average_mood=average_mood,
        positive_percentage=positive,
        neutral_percentage=neutral,
        negative_percentage=negative,
        mood_label=label,
        display_state=display_state,
    )


def mood_metrics_from_averages(
    edition_averages: list[float],
    total_reviews: int,
    positive_percentages: list[float],
    min_reviews: int,
) -> MoodMetrics:
    """Series roll-up: edition-fair headline over per-edition figures.

    ``edition_averages`` / ``positive_percentages`` contain one entry per
    *reviewed* edition (0-review editions excluded). The headline average and
    positive percentage are the unweighted means of those per-edition values,
    while the display gate uses ``total_reviews`` (pooled) against
    ``min_reviews`` — the same review-count gate applied to single events.
    """
    if not edition_averages or total_reviews == 0:
        return MoodMetrics(total_reviews, 0.0, 0.0, 0.0, 0.0, None, "none")

    average_mood = sum(edition_averages) / len(edition_averages)
    positive = (
        sum(positive_percentages) / len(positive_percentages)
        if positive_percentages
        else 0.0
    )

    if total_reviews >= max(1, min_reviews):
        display_state = "full"
        label = mood_label_for(average_mood)
    else:
        display_state = "early"
        label = None

    return MoodMetrics(
        review_count=total_reviews,
        average_mood=average_mood,
        positive_percentage=positive,
        neutral_percentage=0.0,
        negative_percentage=0.0,
        mood_label=label,
        display_state=display_state,
    )


def get_aspect_slugs(session: "Session") -> set[str]:
    """Return the set of live aspect slugs (scope='aspect' tag groups)."""
    from sqlmodel import select

    from backend.db.models import TagGroup

    rows = session.exec(select(TagGroup.slug).where(TagGroup.scope == "aspect")).all()
    return set(rows)
