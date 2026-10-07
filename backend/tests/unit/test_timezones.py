"""Unit tests for backend.services.timezones."""

from backend.services.timezones import resolve_event_timezone, tz_for_point


def test_tz_for_point_uses_the_venue():
    assert tz_for_point(48.8566, 2.3522) == "Europe/Paris"
    assert tz_for_point(38.7223, -9.1393) == "Europe/Lisbon"
    assert tz_for_point(40.7128, -74.0060) == "America/New_York"
    assert tz_for_point(None, 2.35) is None


def test_resolve_prefers_explicit_then_venue_then_sources():
    lisbon = {"latitude": 38.7223, "longitude": -9.1393}
    assert resolve_event_timezone(explicit="Europe/Madrid", **lisbon) == "Europe/Madrid"
    assert (
        resolve_event_timezone(
            source_event="Europe/Paris", submitter="Europe/Paris", **lisbon
        )
        == "Europe/Lisbon"
    )
    assert (
        resolve_event_timezone(source_event="Not/AZone", source_calendar="Europe/Paris")
        == "Europe/Paris"
    )
    assert resolve_event_timezone(submitter="America/New_York") == "America/New_York"
    assert resolve_event_timezone() is None
