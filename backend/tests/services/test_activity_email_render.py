"""Focused unit tests for ``activity_email._render_line`` linkification.

Verifies that actor names and event titles emitted in digest email lines
are wrapped in ``<a>`` tags pointing at the frontend profile and event
detail routes when the underlying handle/event_id is present, and that
they gracefully fall back to plain text when those fields are missing.
"""

import os
from datetime import datetime, timedelta
from uuid import uuid4

os.environ.setdefault("SESSION_SECRET", "test-secret-activity-email-render")
os.environ.setdefault("ADMIN_EMAIL", "admin@example.com")
os.environ.setdefault("PUBLIC_APP_URL", "https://example.test")

from backend.db.models import CachedEvent, User  # noqa: E402
from backend.services import activity_email  # noqa: E402


def _make_user(*, handle: str | None = "alice", display: str | None = "Alice R"):
    return User(
        id=uuid4(),
        email=f"{handle or 'anon'}@example.test",
        handle=handle,
        display_name=display,
    )


def _make_event(
    *, event_id: str = "evt-123", title: str = "Salsa Friday"
) -> CachedEvent:
    now = datetime.utcnow()
    return CachedEvent(
        event_id=event_id,
        calendar_id="cal-1",
        title=title,
        start=now,
        end=now + timedelta(hours=2),
    )


def test_render_line_links_actor_handle_and_event_title():
    user = _make_user(handle="alice", display="Alice R")
    event = _make_event(event_id="evt-abc", title="Salsa Friday")
    line = activity_email._render_line("subscription_going", user, event)
    assert '<a href="https://example.test/u/alice"' in line
    assert ">Alice R</a>" in line
    assert '<a href="https://example.test/event/evt-abc"' in line
    assert ">Salsa Friday</a>" in line


def test_render_line_actor_without_handle_is_plain_text():
    user = _make_user(handle=None, display="No Handle")
    event = _make_event()
    line = activity_email._render_line("new_follower", user, event)
    assert "/u/" not in line
    assert "No Handle" in line


def test_render_line_no_event_falls_back_to_plain_text():
    user = _make_user(handle="bob", display="Bob")
    line = activity_email._render_line("new_follower", user, None)
    assert "/event/" not in line
    assert "an event" not in line  # follower kind never renders a title
    assert '<a href="https://example.test/u/bob"' in line


def test_render_line_interest_event_links_title_only():
    event = _make_event(event_id="evt-xyz", title="Kizomba Night")
    line = activity_email._render_line("interest_event", None, event, "Home")
    assert '<a href="https://example.test/event/evt-xyz"' in line
    assert ">Kizomba Night</a>" in line
    assert "matched your <strong>Home</strong> alert" in line


def test_render_line_escapes_hostile_handle_and_title():
    user = _make_user(handle="ali<script>ce", display="Alice</a>")
    event = _make_event(event_id="evt'\"1", title="<b>Boom</b>")
    line = activity_email._render_line("subscription_going", user, event)
    assert "<script>" not in line
    assert "Alice</a>" not in line  # display_name must be escaped
    # raw event title tags escaped
    assert "<b>Boom</b>" not in line
    assert "&lt;b&gt;Boom&lt;/b&gt;" in line


def test_render_plain_unaffected_by_linkification():
    user = _make_user(handle="alice", display="Alice R")
    event = _make_event(event_id="evt-abc", title="Salsa Friday")
    plain = activity_email._render_plain("subscription_going", user, event)
    assert "<a" not in plain
    assert "Alice R is going to Salsa Friday" == plain
