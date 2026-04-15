"""Unit tests for geocode_location."""

import pytest
from unittest.mock import MagicMock, patch


@pytest.mark.unit
class TestGeocodeLocation:
    def setup_method(self):
        # Clear caches before each test
        from backend.services.geocoding import _cached_geocode

        _cached_geocode.cache_clear()

    @patch("backend.services.geocoding._geocoder")
    def test_returns_coordinates_for_known_address(self, mock_geocoder):
        result = MagicMock()
        result.latitude = 48.8566
        result.longitude = 2.3522
        mock_geocoder.geocode.return_value = result

        from backend.services.geocoding import geocode_location

        coords = geocode_location("Paris, France")

        assert coords == (48.8566, 2.3522)
        mock_geocoder.geocode.assert_called_once_with("Paris, France")

    @patch("backend.services.geocoding._geocoder")
    def test_returns_none_for_unknown_address(self, mock_geocoder):
        mock_geocoder.geocode.return_value = None

        from backend.services.geocoding import geocode_location

        coords = geocode_location("xyznotaplace123")

        assert coords is None

    @patch("backend.services.geocoding._geocoder")
    def test_returns_none_on_timeout(self, mock_geocoder):
        from geopy.exc import GeocoderTimedOut

        mock_geocoder.geocode.side_effect = GeocoderTimedOut("timeout")

        from backend.services.geocoding import geocode_location

        coords = geocode_location("Paris, France")

        assert coords is None

    @patch("backend.services.geocoding._geocoder")
    def test_returns_none_on_service_error(self, mock_geocoder):
        from geopy.exc import GeocoderServiceError

        mock_geocoder.geocode.side_effect = GeocoderServiceError("service down")

        from backend.services.geocoding import geocode_location

        coords = geocode_location("Paris, France")

        assert coords is None

    @patch("backend.services.geocoding._geocoder")
    def test_caching_avoids_repeat_calls(self, mock_geocoder):
        result = MagicMock()
        result.latitude = 48.86
        result.longitude = 2.35
        mock_geocoder.geocode.return_value = result

        from backend.services.geocoding import geocode_location

        geocode_location("Same Address")
        geocode_location("Same Address")

        # Geocoder should only be called once due to lru_cache
        mock_geocoder.geocode.assert_called_once()
