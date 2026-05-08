"""Regression test for the tz-aware vs tz-naive datetime bug.

Google Calendar returns ``dateTime`` strings with a timezone offset, but
``CachedEvent.start``/``end`` are stored as ``TIMESTAMP WITHOUT TIME ZONE``
(i.e. tz-naive). Without normalization the comparison
``existing.start != event.start`` was always True, which spuriously reset
``review_status`` to ``pending`` and overwrote curated fields on every
re-sync.

This test mocks the Google API client and asserts that parsed datetimes
come out as tz-naive UTC.
"""

from unittest.mock import MagicMock, patch

import pytest

from backend.services.calendar.google_calendar import GoogleCalendarService


@pytest.mark.unit
def test_get_events_returns_naive_utc_datetimes():
    fake_service = MagicMock()
    fake_service.events.return_value.list.return_value.execute.return_value = {
        "items": [
            {
                "id": "evt-1",
                "status": "confirmed",
                "summary": "Salsa Night",
                # Z suffix → UTC, tz-aware after parsing.
                "start": {"dateTime": "2026-04-20T20:00:00Z"},
                "end": {"dateTime": "2026-04-20T23:00:00Z"},
            },
            {
                "id": "evt-2",
                "status": "confirmed",
                "summary": "Bachata Social",
                # Explicit non-UTC offset.
                "start": {"dateTime": "2026-04-21T19:00:00+02:00"},
                "end": {"dateTime": "2026-04-21T22:30:00+02:00"},
            },
        ],
        "nextSyncToken": "tok-next",
    }

    svc = GoogleCalendarService()
    with patch.object(svc, "_get_service", return_value=fake_service):
        result = svc.get_events("cal-1")

    assert len(result.events) == 2
    for ev in result.events:
        assert ev.start.tzinfo is None, f"start should be naive: {ev.start!r}"
        assert ev.end.tzinfo is None, f"end should be naive: {ev.end!r}"

    # Sanity check: the +02:00 event got shifted into UTC.
    e2 = next(e for e in result.events if e.event_id == "evt-2")
    assert e2.start.hour == 17  # 19:00+02:00 → 17:00 UTC
