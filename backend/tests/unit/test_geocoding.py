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
