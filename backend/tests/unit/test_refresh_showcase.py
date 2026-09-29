from datetime import datetime, timedelta, timezone

import pytest
from sqlmodel import Session, SQLModel, create_engine

from backend.db.models import (
    CachedEvent,
    CalendarDefaultTag,
    CalendarSetting,
    EventTag,
    EventSeries,
    EventSeriesMember,
    Tag,
    TagGroup,
    TagSynonym,
)
from backend.scripts.refresh_showcase import (
    _assert_production_source,
    build_snapshot,
    load_showcase_config,
    merge_synthetic_overlay,
    validate_showcase_fixtures,
    validate_synthetic_counts,
    validate_overlays,
)


@pytest.mark.unit
def test_build_snapshot_selects_exact_events_and_expands_series():
    engine = create_engine("sqlite://")
    SQLModel.metadata.create_all(engine)
    now = datetime(2026, 9, 29, tzinfo=timezone.utc)

    with Session(engine) as session:
        session.add(CalendarSetting(calendar_id="visible", name="Visible"))
        session.add(
            CalendarSetting(
                calendar_id="hidden-calendar",
                name="Hidden",
                show_events=False,
            )
        )
        group = TagGroup(slug="format", label="Format", ordinal=10)
        session.add(group)
        session.flush()
        tag = Tag(group_id=group.id, slug="social", label="Social")
        session.add(tag)
        session.flush()
        session.add(TagSynonym(tag_id=tag.id, term="party"))
        session.add(CalendarDefaultTag(calendar_id="visible", tag_id=tag.id))

        events = [
            CachedEvent(
                event_id="attended-past",
                calendar_id="visible",
                title="Attended",
                start=now - timedelta(days=10),
                end=now - timedelta(days=9),
            ),
            CachedEvent(
                event_id="saved-past",
                calendar_id="visible",
                title="Saved",
                start=now - timedelta(days=5),
                end=now - timedelta(days=4),
                image_url="https://source.example/saved.jpg",
            ),
            CachedEvent(
                event_id="pictured-future",
                calendar_id="visible",
                title="Pictured",
                start=now + timedelta(days=1),
                end=now + timedelta(days=2),
                image_key="events/pictured-future/prod",
            ),
            CachedEvent(
                event_id="plain-future",
                calendar_id="visible",
                title="No picture",
                start=now + timedelta(days=2),
                end=now + timedelta(days=3),
            ),
            CachedEvent(
                event_id="hidden-future",
                calendar_id="hidden-calendar",
                title="Hidden calendar",
                start=now + timedelta(days=3),
                end=now + timedelta(days=4),
                image_url="https://source.example/hidden.jpg",
            ),
        ]
        session.add_all(events)
        session.flush()
        series = EventSeries(
            canonical_title="Production Series", status="resolved", source="manual"
        )
        session.add(series)
        session.flush()
        session.add(EventSeriesMember(series_id=series.id, event_id="pictured-future"))
        session.add(EventTag(event_id="pictured-future", tag_id=tag.id))
        session.commit()

        calendars, tags, event_doc, manifest = build_snapshot(
            session,
            required_event_ids=["attended-past"],
            required_series_ids=[series.id],
            image_base_url="https://cdn.example/",
        )

    assert [event["id"] for event in event_doc["events"]] == [
        "attended-past",
        "pictured-future",
    ]
    pictured = event_doc["events"][1]
    assert pictured["image_url"] == (
        "https://cdn.example/events/pictured-future/prod/full.webp"
    )
    assert pictured["tags"] == ["format:social"]
    assert calendars == {
        "calendars": [
            {
                "id": "visible",
                "name": "Visible",
                "color": None,
                "enabled": False,
                "default_tags": ["format:social"],
            }
        ]
    }
    assert tags["tag_groups"][0]["tags"][0]["synonyms"] == ["party"]
    assert manifest["counts"]["exported_events"] == 2
    assert manifest["counts"]["exported_series"] == 1
    assert event_doc["event_series"] == [
        {
            "canonical_title": "Production Series",
            "status": "resolved",
            "source": "manual",
            "members": ["pictured-future"],
        }
    ]


@pytest.mark.unit
def test_load_showcase_config_keeps_exact_ids_and_counts(tmp_path):
    (tmp_path / "showcase.yaml").write_text(
        "production:\n"
        "  required_ids: [event-1, event-1]\n"
        "  required_series_ids: [42]\n"
        "synthetic_counts:\n"
        "  events: 12\n"
        "  series: 1\n"
        "  ratings: 7\n"
        "  messages: 10\n",
        encoding="utf-8",
    )

    assert load_showcase_config(tmp_path) == {
        "required_ids": ["event-1"],
        "required_series_ids": [42],
        "synthetic_counts": {
            "events": 12,
            "series": 1,
            "ratings": 7,
            "messages": 10,
        },
    }


@pytest.mark.unit
def test_build_snapshot_rejects_missing_required_event():
    engine = create_engine("sqlite://")
    SQLModel.metadata.create_all(engine)
    with Session(engine) as session:
        with pytest.raises(ValueError, match="missing-event"):
            build_snapshot(
                session,
                required_event_ids=["missing-event"],
                required_series_ids=[],
                image_base_url="https://cdn.example",
            )


