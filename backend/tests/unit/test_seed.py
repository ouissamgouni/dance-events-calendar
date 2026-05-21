"""Unit tests for DatabaseSeeder logic."""

import pytest
from datetime import date, datetime, timedelta
from pathlib import Path

from sqlmodel import SQLModel, Session, create_engine, select

from backend.db.models import Tag, TagGroup, User
from backend.db.seed import DatabaseSeeder, resolve_relative_dt
from backend.db import seed as seed_module


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
        from backend.db.seed import SCENARIOS_DIR

        scenario = SCENARIOS_DIR / "calendar-service-mock"
        assert scenario.exists(), f"Scenario dir does not exist: {scenario}"
        assert (scenario / "calendars.yaml").exists()
        assert (scenario / "mock-sync-events.yaml").exists()

    def test_seed_calendars_yaml_has_expected_structure(self):
        import yaml
        from backend.db.seed import SCENARIOS_DIR

        with open(SCENARIOS_DIR / "calendar-service-mock" / "calendars.yaml") as f:
            data = yaml.safe_load(f)

        assert "calendars" in data
        for cal in data["calendars"]:
            assert "id" in cal
            assert "name" in cal

    def test_seed_events_yaml_has_expected_structure(self):
        import yaml
        from backend.db.seed import SCENARIOS_DIR

        with open(
            SCENARIOS_DIR / "calendar-service-mock" / "mock-sync-events.yaml"
        ) as f:
            data = yaml.safe_load(f)

        assert "events" in data
        for evt in data["events"]:
            assert "id" in evt
            assert "calendar_id" in evt
            assert "title" in evt
            assert "start" in evt
            assert "end" in evt

    def test_seed_uses_default_tags_and_users_when_missing(self, tmp_path, monkeypatch):
        scenarios_dir = tmp_path / "scenarios"
        default_dir = scenarios_dir / "default"
        scenario_dir = scenarios_dir / "sparse"
        default_dir.mkdir(parents=True)
        scenario_dir.mkdir()
        (default_dir / "tags.yaml").write_text(
            "tag_groups:\n"
            "  - slug: format\n"
            "    label: Format\n"
            "    tags:\n"
            "      - slug: social\n"
            "        label: Social\n"
        )
        (default_dir / "mock-users.yaml").write_text(
            "users:\n  - email: fallback@example.com\n    name: Fallback User\n"
        )
        monkeypatch.setattr(seed_module, "SCENARIOS_DIR", scenarios_dir)
        monkeypatch.setattr(
            "backend.config.loader.get_calendar_service_type", lambda: "mock"
        )

        engine = create_engine("sqlite://")
        SQLModel.metadata.create_all(engine)
        with Session(engine) as session:
            DatabaseSeeder(session).seed(scenario_dir)

            group = session.exec(
                select(TagGroup).where(TagGroup.slug == "format")
            ).first()
            tag = session.exec(select(Tag).where(Tag.slug == "social")).first()
            user = session.exec(
                select(User).where(User.email == "fallback@example.com")
            ).first()

        assert group is not None
        assert tag is not None
        assert user is not None

    def test_seed_admin_managed_user_defaults_to_public_audience(
        self, tmp_path, monkeypatch
    ):
        scenarios_dir = tmp_path / "scenarios"
        scenario_dir = scenarios_dir / "managed"
        scenario_dir.mkdir(parents=True)
        (scenario_dir / "mock-users.yaml").write_text(
            "users:\n"
            "  - email: curator@example.com\n"
            "    name: Curator\n"
            "    handle: curator\n"
            "    is_admin_managed: true\n"
            "    share_attendance_default_audience: private\n"
        )
        monkeypatch.setattr(seed_module, "SCENARIOS_DIR", scenarios_dir)
        monkeypatch.setattr(
            "backend.config.loader.get_calendar_service_type", lambda: "mock"
        )

        engine = create_engine("sqlite://")
        SQLModel.metadata.create_all(engine)
        with Session(engine) as session:
            DatabaseSeeder(session).seed(scenario_dir)

            user = session.exec(
                select(User).where(User.email == "curator@example.com")
            ).first()

        assert user is not None
        assert user.is_admin_managed is True
        assert user.share_attendance_default is True
        assert user.share_attendance_default_audience == "public"

    def test_all_scenarios_have_tag_and_user_coverage(self):
        import yaml

        from backend.db.seed import SCENARIOS_DIR

        default_tags = SCENARIOS_DIR / "default" / "tags.yaml"
        default_users = SCENARIOS_DIR / "default" / "mock-users.yaml"
        assert default_tags.exists()
        assert default_users.exists()
        assert yaml.safe_load(default_tags.read_text()).get("tag_groups")
        assert yaml.safe_load(default_users.read_text()).get("users")
        for scenario_dir in SCENARIOS_DIR.iterdir():
            if not scenario_dir.is_dir():
                continue
            assert (scenario_dir / "tags.yaml").exists() or default_tags.exists()
            assert (scenario_dir / "mock-users.yaml").exists() or default_users.exists()

    def test_db_events_use_resolvable_fixture_tags(self):
        import yaml

        from backend.db.seed import SCENARIOS_DIR

        tag_test_scenarios = {"event-tags", "tag-enhancer"}

        def tag_slugs(scenario_dir: Path) -> set[str]:
            tags_path = scenario_dir / "tags.yaml"
            if not tags_path.exists():
                tags_path = SCENARIOS_DIR / "default" / "tags.yaml"
            data = yaml.safe_load(tags_path.read_text()) or {}
            slugs: set[str] = set()
            for group in data.get("tag_groups") or []:
                group_slug = group.get("slug")
                for tag in group.get("tags") or []:
                    tag_slug = tag.get("slug")
                    if group_slug and tag_slug:
                        slugs.add(f"{group_slug}:{tag_slug}")
            return slugs

        for events_path in SCENARIOS_DIR.glob("*/db-events.yaml"):
            scenario_dir = events_path.parent
            available_tags = tag_slugs(scenario_dir)
            data = yaml.safe_load(events_path.read_text()) or {}
            for event in data.get("events") or []:
                event_tags = event.get("tags") or []
                if scenario_dir.name not in tag_test_scenarios:
                    assert event_tags, f"{events_path}:{event.get('id')} has no tags"
                for slug in event_tags:
                    assert slug in available_tags, (
                        f"{events_path}:{event.get('id')} references unknown tag {slug}"
                    )
            for suggestion in data.get("tag_suggestions") or []:
                tag_slug = suggestion.get("tag")
                if tag_slug:
                    assert tag_slug in available_tags, (
                        f"{events_path}: tag suggestion references unknown tag {tag_slug}"
                    )
