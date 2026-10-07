"""Unit tests for the analytics data-retention sweep."""

import os
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

os.environ.setdefault("SESSION_SECRET", "test-secret-retention")

from backend.db.models import EmailLoginCode, EventSave, EventView  # noqa: E402
from backend.services.data_retention import apply_retention  # noqa: E402


@pytest.fixture
def session():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        yield s
    SQLModel.metadata.drop_all(engine)


@pytest.mark.unit
def test_retention_pseudonymises_old_views_and_drops_old_logs(session):
    now = datetime(2026, 10, 6, tzinfo=timezone.utc)
    old = now - timedelta(days=400)
    recent = now - timedelta(days=10)
    session.add(EventView(event_id="e1", device_id="dev-old", created_at=old))
    session.add(EventView(event_id="e1", device_id="dev-new", created_at=recent))
    session.add(EventSave(event_id="e1", device_id="dev-old", created_at=old))
    session.add(EventSave(event_id="e1", device_id="dev-new", created_at=recent))
    session.add(
        EmailLoginCode(
            email="a@example.com",
            code_hash="x",
            expires_at=now - timedelta(days=2),
            request_ip="203.0.113.1",
        )
    )
    session.commit()

    stats = apply_retention(session, now=now)

    views = session.exec(select(EventView).order_by(EventView.created_at)).all()
    assert [v.device_id for v in views] == [None, "dev-new"]
    assert [s.device_id for s in session.exec(select(EventSave)).all()] == ["dev-new"]
    assert session.exec(select(EmailLoginCode)).all() == []
    assert stats["event_views"] == 1
    assert stats["event_saves"] == 1
