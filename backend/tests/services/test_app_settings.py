"""Unit tests for the DB-first notification-settings wrapper.

Each getter must (a) return the ``SiteSetting`` value when present and
(b) fall back to ``backend.config.loader`` when the row is absent, empty,
or malformed. This keeps admin-panel overrides authoritative while still
letting env vars drive fresh installs.
"""

from __future__ import annotations

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from backend.db import database as database_module
from backend.db.models import SiteSetting
from backend.services import app_settings


@pytest.fixture
def engine():
    eng = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(eng)
    prev = database_module._engine
    database_module._engine = eng
    yield eng
    database_module._engine = prev
    SQLModel.metadata.drop_all(eng)


@pytest.fixture
def session(engine):
    with Session(engine) as s:
        yield s


def _put(session: Session, key: str, value: str) -> None:
    session.add(SiteSetting(key=key, value=value))
    session.commit()


# --- bool getters ----------------------------------------------------------


@pytest.mark.parametrize(
    "getter,key,loader_attr",
    [
        (
            app_settings.get_event_reminders_enabled,
            "event_reminders_enabled",
            "get_event_reminders_enabled",
        ),
        (
            app_settings.get_activity_digest_email_enabled,
            "activity_digest_email_enabled",
            "get_activity_digest_email_enabled",
        ),
        (
            app_settings.get_interest_match_notifications_enabled,
            "interest_match_notifications_enabled",
            "get_interest_match_notifications_enabled",
        ),
        (
            app_settings.get_web_push_enabled,
            "web_push_enabled",
            "get_web_push_enabled",
        ),
    ],
)
def test_bool_getters_prefer_db_row_over_loader(
    getter, key, loader_attr, session, monkeypatch
):
    # Loader would say True; DB says False → DB wins.
    monkeypatch.setattr(f"backend.config.loader.{loader_attr}", lambda: True)
    _put(session, key, "false")
    assert getter(session) is False
    # And the reverse — loader False, DB True.
    monkeypatch.setattr(f"backend.config.loader.{loader_attr}", lambda: False)
    session.get(SiteSetting, key).value = "true"
    session.commit()
    assert getter(session) is True


@pytest.mark.parametrize(
    "getter,loader_attr",
    [
        (app_settings.get_event_reminders_enabled, "get_event_reminders_enabled"),
        (
            app_settings.get_activity_digest_email_enabled,
            "get_activity_digest_email_enabled",
        ),
        (
            app_settings.get_interest_match_notifications_enabled,
            "get_interest_match_notifications_enabled",
        ),
        (app_settings.get_web_push_enabled, "get_web_push_enabled"),
    ],
)
def test_bool_getters_fall_back_to_loader_when_row_missing(
    getter, loader_attr, session, monkeypatch
):
    monkeypatch.setattr(f"backend.config.loader.{loader_attr}", lambda: True)
    assert getter(session) is True
    monkeypatch.setattr(f"backend.config.loader.{loader_attr}", lambda: False)
    assert getter(session) is False


def test_bool_getter_ignores_malformed_row_and_uses_loader(session, monkeypatch):
    monkeypatch.setattr(
        "backend.config.loader.get_event_reminders_enabled", lambda: True
    )
    _put(session, "event_reminders_enabled", "maybe")
    assert app_settings.get_event_reminders_enabled(session) is True


# --- reminder_lead_hours ---------------------------------------------------


def test_reminder_lead_hours_prefers_db_row(session, monkeypatch):
    monkeypatch.setattr("backend.config.loader.get_reminder_lead_hours", lambda: 24)
    _put(session, "reminder_lead_hours", "6")
    assert app_settings.get_reminder_lead_hours(session) == 6


def test_reminder_lead_hours_falls_back_when_row_missing(session, monkeypatch):
    monkeypatch.setattr("backend.config.loader.get_reminder_lead_hours", lambda: 48)
    assert app_settings.get_reminder_lead_hours(session) == 48


def test_reminder_lead_hours_ignores_non_positive_row(session, monkeypatch):
    """A stored 0 or negative would produce a nonsensical lead window;
    fall back to the loader so we never disable reminders silently."""
    monkeypatch.setattr("backend.config.loader.get_reminder_lead_hours", lambda: 24)
    _put(session, "reminder_lead_hours", "0")
    assert app_settings.get_reminder_lead_hours(session) == 24


def test_reminder_lead_hours_ignores_malformed_row(session, monkeypatch):
    monkeypatch.setattr("backend.config.loader.get_reminder_lead_hours", lambda: 24)
    _put(session, "reminder_lead_hours", "abc")
    assert app_settings.get_reminder_lead_hours(session) == 24


