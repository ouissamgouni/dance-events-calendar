"""Unit tests for geocode_location."""

import pytest
import time
from unittest.mock import MagicMock, patch


@pytest.mark.unit
class TestGeocodeLocation:
    def setup_method(self):
        # Reset all module state before each test
        from backend.services.geocoding import _reset_state

        _reset_state()

    @patch("backend.services.geocoding._throttle")
    @patch("backend.services.geocoding._geocoder")
    def test_returns_coordinates_for_known_address(self, mock_geocoder, _mock_throttle):
        result = MagicMock()
        result.latitude = 48.8566
        result.longitude = 2.3522
        mock_geocoder.geocode.return_value = result

        from backend.services.geocoding import geocode_location

        coords = geocode_location("Paris, France")

        assert coords == (48.8566, 2.3522)
        mock_geocoder.geocode.assert_called_once_with("Paris, France")

    @patch("backend.services.geocoding._throttle")
    @patch("backend.services.geocoding._geocoder")
    def test_returns_none_for_unknown_address(self, mock_geocoder, _mock_throttle):
        mock_geocoder.geocode.return_value = None

        from backend.services.geocoding import geocode_location

        coords = geocode_location("xyznotaplace123")

        assert coords is None

    @patch("backend.services.geocoding._throttle")
    @patch("backend.services.geocoding._geocoder")
    def test_returns_none_on_timeout(self, mock_geocoder, _mock_throttle):
        from geopy.exc import GeocoderTimedOut

        mock_geocoder.geocode.side_effect = GeocoderTimedOut("timeout")

        from backend.services.geocoding import geocode_location

        coords = geocode_location("Paris, France")

        assert coords is None

    @patch("backend.services.geocoding._throttle")
    @patch("backend.services.geocoding._geocoder")
    def test_returns_none_on_service_error(self, mock_geocoder, _mock_throttle):
        from geopy.exc import GeocoderServiceError

        mock_geocoder.geocode.side_effect = GeocoderServiceError("service down")

        from backend.services.geocoding import geocode_location

        coords = geocode_location("Paris, France")

        assert coords is None

    @patch("backend.services.geocoding._throttle")
    @patch("backend.services.geocoding._geocoder")
    def test_caching_avoids_repeat_calls(self, mock_geocoder, _mock_throttle):
        result = MagicMock()
        result.latitude = 48.86
        result.longitude = 2.35
        mock_geocoder.geocode.return_value = result

        from backend.services.geocoding import geocode_location

        geocode_location("Same Address")
        geocode_location("Same Address")

        # Geocoder should only be called once due to success cache
        mock_geocoder.geocode.assert_called_once()

    @patch("backend.services.geocoding._throttle")
    @patch("backend.services.geocoding._geocoder")
    def test_failed_locations_are_retried(self, mock_geocoder, _mock_throttle):
        """Failures should NOT be cached — location is retried on next call."""
        from geopy.exc import GeocoderServiceError

        mock_geocoder.geocode.side_effect = GeocoderServiceError("429")

        from backend.services.geocoding import geocode_location

        # First call fails
        assert geocode_location("Flaky Place") is None

        # Second call retries (not served from cache)
        result = MagicMock()
        result.latitude = 40.71
        result.longitude = -74.01
        mock_geocoder.geocode.side_effect = None
        mock_geocoder.geocode.return_value = result

        from backend.services.geocoding import _reset_state

        _reset_state()  # reset circuit breaker for isolated retry test

        assert geocode_location("Flaky Place") == (40.71, -74.01)
        assert mock_geocoder.geocode.call_count == 2


