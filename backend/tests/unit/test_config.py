"""Unit tests for config loader."""

import os
import pytest

from backend.config.loader import (
    get_auto_sync_enabled,
    get_database_url,
    get_calendar_service_type,
    get_cors_origins,
    get_sync_interval_minutes,
)


@pytest.mark.unit
class TestConfigLoader:
    def test_get_database_url_from_env(self, monkeypatch):
        monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@h:1234/db")
        assert get_database_url() == "postgresql://u:p@h:1234/db"

    def test_get_database_url_constructed(self, monkeypatch):
        monkeypatch.delenv("DATABASE_URL", raising=False)
        monkeypatch.setenv("POSTGRES_USER", "testuser")
        monkeypatch.setenv("POSTGRES_PASSWORD", "testpass")
        monkeypatch.setenv("POSTGRES_HOST", "myhost")
        monkeypatch.setenv("POSTGRES_PORT", "9999")
        monkeypatch.setenv("POSTGRES_DB", "mydb")
        assert get_database_url() == "postgresql://testuser:testpass@myhost:9999/mydb"

    def test_get_calendar_service_type_default(self, monkeypatch):
        monkeypatch.delenv("CALENDAR_SERVICE", raising=False)
        assert get_calendar_service_type() == "mock"

    def test_get_calendar_service_type_google(self, monkeypatch):
        monkeypatch.setenv("CALENDAR_SERVICE", "google")
        assert get_calendar_service_type() == "google"

    def test_get_cors_origins_single(self, monkeypatch):
        monkeypatch.setenv("CORS_ORIGINS", "http://localhost:3000")
        assert get_cors_origins() == ["http://localhost:3000"]

    def test_get_cors_origins_multiple(self, monkeypatch):
        monkeypatch.setenv("CORS_ORIGINS", "http://a.com, http://b.com")
        assert get_cors_origins() == ["http://a.com", "http://b.com"]

    def test_get_sync_interval_default(self, monkeypatch):
        monkeypatch.delenv("SYNC_INTERVAL_MINUTES", raising=False)
        assert get_sync_interval_minutes() == 15

    def test_get_sync_interval_custom(self, monkeypatch):
        monkeypatch.setenv("SYNC_INTERVAL_MINUTES", "30")
        assert get_sync_interval_minutes() == 30

    def test_get_auto_sync_enabled_default_false(self, monkeypatch):
        monkeypatch.delenv("AUTO_SYNC_ENABLED", raising=False)
        monkeypatch.delenv("SCENARIO_DIR", raising=False)
        assert get_auto_sync_enabled() is False

    def test_get_auto_sync_enabled_from_env(self, monkeypatch):
        monkeypatch.setenv("AUTO_SYNC_ENABLED", "true")
        assert get_auto_sync_enabled() is True

    def test_get_auto_sync_enabled_from_scenario_config(self, monkeypatch, tmp_path):
        monkeypatch.delenv("AUTO_SYNC_ENABLED", raising=False)
        scenario_dir = tmp_path / "scenario"
        scenario_dir.mkdir()
        (scenario_dir / "config.yaml").write_text(
            "calendar_service: mock\nauto_sync_enabled: true\n"
        )
        monkeypatch.setenv("SCENARIO_DIR", str(scenario_dir))
        assert get_auto_sync_enabled() is True
