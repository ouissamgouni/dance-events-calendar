"""Unit tests for DatabaseSeeder logic."""

import pytest
from unittest.mock import MagicMock, patch
from datetime import date, datetime, timedelta
from pathlib import Path

from backend.db.seed import DatabaseSeeder, resolve_relative_dt


@pytest.mark.unit
class TestResolveRelativeDt:
    """Tests for the 'wN Day HH:MM' relative datetime parser."""

    # Reference Monday used throughout: 2026-04-13
    REF_MONDAY = date(2026, 4, 13)

    def test_same_week_friday(self):
        result = resolve_relative_dt("w0 Fri 20:00", self.REF_MONDAY)
        assert result == datetime(2026, 4, 17, 20, 0)
        assert result.strftime("%a") == "Fri"

    def test_same_week_monday(self):
        result = resolve_relative_dt("w0 Mon 09:30", self.REF_MONDAY)
        assert result == datetime(2026, 4, 13, 9, 30)

    def test_positive_week_offset(self):
        result = resolve_relative_dt("w3 Sat 21:00", self.REF_MONDAY)
        assert result == datetime(2026, 5, 9, 21, 0)
        assert result.strftime("%a") == "Sat"

    def test_negative_week_offset(self):
        result = resolve_relative_dt("w-14 Sat 21:00", self.REF_MONDAY)
        assert result == datetime(2026, 1, 10, 21, 0)
        assert result.strftime("%a") == "Sat"

    def test_large_negative_offset(self):
        result = resolve_relative_dt("w-65 Sat 18:00", self.REF_MONDAY)
        assert result == datetime(2025, 1, 18, 18, 0)
        assert result.strftime("%a") == "Sat"

    def test_base_week_shifts_forward(self):
        result = resolve_relative_dt("w0 Fri 20:00", self.REF_MONDAY, base_week=4)
        assert result == datetime(2026, 5, 15, 20, 0)
        assert result.strftime("%a") == "Fri"

    def test_base_week_negative(self):
        result = resolve_relative_dt("w0 Fri 20:00", self.REF_MONDAY, base_week=-2)
        assert result == datetime(2026, 4, 3, 20, 0)
        assert result.strftime("%a") == "Fri"

    def test_base_week_combined_with_negative_offset(self):
        # base_week=2, w-1 → effective week = 2 + (-1) = 1
        result = resolve_relative_dt("w-1 Sun 10:00", self.REF_MONDAY, base_week=2)
        assert result == datetime(2026, 4, 26, 10, 0)
        assert result.strftime("%a") == "Sun"

    def test_weekday_preserved_across_year_boundary(self):
        result = resolve_relative_dt("w37 Thu 22:00", self.REF_MONDAY)
        assert result == datetime(2026, 12, 31, 22, 0)
        assert result.strftime("%a") == "Thu"

    def test_returns_none_for_iso_format(self):
        result = resolve_relative_dt("2026-04-18T20:00:00", self.REF_MONDAY)
        assert result is None

    def test_returns_none_for_garbage(self):
        result = resolve_relative_dt("not a date", self.REF_MONDAY)
        assert result is None

    def test_midnight_time(self):
        result = resolve_relative_dt("w1 Tue 00:00", self.REF_MONDAY)
        assert result == datetime(2026, 4, 21, 0, 0)

    def test_duration_preserved(self):
        """Start on Friday evening, end on Saturday morning — duration is stable."""
        start = resolve_relative_dt("w0 Fri 20:00", self.REF_MONDAY)
        end = resolve_relative_dt("w0 Sat 02:00", self.REF_MONDAY)
        assert (end - start) == timedelta(hours=6)

    def test_different_reference_monday(self):
        """Same relative string, different seed date → different absolute date, same weekday."""
        ref1 = date(2026, 4, 13)
        ref2 = date(2026, 7, 13)  # 13 weeks later
        r1 = resolve_relative_dt("w0 Fri 20:00", ref1)
        r2 = resolve_relative_dt("w0 Fri 20:00", ref2)
        assert r1.strftime("%a") == r2.strftime("%a") == "Fri"
        assert r1.time() == r2.time()
        assert (r2 - r1).days == 91  # 13 weeks


@pytest.mark.unit
class TestDatabaseSeeder:
    def test_seed_default_scenario_path_exists(self):
        from backend.db.seed import DEFAULT_SCENARIO

        assert DEFAULT_SCENARIO.exists(), (
            f"Default scenario dir does not exist: {DEFAULT_SCENARIO}"
        )
        assert (DEFAULT_SCENARIO / "calendars.yaml").exists()
        assert (DEFAULT_SCENARIO / "events.yaml").exists()
        assert DEFAULT_SCENARIO.name == "calendar-service-mock"

    def test_seed_calendars_yaml_has_expected_structure(self):
        import yaml
        from backend.db.seed import DEFAULT_SCENARIO

        with open(DEFAULT_SCENARIO / "calendars.yaml") as f:
            data = yaml.safe_load(f)

        assert "calendars" in data
        for cal in data["calendars"]:
            assert "id" in cal
            assert "name" in cal

    def test_seed_events_yaml_has_expected_structure(self):
        import yaml
        from backend.db.seed import DEFAULT_SCENARIO

        with open(DEFAULT_SCENARIO / "events.yaml") as f:
            data = yaml.safe_load(f)

        assert "events" in data
        for evt in data["events"]:
            assert "id" in evt
            assert "calendar_id" in evt
            assert "title" in evt
            assert "start" in evt
            assert "end" in evt