@pytest.mark.unit
class TestCircuitBreaker:
    def setup_method(self):
        from backend.services.geocoding import _reset_state

        _reset_state()

    @patch("backend.services.geocoding._throttle")
    @patch("backend.services.geocoding._geocoder")
    def test_circuit_opens_after_consecutive_failures(
        self, mock_geocoder, _mock_throttle
    ):
        """After _MAX_CONSECUTIVE_FAILURES errors, geocoding is skipped."""
        from geopy.exc import GeocoderServiceError
        from backend.services import geocoding
        from backend.services.geocoding import geocode_location

        mock_geocoder.geocode.side_effect = GeocoderServiceError("429")

        # Trigger enough failures to open the circuit
        for i in range(geocoding._MAX_CONSECUTIVE_FAILURES):
            geocode_location(f"Location {i}")

        # Next call should be skipped (circuit open) — geocoder not called again
        mock_geocoder.geocode.reset_mock()
        assert geocode_location("Another Place") is None
        mock_geocoder.geocode.assert_not_called()

    @patch("backend.services.geocoding._throttle")
    @patch("backend.services.geocoding._geocoder")
    def test_circuit_resets_after_cooldown(self, mock_geocoder, _mock_throttle):
        """After cooldown period, circuit closes and geocoding retries."""
        from geopy.exc import GeocoderServiceError
        from backend.services import geocoding
        from backend.services.geocoding import geocode_location

        mock_geocoder.geocode.side_effect = GeocoderServiceError("429")

        # Open the circuit
        for i in range(geocoding._MAX_CONSECUTIVE_FAILURES):
            geocode_location(f"Location {i}")

        # Fast-forward past cooldown
        with patch.object(
            time,
            "monotonic",
            return_value=time.monotonic() + geocoding._CIRCUIT_COOLDOWN + 1,
        ):
            mock_geocoder.geocode.reset_mock()
            result_mock = MagicMock()
            result_mock.latitude = 51.5
            result_mock.longitude = -0.12
            mock_geocoder.geocode.side_effect = None
            mock_geocoder.geocode.return_value = result_mock

            coords = geocode_location("London")
            assert coords == (51.5, -0.12)
            mock_geocoder.geocode.assert_called_once()

    @patch("backend.services.geocoding._throttle")
    @patch("backend.services.geocoding._geocoder")
    def test_success_resets_failure_count(self, mock_geocoder, _mock_throttle):
        """A successful geocode resets the consecutive failure counter."""
        from geopy.exc import GeocoderServiceError
        from backend.services import geocoding
        from backend.services.geocoding import geocode_location

        mock_geocoder.geocode.side_effect = GeocoderServiceError("429")

        # Accumulate some failures (but not enough to open circuit)
        for i in range(geocoding._MAX_CONSECUTIVE_FAILURES - 1):
            geocode_location(f"Fail {i}")

        assert (
            geocoding._consecutive_failures == geocoding._MAX_CONSECUTIVE_FAILURES - 1
        )

        # Now succeed
        result_mock = MagicMock()
        result_mock.latitude = 48.86
        result_mock.longitude = 2.35
        mock_geocoder.geocode.side_effect = None
        mock_geocoder.geocode.return_value = result_mock

        geocode_location("Paris")
        assert geocoding._consecutive_failures == 0


# ---------------------------------------------------------------------------
# Tests for geocode_candidates (multi-candidate + Google provider)
# ---------------------------------------------------------------------------


@pytest.mark.unit
class TestGeocodeCandiates:
    def setup_method(self):
        from backend.services.geocoding import _reset_state

        _reset_state()

    @patch("backend.services.geocoding._throttle")
    @patch("backend.services.geocoding._geocoder")
    @patch("backend.services.geocoding._get_google_geocoder", return_value=None)
    def test_returns_first_successful_candidate(
        self, _mock_google, mock_geocoder, _mock_throttle
    ):
        """geocode_candidates returns on the first candidate that resolves."""
        result = MagicMock()
        result.latitude = 48.8
        result.longitude = 2.3
        mock_geocoder.geocode.return_value = result

        from backend.services.geocoding import geocode_candidates

        outcome = geocode_candidates(["Venue Name", "Venue Name, Paris"])

        assert outcome is not None
        coords, query, provider = outcome
        assert coords == (48.8, 2.3)
        assert query == "Venue Name"
        assert provider == "nominatim"
        # Only the first candidate should have been tried
        mock_geocoder.geocode.assert_called_once_with("Venue Name")

    @patch("backend.services.geocoding._throttle")
    @patch("backend.services.geocoding._geocoder")
    @patch("backend.services.geocoding._get_google_geocoder", return_value=None)
    def test_falls_through_to_second_candidate(
        self, _mock_google, mock_geocoder, _mock_throttle
    ):
        """If first candidate fails, the second is tried."""
        mock_geocoder.geocode.side_effect = [
            None,
            MagicMock(latitude=51.5, longitude=-0.1),
        ]

        from backend.services.geocoding import geocode_candidates

        outcome = geocode_candidates(["Bad Venue", "Good Venue, London"])

        assert outcome is not None
        coords, query, provider = outcome
        assert coords == (51.5, -0.1)
        assert query == "Good Venue, London"
        assert provider == "nominatim"
        assert mock_geocoder.geocode.call_count == 2

    @patch("backend.services.geocoding._throttle")
    @patch("backend.services.geocoding._geocoder")
    @patch("backend.services.geocoding._get_google_geocoder", return_value=None)
    def test_returns_none_when_all_candidates_fail(
        self, _mock_google, mock_geocoder, _mock_throttle
    ):
        mock_geocoder.geocode.return_value = None

        from backend.services.geocoding import geocode_candidates

        assert geocode_candidates(["Bad1", "Bad2"]) is None

    @patch("backend.services.geocoding._throttle")
    @patch("backend.services.geocoding._geocoder")
    def test_google_tried_before_nominatim(self, mock_nominatim, _mock_throttle):
        """When Google is configured, it is tried before Nominatim."""
        google_result = MagicMock()
        google_result.latitude = 48.86
        google_result.longitude = 2.35
        google_result.address = "Paris, France"

        mock_google_geocoder = MagicMock()
        mock_google_geocoder.geocode.return_value = google_result

        with patch(
            "backend.services.geocoding._get_google_geocoder",
            return_value=mock_google_geocoder,
        ):
            from backend.services.geocoding import geocode_candidates, _reset_state

            _reset_state()
            outcome = geocode_candidates(["Paris"])

        assert outcome is not None
        coords, query, provider = outcome
        assert coords == (48.86, 2.35)
        assert provider == "google"
        # Nominatim should not have been called
        mock_nominatim.geocode.assert_not_called()

    @patch("backend.services.geocoding._throttle")
    @patch("backend.services.geocoding._geocoder")
    def test_falls_back_to_nominatim_when_google_fails(
        self, mock_nominatim, _mock_throttle
    ):
        """When Google returns nothing, Nominatim is tried as fallback."""
        mock_google_geocoder = MagicMock()
        mock_google_geocoder.geocode.return_value = None

        nominatim_result = MagicMock()
        nominatim_result.latitude = 51.5
        nominatim_result.longitude = -0.12
        mock_nominatim.geocode.return_value = nominatim_result

        with patch(
            "backend.services.geocoding._get_google_geocoder",
            return_value=mock_google_geocoder,
        ):
            from backend.services.geocoding import geocode_candidates, _reset_state

            _reset_state()
            outcome = geocode_candidates(["London"])

        assert outcome is not None
        coords, query, provider = outcome
        assert coords == (51.5, -0.12)
        assert provider == "nominatim"

    @patch("backend.services.geocoding._throttle")
    @patch("backend.services.geocoding._geocoder")
    @patch("backend.services.geocoding._get_google_geocoder", return_value=None)
    def test_empty_candidates_returns_none(
        self, _mock_google, _mock_nominatim, _mock_throttle
    ):
        from backend.services.geocoding import geocode_candidates

        assert geocode_candidates([]) is None

    @patch("backend.services.geocoding._throttle")
    @patch("backend.services.geocoding._geocoder")
    @patch("backend.services.geocoding._get_google_geocoder", return_value=None)
    def test_successful_result_is_cached(
        self, _mock_google, mock_geocoder, _mock_throttle
    ):
        """A successful Nominatim result is cached so the second call skips the geocoder."""
        result = MagicMock()
        result.latitude = 48.0
        result.longitude = 2.0
        mock_geocoder.geocode.return_value = result

        from backend.services.geocoding import geocode_candidates

        geocode_candidates(["Cached Place"])
        geocode_candidates(["Cached Place"])

        mock_geocoder.geocode.assert_called_once()