# --- review_prompt_lookback_hours -------------------------------------------


def test_review_prompt_lookback_hours_prefers_db_row(session, monkeypatch):
    monkeypatch.setattr(
        "backend.config.loader.get_review_prompt_lookback_hours", lambda: 24
    )
    _put(session, "review_prompt_lookback_hours", "48")
    assert app_settings.get_review_prompt_lookback_hours(session) == 48


def test_review_prompt_lookback_hours_falls_back_when_row_missing(session, monkeypatch):
    monkeypatch.setattr(
        "backend.config.loader.get_review_prompt_lookback_hours", lambda: 24
    )
    assert app_settings.get_review_prompt_lookback_hours(session) == 24


def test_review_prompt_lookback_hours_ignores_non_positive_row(session, monkeypatch):
    monkeypatch.setattr(
        "backend.config.loader.get_review_prompt_lookback_hours", lambda: 24
    )
    _put(session, "review_prompt_lookback_hours", "0")
    assert app_settings.get_review_prompt_lookback_hours(session) == 24


def test_review_prompt_lookback_hours_ignores_malformed_row(session, monkeypatch):
    monkeypatch.setattr(
        "backend.config.loader.get_review_prompt_lookback_hours", lambda: 24
    )
    _put(session, "review_prompt_lookback_hours", "abc")
    assert app_settings.get_review_prompt_lookback_hours(session) == 24


# --- for_you_review_window_days ---------------------------------------------


def test_for_you_review_window_days_prefers_db_row(session, monkeypatch):
    monkeypatch.setattr(
        "backend.config.loader.get_for_you_review_window_days", lambda: 180
    )
    _put(session, "for_you_review_window_days", "365")
    assert app_settings.get_for_you_review_window_days(session) == 365


def test_for_you_review_window_days_falls_back_when_row_missing(session, monkeypatch):
    monkeypatch.setattr(
        "backend.config.loader.get_for_you_review_window_days", lambda: 180
    )
    assert app_settings.get_for_you_review_window_days(session) == 180


def test_for_you_review_window_days_ignores_non_positive_row(session, monkeypatch):
    monkeypatch.setattr(
        "backend.config.loader.get_for_you_review_window_days", lambda: 180
    )
    _put(session, "for_you_review_window_days", "0")
    assert app_settings.get_for_you_review_window_days(session) == 180


def test_for_you_review_window_days_ignores_malformed_row(session, monkeypatch):
    monkeypatch.setattr(
        "backend.config.loader.get_for_you_review_window_days", lambda: 180
    )
    _put(session, "for_you_review_window_days", "abc")
    assert app_settings.get_for_you_review_window_days(session) == 180


# --- review_mood_headline_min_reviews -------------------------------------


def test_mood_headline_min_reviews_prefers_db_row(session, monkeypatch):
    monkeypatch.setattr(
        "backend.config.loader.get_review_mood_headline_min_reviews", lambda: 3
    )
    _put(session, "review_mood_headline_min_reviews", "10")
    assert app_settings.get_review_mood_headline_min_reviews(session) == 10


def test_mood_headline_min_reviews_falls_back_when_row_missing(session, monkeypatch):
    monkeypatch.setattr(
        "backend.config.loader.get_review_mood_headline_min_reviews", lambda: 5
    )
    assert app_settings.get_review_mood_headline_min_reviews(session) == 5


def test_mood_headline_min_reviews_ignores_non_positive_row(session, monkeypatch):
    monkeypatch.setattr(
        "backend.config.loader.get_review_mood_headline_min_reviews", lambda: 3
    )
    _put(session, "review_mood_headline_min_reviews", "0")
    assert app_settings.get_review_mood_headline_min_reviews(session) == 3


# --- activity_digest_schedule ---------------------------------------------


def test_digest_schedule_prefers_db_row(session):
    _put(session, "activity_digest_schedule", "mon,thu @ 18:30")
    assert app_settings.get_activity_digest_schedule(session) == "mon,thu @ 18:30"


def test_digest_schedule_default_when_missing(session):
    assert (
        app_settings.get_activity_digest_schedule(session)
        == app_settings.DEFAULT_DIGEST_SCHEDULE
    )


def test_digest_schedule_default_when_row_blank(session):
    _put(session, "activity_digest_schedule", "   ")
    assert (
        app_settings.get_activity_digest_schedule(session)
        == app_settings.DEFAULT_DIGEST_SCHEDULE
    )
