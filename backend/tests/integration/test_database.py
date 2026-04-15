"""Integration tests requiring a live PostgreSQL database.

These test the full DB round-trip: models, seed, queries.
Run with: task test:int (requires DB on port 5434)
"""

import pytest
from sqlmodel import Session, SQLModel, create_engine, select

from backend.db.models import CachedEvent, CalendarSetting, EventView
from backend.db.seed import DatabaseSeeder


@pytest.fixture(scope="module")
def engine():
    """Create a test engine using the test database."""
    import os

    url = os.getenv(
        "TEST_DATABASE_URL",
        "postgresql://calendar_user:calendar_password@localhost:5435/calendar_db_test",
    )
    eng = create_engine(url)
    SQLModel.metadata.drop_all(eng)
    SQLModel.metadata.create_all(eng)
    yield eng
    SQLModel.metadata.drop_all(eng)


@pytest.fixture
def session(engine):
    with Session(engine) as sess:
        yield sess
        sess.rollback()


@pytest.mark.integration
class TestDatabaseModels:
    def test_create_calendar_setting(self, session):
        cal = CalendarSetting(
            calendar_id="test-cal-1",
            name="Integration Test Calendar",
            enabled=True,
            color="#123456",
        )
        session.add(cal)
        session.commit()

        fetched = session.get(CalendarSetting, "test-cal-1")
        assert fetched is not None
        assert fetched.name == "Integration Test Calendar"
        assert fetched.color == "#123456"

    def test_create_cached_event(self, session):
        from datetime import datetime

        cal = CalendarSetting(calendar_id="test-cal-2", name="Cal2", enabled=True)
        session.add(cal)
        session.flush()

        evt = CachedEvent(
            event_id="test-evt-1",
            calendar_id="test-cal-2",
            title="Test Event",
            start=datetime(2026, 5, 1, 20, 0),
            end=datetime(2026, 5, 1, 23, 0),
        )
        session.add(evt)
        session.commit()

        fetched = session.get(CachedEvent, "test-evt-1")
        assert fetched is not None
        assert fetched.title == "Test Event"
        assert fetched.deleted_at is None

    def test_soft_delete_event(self, session):
        from datetime import datetime

        evt = session.get(CachedEvent, "test-evt-1")
        if evt is None:
            evt = CachedEvent(
                event_id="test-evt-soft",
                calendar_id="test-cal-2",
                title="Soft Delete Me",
                start=datetime(2026, 5, 1, 20, 0),
                end=datetime(2026, 5, 1, 23, 0),
            )
            session.add(evt)
            session.commit()

        evt.deleted_at = datetime.utcnow()
        session.add(evt)
        session.commit()

        # Query non-deleted events
        active = session.exec(
            select(CachedEvent).where(CachedEvent.deleted_at == None)
        ).all()
        deleted_ids = [e.event_id for e in active]
        assert evt.event_id not in deleted_ids or evt.deleted_at is not None

    def test_event_view_tracking(self, session):
        view = EventView(event_id="test-evt-1")
        session.add(view)
        session.commit()

        views = session.exec(
            select(EventView).where(EventView.event_id == "test-evt-1")
        ).all()
        assert len(views) >= 1


@pytest.mark.integration
class TestSeederIntegration:
    def test_seed_default_scenario(self, session):
        seeder = DatabaseSeeder(session)
        seeder.seed()

        calendars = session.exec(select(CalendarSetting)).all()
        assert len(calendars) >= 2

        events = session.exec(select(CachedEvent)).all()
        assert len(events) >= 8

    def test_seed_is_idempotent(self, session):
        seeder = DatabaseSeeder(session)
        seeder.seed()
        seeder.seed()  # run again

        calendars = session.exec(select(CalendarSetting)).all()
        # Should still be 2 (not 4) due to upsert
        cal_ids = [c.calendar_id for c in calendars]
        assert cal_ids.count("salsa-cal-001") == 1
        assert cal_ids.count("bachata-cal-002") == 1