# ---------------------------------------------------------------------------
# Tests for search_locations
# ---------------------------------------------------------------------------


@pytest.mark.unit
class TestSearchLocations:
    def setup_method(self):
        from backend.services.geocoding import _reset_state

        _reset_state()

    @patch("backend.services.geocoding._geocoder")
    @patch("backend.services.geocoding._get_google_geocoder", return_value=None)
    def test_returns_nominatim_results_when_no_google(
        self, _mock_google, mock_geocoder
    ):
        r1 = MagicMock()
        r1.address = "Paris, France"
        r1.latitude = 48.86
        r1.longitude = 2.35

        mock_geocoder.geocode.return_value = [r1]

        from backend.services.geocoding import search_locations

        results = search_locations("Paris")

        assert len(results) == 1
        assert results[0]["display_name"] == "Paris, France"
        assert results[0]["latitude"] == 48.86

    @patch("backend.services.geocoding._geocoder")
    def test_prefers_google_when_configured(self, mock_nominatim):
        google_r = MagicMock()
        google_r.address = "Paris, France (Google)"
        google_r.latitude = 48.86
        google_r.longitude = 2.35

        mock_google_geocoder = MagicMock()
        mock_google_geocoder.geocode.return_value = [google_r]

        with patch(
            "backend.services.geocoding._get_google_geocoder",
            return_value=mock_google_geocoder,
        ):
            from backend.services.geocoding import search_locations, _reset_state

            _reset_state()
            results = search_locations("Paris")

        assert results[0]["display_name"] == "Paris, France (Google)"
        mock_nominatim.geocode.assert_not_called()

    @patch("backend.services.geocoding._geocoder")
    @patch("backend.services.geocoding._get_google_geocoder", return_value=None)
    def test_returns_empty_list_on_no_results(self, _mock_google, mock_geocoder):
        mock_geocoder.geocode.return_value = None

        from backend.services.geocoding import search_locations

        assert search_locations("xyznotaplace123") == []

    @patch("backend.services.geocoding._geocoder")
    @patch("backend.services.geocoding._get_google_geocoder", return_value=None)
    def test_respects_limit(self, _mock_google, mock_geocoder):
        results_mock = [
            MagicMock(address=f"Place {i}", latitude=float(i), longitude=0.0)
            for i in range(10)
        ]
        mock_geocoder.geocode.return_value = results_mock

        from backend.services.geocoding import search_locations

        results = search_locations("Paris", limit=3)
        assert len(results) == 3