@pytest.mark.unit
def test_validate_synthetic_counts_rejects_drift(tmp_path):
    (tmp_path / "overlay-events.yaml").write_text(
        "events:\n  - id: fake-event\nevent_series: []\nratings: []\n",
        encoding="utf-8",
    )
    (tmp_path / "db-messages.yaml").write_text("messages: []\n", encoding="utf-8")

    with pytest.raises(ValueError, match="events: expected 2, found 1"):
        validate_synthetic_counts(
            tmp_path,
            {"events": 2, "series": 0, "ratings": 0, "messages": 0},
        )


@pytest.mark.unit
def test_validate_overlays_rejects_dangling_event_ids(tmp_path):
    (tmp_path / "db-organizer-claims.yaml").write_text(
        "claims:\n  - event_id: missing-event\n",
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="missing-event"):
        validate_overlays(tmp_path, {"exported-event"})


@pytest.mark.unit
def test_validate_overlays_checks_suggested_event_fanout(tmp_path):
    (tmp_path / "overlay-events.yaml").write_text(
        "events:\n"
        "  - id: authored-event\n"
        "emit_suggested:\n"
        "  - event_id: missing-event\n"
        "    email: lina@joinmovida.com\n",
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="missing-event"):
        validate_overlays(tmp_path, {"authored-event"})


@pytest.mark.unit
def test_validate_showcase_fixtures_accepts_consistent_entities(tmp_path):
    (tmp_path / "mock-users.yaml").write_text(
        "users:\n"
        "  - email: lina@joinmovida.com\n"
        "    name: Lina Moreau\n"
        "    handle: lina\n",
        encoding="utf-8",
    )
    (tmp_path / "overlay-events.yaml").write_text(
        "events:\n"
        "  - id: alfama-salsa\n"
        "    title: Alfama Thursday Salsa\n"
        "ratings:\n"
        "  - event_id: alfama-salsa\n"
        "    email: lina@joinmovida.com\n",
        encoding="utf-8",
    )

    validate_showcase_fixtures(tmp_path, {"alfama-salsa"})


@pytest.mark.unit
def test_validate_showcase_fixtures_rejects_unknown_user(tmp_path):
    (tmp_path / "mock-users.yaml").write_text(
        "users:\n  - email: lina@joinmovida.com\n    handle: lina\n",
        encoding="utf-8",
    )
    (tmp_path / "db-saves.yaml").write_text(
        "saves:\n  - event_id: alfama-salsa\n    email: unknown@joinmovida.com\n",
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="unknown@joinmovida.com"):
        validate_showcase_fixtures(tmp_path, {"alfama-salsa"})


@pytest.mark.unit
def test_validate_showcase_fixtures_rejects_duplicate_handle(tmp_path):
    (tmp_path / "mock-users.yaml").write_text(
        "users:\n"
        "  - email: lina@joinmovida.com\n"
        "    handle: lina\n"
        "  - email: maya@joinmovida.com\n"
        "    handle: lina\n",
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="Duplicate showcase identities"):
        validate_showcase_fixtures(tmp_path, set())


@pytest.mark.unit
def test_validate_showcase_fixtures_rejects_environment_naming(tmp_path):
    (tmp_path / "mock-users.yaml").write_text(
        "users:\n"
        "  - email: lina@joinmovida.com\n"
        "    name: Showcase Dancer\n"
        "    handle: lina\n",
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="naming looks non-production"):
        validate_showcase_fixtures(tmp_path, set())


@pytest.mark.unit
def test_merge_synthetic_overlay_preserves_fake_series_and_reviews(tmp_path):
    (tmp_path / "overlay-events.yaml").write_text(
        "calendars:\n"
        "  - id: fake-calendar\n"
        "events:\n"
        "  - id: fake-event\n"
        "event_series:\n"
        "  - canonical_title: Fake Series\n"
        "    members: [fake-event]\n"
        "ratings:\n"
        "  - event_id: fake-event\n"
        "    overall_sentiment: great\n",
        encoding="utf-8",
    )

    calendars, merged = merge_synthetic_overlay(
        tmp_path,
        {"calendars": [{"id": "production-calendar"}]},
        {"events": [{"id": "production-event"}]},
    )

    assert [calendar["id"] for calendar in calendars["calendars"]] == [
        "production-calendar",
        "fake-calendar",
    ]
    assert [event["id"] for event in merged["events"]] == [
        "production-event",
        "fake-event",
    ]
    assert merged["event_series"][0]["members"] == ["fake-event"]
    assert merged["ratings"][0]["event_id"] == "fake-event"


@pytest.mark.unit
def test_merge_synthetic_overlay_rejects_dangling_review(tmp_path):
    (tmp_path / "overlay-events.yaml").write_text(
        "ratings:\n  - event_id: missing-event\n    overall_sentiment: great\n",
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="missing-event"):
        merge_synthetic_overlay(tmp_path, {"calendars": []}, {"events": []})


@pytest.mark.unit
@pytest.mark.parametrize(
    "url",
    [
        "sqlite:///local.db",
        "postgresql://user:pass@localhost/prod",
        "postgresql://user:pass@127.0.0.1/prod",
    ],
)
def test_assert_production_source_rejects_non_remote_database(url):
    with pytest.raises(ValueError):
        _assert_production_source(url)


@pytest.mark.unit
def test_assert_production_source_accepts_remote_postgres():
    _assert_production_source("postgresql://user:pass@prod.example/prod")
    _assert_production_source("postgresql+psycopg2://user:pass@prod.example/prod")
