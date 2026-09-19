"""Unit tests for backend.services.recurrence."""

from datetime import datetime, timedelta

import pytest

from backend.services.recurrence import (
    MAX_OCCURRENCES,
    expand_occurrences,
    is_open_ended,
    normalize_dates,
    normalize_rule,
    validate_rule,
)

START = datetime(2025, 3, 3, 20, 0)  # a Monday
END = datetime(2025, 3, 3, 23, 30)


class TestNormalizeRule:
    def test_adds_missing_prefix(self):
        assert (
            normalize_rule("FREQ=WEEKLY;INTERVAL=1") == "RRULE:FREQ=WEEKLY;INTERVAL=1"
        )

    def test_keeps_existing_prefix(self):
        assert normalize_rule("RRULE:FREQ=MONTHLY") == "RRULE:FREQ=MONTHLY"

    def test_rejects_empty(self):
        with pytest.raises(ValueError):
            normalize_rule("   ")

    @pytest.mark.parametrize(
        "rule", ["DTSTART:20250303T200000", "RDATE:20250310T200000"]
    )
    def test_rejects_non_rrule_lines(self, rule):
        with pytest.raises(ValueError):
            normalize_rule(rule)


class TestValidateRule:
    def test_accepts_supported_frequencies(self):
        for freq in ("WEEKLY", "MONTHLY", "YEARLY"):
            assert validate_rule(f"FREQ={freq}") == f"RRULE:FREQ={freq}"

    @pytest.mark.parametrize("freq", ["DAILY", "HOURLY", "MINUTELY", "SECONDLY"])
    def test_rejects_unsupported_frequencies(self, freq):
        with pytest.raises(ValueError):
            validate_rule(f"FREQ={freq}")

    def test_rejects_missing_frequency(self):
        with pytest.raises(ValueError):
            validate_rule("INTERVAL=2")

    def test_rejects_until_and_count_together(self):
        with pytest.raises(ValueError):
            validate_rule("FREQ=WEEKLY;COUNT=4;UNTIL=20250401T000000Z")

    def test_rejects_garbage(self):
        with pytest.raises(ValueError):
            validate_rule("FREQ=WEEKLY;BYDAY=XX")


class TestIsOpenEnded:
    def test_true_without_bound(self):
        assert is_open_ended("FREQ=WEEKLY;INTERVAL=1") is True

    @pytest.mark.parametrize(
        "rule", ["FREQ=WEEKLY;COUNT=10", "FREQ=WEEKLY;UNTIL=20250401T000000Z"]
    )
    def test_false_when_bounded(self, rule):
        assert is_open_ended(rule) is False

    def test_false_when_absent(self):
        assert is_open_ended(None) is False


class TestNormalizeDates:
    def test_sorts_and_deduplicates_by_start(self):
        items = [
            {"start": datetime(2025, 3, 10, 20), "end": datetime(2025, 3, 10, 22)},
            {"start": datetime(2025, 3, 3, 20), "end": datetime(2025, 3, 3, 22)},
            {"start": datetime(2025, 3, 10, 20), "end": datetime(2025, 3, 10, 23)},
        ]
        result = normalize_dates(items)
        assert [pair[0] for pair in result] == [
            datetime(2025, 3, 3, 20),
            datetime(2025, 3, 10, 20),
        ]

    def test_accepts_iso_strings_and_drops_utc_designator(self):
        result = normalize_dates(
            [{"start": "2025-03-03T20:00:00Z", "end": "2025-03-03T23:30:00Z"}]
        )
        assert result == [(START, END)]

    def test_preserves_per_occurrence_duration(self):
        result = normalize_dates(
            [
                {"start": datetime(2025, 3, 3, 20), "end": datetime(2025, 3, 3, 22)},
                {"start": datetime(2025, 3, 10, 20), "end": datetime(2025, 3, 11, 4)},
            ]
        )
        assert result[0][1] - result[0][0] == timedelta(hours=2)
        assert result[1][1] - result[1][0] == timedelta(hours=8)

    def test_rejects_end_before_start(self):
        with pytest.raises(ValueError):
            normalize_dates([{"start": END, "end": START}])

    def test_rejects_missing_field(self):
        with pytest.raises(ValueError):
            normalize_dates([{"start": START}])

    def test_truncates_at_the_ceiling(self):
        items = [
            {"start": START + timedelta(days=i), "end": END + timedelta(days=i)}
            for i in range(MAX_OCCURRENCES + 10)
        ]
        assert len(normalize_dates(items)) == MAX_OCCURRENCES


class TestExpandOccurrences:
    def test_single_occurrence_without_recurrence(self):
        assert expand_occurrences(START, END) == [(START, END)]

    def test_weekly_count_preserves_duration(self):
        result = expand_occurrences(START, END, recurrence_rule="FREQ=WEEKLY;COUNT=3")
        assert [pair[0] for pair in result] == [
            START,
            START + timedelta(days=7),
            START + timedelta(days=14),
        ]
        assert all(end - start == END - START for start, end in result)

    def test_limit_yields_a_stable_index_prefix(self):
        full = expand_occurrences(START, END, recurrence_rule="FREQ=WEEKLY;COUNT=6")
        first = expand_occurrences(
            START, END, recurrence_rule="FREQ=WEEKLY;COUNT=6", limit=1
        )
        assert first == full[:1]

    def test_open_ended_rule_is_bounded_by_the_horizon(self):
        result = expand_occurrences(
            START,
            END,
            recurrence_rule="FREQ=WEEKLY",
            horizon_end=START + timedelta(days=21),
        )
        assert [pair[0] for pair in result] == [
            START,
            START + timedelta(days=7),
            START + timedelta(days=14),
            START + timedelta(days=21),
        ]

    def test_open_ended_rule_is_capped_without_a_horizon(self):
        result = expand_occurrences(START, END, recurrence_rule="FREQ=WEEKLY")
        assert len(result) == MAX_OCCURRENCES

    def test_explicit_dates_take_precedence_over_a_rule(self):
        result = expand_occurrences(
            START,
            END,
            recurrence_rule="FREQ=WEEKLY;COUNT=10",
            recurrence_dates=[{"start": START, "end": END}],
        )
        assert result == [(START, END)]

    def test_unusable_rule_falls_back_to_a_single_occurrence(self):
        assert expand_occurrences(START, END, recurrence_rule="FREQ=DAILY") == [
            (START, END)
        ]
        assert expand_occurrences(START, END, recurrence_rule="not a rule") == [
            (START, END)
        ]
