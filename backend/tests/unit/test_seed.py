"""Unit tests for DatabaseSeeder logic."""

import pytest
from datetime import date, datetime, timedelta
from pathlib import Path

from sqlmodel import SQLModel, Session, create_engine, select

from backend.db.models import (
    CalendarSubscription,
    CachedEvent,
    EventTag,
    EventView,
    Tag,
    TagGroup,
    User,
    UserEventAttendance,
    UserSavedEvent,
)
from backend.db.seed import DatabaseSeeder, _seed_device_id, resolve_relative_dt
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
    def test_seed_device_id_stays_within_column_limit(self):
        event_id = "6crj4phl6so6ab9g64o64b9k6lgjabb16dgj4bb660rj2dhocgpjgohj74"
        identity = "viewer@example.com"

        device_id = _seed_device_id("seed-attend", event_id, identity)

        assert len(device_id) <= 64
        assert device_id == _seed_device_id("seed-attend", event_id, identity)

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
            "    avatar_url: https://example.com/avatar-curator.jpg\n"
            "    is_admin_managed: true\n"
            "    show_in_suggestions: false\n"
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
        assert user.avatar_url == "https://example.com/avatar-curator.jpg"
        assert user.is_admin_managed is True
        assert user.show_in_suggestions is False
        assert user.share_attendance_default is True
        assert user.share_attendance_default_audience == "public"

    def test_seed_mock_users_auto_onboard_by_default(self, tmp_path, monkeypatch):
        """Phase G — scenarios that don't set ``auto_onboard`` (the vast
        majority) auto-stamp mock users as already onboarded so the
        OnboardingGate doesn't redirect on every ``Sign in as <Name>``
        click.
        """
        from backend.config import loader as loader_module

        scenario_dir = tmp_path / "scenario"
        scenario_dir.mkdir(parents=True)
        (scenario_dir / "mock-users.yaml").write_text(
            "users:\n"
            "  - email: alice@example.com\n"
            "    name: Alice\n"
        )
        monkeypatch.setattr(loader_module, "CURRENT_ONBOARDING_VERSION", 7)
        monkeypatch.setattr(
            "backend.config.loader.get_calendar_service_type", lambda: "mock"
        )

        engine = create_engine("sqlite://")
        SQLModel.metadata.create_all(engine)
        with Session(engine) as session:
            DatabaseSeeder(session).seed(scenario_dir)
            user = session.exec(
                select(User).where(User.email == "alice@example.com")
            ).first()

        assert user is not None
        assert user.onboarded_at is not None
        assert user.onboarding_version == 7

    def test_seed_mock_users_auto_onboard_false_leaves_null(
        self, tmp_path, monkeypatch
    ):
        """Scenarios that exercise the onboarding flow itself opt out
        with ``auto_onboard: false`` so seeded users start unonboarded.
        """
        scenario_dir = tmp_path / "scenario"
        scenario_dir.mkdir(parents=True)
        (scenario_dir / "mock-users.yaml").write_text(
            "auto_onboard: false\n"
            "users:\n"
            "  - email: newbie@example.com\n"
            "    name: Nora\n"
        )
        monkeypatch.setattr(
            "backend.config.loader.get_calendar_service_type", lambda: "mock"
        )

        engine = create_engine("sqlite://")
        SQLModel.metadata.create_all(engine)
        with Session(engine) as session:
            DatabaseSeeder(session).seed(scenario_dir)
            user = session.exec(
                select(User).where(User.email == "newbie@example.com")
            ).first()

        assert user is not None
        assert user.onboarded_at is None
        assert user.onboarding_version == 0

    def test_seed_mock_user_explicit_onboarded_at_wins(
        self, tmp_path, monkeypatch
    ):
        """An explicit ``onboarded_at`` (including ``null``) in the yaml
        overrides the scenario-wide ``auto_onboard`` default.
        """
        scenario_dir = tmp_path / "scenario"
        scenario_dir.mkdir(parents=True)
        # auto_onboard defaults to true, but the explicit null must win.
        (scenario_dir / "mock-users.yaml").write_text(
            "users:\n"
            "  - email: pending@example.com\n"
            "    name: Pending\n"
            "    onboarded_at: null\n"
            "  - email: fixed@example.com\n"
            "    name: Fixed\n"
            "    onboarded_at: '2025-01-15T09:30:00'\n"
            "    onboarding_version: 3\n"
        )
        monkeypatch.setattr(
            "backend.config.loader.get_calendar_service_type", lambda: "mock"
        )

        engine = create_engine("sqlite://")
        SQLModel.metadata.create_all(engine)
        with Session(engine) as session:
            DatabaseSeeder(session).seed(scenario_dir)
            pending = session.exec(
                select(User).where(User.email == "pending@example.com")
            ).first()
            fixed = session.exec(
                select(User).where(User.email == "fixed@example.com")
            ).first()

        assert pending is not None
        assert pending.onboarded_at is None
        assert fixed is not None
        assert fixed.onboarded_at == datetime(2025, 1, 15, 9, 30, 0)
        assert fixed.onboarding_version == 3

    def test_seed_existing_mock_user_backfills_missing_avatar(
        self, tmp_path, monkeypatch
    ):
        scenario_dir = tmp_path / "scenario"
        scenario_dir.mkdir(parents=True)
        users_path = scenario_dir / "mock-users.yaml"
        users_path.write_text(
            "users:\n"
            "  - email: viewer@example.com\n"
            "    name: Viewer\n"
            "    handle: viewer\n"
        )
        monkeypatch.setattr(
            "backend.config.loader.get_calendar_service_type", lambda: "mock"
        )

        engine = create_engine("sqlite://")
        SQLModel.metadata.create_all(engine)
        with Session(engine) as session:
            DatabaseSeeder(session).seed(scenario_dir)
            users_path.write_text(
                "users:\n"
                "  - email: viewer@example.com\n"
                "    name: Viewer\n"
                "    handle: viewer\n"
                "    avatar_url: https://example.com/avatar-viewer.jpg\n"
            )
            DatabaseSeeder(session).seed(scenario_dir)

            user = session.exec(
                select(User).where(User.email == "viewer@example.com")
            ).first()

        assert user is not None
        assert user.avatar_url == "https://example.com/avatar-viewer.jpg"

    def test_seed_attendances_and_saves_from_separate_files(
        self, tmp_path, monkeypatch
    ):
        scenario_dir = tmp_path / "scenario"
        scenario_dir.mkdir(parents=True)
        (scenario_dir / "mock-users.yaml").write_text(
            "users:\n"
            "  - email: viewer@example.com\n"
            "    name: Viewer\n"
            "    handle: viewer\n"
        )
        (scenario_dir / "db-events.yaml").write_text(
            "events:\n"
            "  - id: event-1\n"
            "    calendar_id: cal-1\n"
            "    title: Event One\n"
            "    start: '2026-06-01T20:00:00'\n"
            "    end: '2026-06-01T22:00:00'\n"
        )
        (scenario_dir / "db-attendances.yaml").write_text(
            "attendances:\n"
            "  - event_id: event-1\n"
            "    email: viewer@example.com\n"
            "    share_publicly: true\n"
            "    share_audience: public\n"
        )
        (scenario_dir / "db-saves.yaml").write_text(
            "saves:\n"
            "  - event_id: event-1\n"
            "    email: viewer@example.com\n"
            "    audience: friends\n"
        )
        monkeypatch.setattr(
            "backend.config.loader.get_calendar_service_type", lambda: "mock"
        )

        engine = create_engine("sqlite://")
        SQLModel.metadata.create_all(engine)
        with Session(engine) as session:
            DatabaseSeeder(session).seed(scenario_dir)

            attendances = session.exec(select(UserEventAttendance)).all()
            saves = session.exec(select(UserSavedEvent)).all()

        assert len(attendances) == 1
        assert attendances[0].event_id == "event-1"
        assert attendances[0].share_audience == "public"
        assert len(saves) == 1
        assert saves[0].event_id == "event-1"
        assert saves[0].audience == "friends"

    def test_seed_approved_follows_create_calendar_subscriptions(
        self, tmp_path, monkeypatch
    ):
        scenarios_dir = tmp_path / "scenarios"
        scenario_dir = scenarios_dir / "follows"
        scenario_dir.mkdir(parents=True)
        (scenario_dir / "mock-users.yaml").write_text(
            "users:\n"
            "  - email: alice@example.com\n"
            "    name: Alice\n"
            "    handle: alice\n"
            "  - email: curator@example.com\n"
            "    name: Curator\n"
            "    handle: curator\n"
            "    is_admin_managed: true\n"
        )
        (scenario_dir / "db-follows.yaml").write_text(
            "follows:\n  - follower: alice\n    followee: curator\n"
        )
        monkeypatch.setattr(seed_module, "SCENARIOS_DIR", scenarios_dir)
        monkeypatch.setattr(
            "backend.config.loader.get_calendar_service_type", lambda: "mock"
        )

        engine = create_engine("sqlite://")
        SQLModel.metadata.create_all(engine)
        with Session(engine) as session:
            DatabaseSeeder(session).seed(scenario_dir)

            alice = session.exec(select(User).where(User.handle == "alice")).one()
            curator = session.exec(select(User).where(User.handle == "curator")).one()
            sub = session.exec(
                select(CalendarSubscription).where(
                    CalendarSubscription.subscriber_id == alice.id,
                    CalendarSubscription.target_user_id == curator.id,
                )
            ).first()

        assert sub is not None
        assert sub.notify_new_events is True

    def test_seed_generated_events_fixture(self, tmp_path, monkeypatch):
        scenario_dir = tmp_path / "generated"
        scenario_dir.mkdir(parents=True)
        (scenario_dir / "calendars.yaml").write_text(
            "calendars:\n"
            "  - id: salsa-cal-001\n"
            "    name: Movida\n"
            "  - id: bachata-cal-002\n"
            "    name: Bachata Events\n"
        )
        (scenario_dir / "generated-events.yaml").write_text(
            "generated_events:\n"
            "  id_prefix: test-perf\n"
            "  count: 12\n"
            "  start_week: -1\n"
            "  weeks: 4\n"
            "  calendar_ids: [salsa-cal-001, bachata-cal-002]\n"
            "  views_per_event: 2\n"
            "  saves_per_event: 1\n"
            "  attendances_per_event: 1\n"
        )
        monkeypatch.setattr(
            "backend.config.loader.get_calendar_service_type", lambda: "mock"
        )

        engine = create_engine("sqlite://")
        SQLModel.metadata.create_all(engine)
        with Session(engine) as session:
            DatabaseSeeder(session).seed(scenario_dir)

            events = session.exec(select(CachedEvent)).all()
            event_tags = session.exec(select(EventTag)).all()
            views = session.exec(select(EventView)).all()
            saves = session.exec(select(UserSavedEvent)).all()
            attendances = session.exec(select(UserEventAttendance)).all()

        assert len(events) == 12
        assert len(event_tags) == 60
        assert len(views) == 24
        assert len(saves) == 12
        assert len(attendances) == 12

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
