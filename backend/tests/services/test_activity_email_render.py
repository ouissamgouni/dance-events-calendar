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
from backend.services import email as email_service  # noqa: E402


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
    assert '<a href="https://example.test/saved-searches"' in line
    assert "<strong>Home</strong></a> alert" in line


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


def test_balance_sections_orders_and_groups_actor_entries():
    entries = [
        {
            "kind": "subscription_going",
            "group_key": "alice",
            "primary_html": f"Event {index}",
            "created_at": datetime(2026, 1, index + 1),
        }
        for index in range(4)
    ]
    balanced = email_service._balance_sections(
        [
            {"feature": "social_activity", "entries": []},
            {"feature": "friends_going", "entries": entries},
            {
                "feature": "interest_matches",
                "entries": [entries[0] | {"group_key": None}],
            },
        ],
        per_kind_cap=5,
        max_items=20,
    )

    assert [section["feature"] for section in balanced] == [
        "interest_matches",
        "friends_going",
    ]
    card = balanced[1]["buckets"]["subscription_going"]["entries"][0]
    assert len(card["entries"]) == 3
    assert card["more"] == 1


def test_render_card_uses_interest_image_or_gradient_fallback():
    with_image = email_service._render_card(
        {
            "entries": [
                {
                    "kind": "interest_event",
                    "event_image_url": "https://cdn.test/event.webp",
                    "primary_html": "Event",
                }
            ]
        }
    )
    fallback = email_service._render_card(
        {"entries": [{"kind": "interest_event", "primary_html": "Event"}]}
    )

    assert 'src="https://cdn.test/event.webp"' in with_image
    assert "linear-gradient(135deg" in fallback


def test_render_card_shows_one_group_header_with_event_only_children():
    html = email_service._render_card(
        {
            "entries": [
                {
                    "kind": "subscription_going",
                    "group_header_html": '<a href="/u/alice">Alice</a> is going to',
                    "group_item_html": f'<a href="/event/{index}">Event {index}</a>',
                    "primary_html": f"Alice is going to Event {index}",
                }
                for index in range(3)
            ]
        }
    )

    assert html.count("Alice") == 1
    assert html.count("is going to") == 1
    assert all(f">Event {index}</a>" in html for index in range(3))


def test_render_card_shows_one_suggester_header_with_event_only_children():
    html = email_service._render_card(
        {
            "entries": [
                {
                    "kind": "subscription_suggested",
                    "group_header_html": '<a href="/u/alice">Alice</a> suggested',
                    "group_item_html": f'<a href="/event/{index}">Event {index}</a>',
                    "primary_html": f"Alice suggested Event {index}",
                }
                for index in range(3)
            ]
        }
    )

    assert html.count("Alice") == 1
    assert html.count("suggested") == 1
    assert all(f">Event {index}</a>" in html for index in range(3))


def test_render_line_uses_total_milestone_count_with_preview_names():
    user = _make_user(handle="alice", display="Alice")
    line = activity_email._render_line(
        "subscription_milestone",
        user,
        None,
        milestone_names=["First Steps", "City Starter", "Passport Stamped"],
        milestone_count=11,
    )

    assert "reached 11 milestones" in line
    assert "First Steps, City Starter, Passport Stamped" in line
    assert "reached 3 milestones" not in line


def test_milestone_card_renders_names_as_muted_details_and_linked_overflow():
    html = email_service._render_card(
        {
            "entries": [
                {
                    "kind": "subscription_milestone",
                    "primary_html": "Alice reached 11 milestones",
                    "subline": "First Steps, City Starter, Passport Stamped",
                    "more_count": 8,
                }
            ]
        },
        "https://example.test/notifications",
    )

    assert "Alice reached 11 milestones" in html
    assert "color:#6b7280;font-size:12px" in html
    assert "First Steps, City Starter, Passport Stamped" in html
    assert '<a href="https://example.test/notifications"' in html
    assert "and 8 more</a>" in html


def test_interest_alert_summary_orders_dance_reach_and_area():
    assert (
        activity_email._interest_alert_summary(
            ["Salsa", "Bachata"], "international", "Paris"
        )
        == "Salsa, Bachata · International · Paris"
    )


def test_balance_sections_groups_interest_entries_by_alert():
    entries = [
        {
            "kind": "interest_event",
            "group_key": "alert:Salsa · International · Paris",
            "primary_html": f"Event {index}",
            "created_at": datetime(2026, 1, index + 1),
        }
        for index in range(4)
    ]
    balanced = email_service._balance_sections(
        [{"feature": "interest_matches", "entries": entries}],
        per_kind_cap=5,
        max_items=20,
    )

    card = balanced[0]["buckets"]["interest_event"]["entries"][0]
    assert len(card["entries"]) == 3
    assert card["more"] == 1


def test_render_card_shows_one_clickable_alert_header():
    html = email_service._render_card(
        {
            "entries": [
                {
                    "kind": "interest_event",
                    "group_header_html": (
                        '<a href="/saved-searches">Salsa · International · Paris</a>'
                    ),
                    "group_item_html": f'<a href="/event/{index}">Event {index}</a>',
                    "primary_html": f"Event {index} matched your alert",
                }
                for index in range(3)
            ]
        }
    )

    assert html.count("Salsa · International · Paris") == 1
    assert html.count('href="/saved-searches"') == 1
    assert all(f">Event {index}</a>" in html for index in range(3))


def test_digest_renders_icon_headings_in_relevance_order(monkeypatch):
    captured: list[str] = []
    monkeypatch.setattr(
        email_service,
        "_send_email",
        lambda _to, _subject, html, _label: captured.append(html) or True,
    )
    user = _make_user()
    entry = {
        "kind": "interest_event",
        "primary_html": "Matched event",
        "created_at": datetime(2026, 1, 1),
    }

    assert email_service.send_activity_digest_v2_email(
        user,
        [
            {
                "feature": "social_activity",
                "entries": [entry | {"kind": "new_friend"}],
            },
            {"feature": "interest_matches", "entries": [entry]},
        ],
    )
    html = captured[0]
    assert html.index("New matches for your saved searches") < html.index(
        "Your social activity"
    )
    assert "font-size:18px" in html
    assert "See all" not in html


def test_digest_linked_overflow_replaces_see_all_and_spaces_sections(monkeypatch):
    captured: list[str] = []
    monkeypatch.setattr(
        email_service,
        "_send_email",
        lambda _to, _subject, html, _label: captured.append(html) or True,
    )
    user = _make_user()
    entries = [
        {
            "kind": "subscription_going",
            "group_key": "alice",
            "primary_html": f"Event {index}",
            "created_at": datetime(2026, 1, index + 1),
        }
        for index in range(4)
    ]

    assert email_service.send_activity_digest_v2_email(
        user, [{"feature": "friends_going", "entries": entries}]
    )

    html = captured[0]
    assert 'href="https://example.test/notifications"' in html
    assert "and 1 more</a>" in html
    assert "See all" not in html
    assert 'style="padding:24px 0 12px"' in html
    assert "margin:0 0 12px" in html
