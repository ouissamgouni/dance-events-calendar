"""Tests for place autocomplete (backend/services/places.py)."""

from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import httpx
import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from backend.db.models import CachedEvent, SiteSetting
from backend.services import places

START = datetime(2030, 1, 1, 20, 0, 0, tzinfo=timezone.utc)

GEOAPIFY_VENUE = {
    "name": "Havana Club",
    "street": "Main Street",
    "housenumber": "12",
    "city": "Berlin",
    "state": "Berlin",
    "country": "Germany",
    "country_code": "de",
    "lat": 52.52,
    "lon": 13.4,
    "formatted": "Havana Club, Main Street 12, 10115 Berlin, Germany",
    "address_line1": "Havana Club",
    "address_line2": "Main Street 12, 10115 Berlin, Germany",
    "result_type": "amenity",
    "place_id": "geo-123",
    "timezone": {"name": "Europe/Berlin"},
}

PHOTON_CITY = {
    "type": "Feature",
    "geometry": {"type": "Point", "coordinates": [2.35, 48.85]},
    "properties": {
        "osm_type": "R",
        "osm_id": 7444,
        "type": "city",
        "name": "Paris",
        "state": "Ile-de-France",
        "country": "France",
        "countrycode": "FR",
        "extent": [2.22, 48.90, 2.47, 48.81],
    },
}


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


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    places._cache.clear()
    monkeypatch.setattr(places, "_budget_day", None)
    monkeypatch.setattr(places, "_budget_used", 0)
    monkeypatch.setenv("GEOAPIFY_API_KEY", "test-key")
    monkeypatch.setenv("GEOAPIFY_ENABLED", "true")


def _response(payload: dict) -> MagicMock:
    response = MagicMock()
    response.json.return_value = payload
    response.raise_for_status.return_value = None
    return response


def test_geoapify_venue_maps_to_structured_place():
    s = places.geoapify_suggestion(GEOAPIFY_VENUE)

    assert s["name"] == "Havana Club"
    assert s["place_kind"] == "poi"
    assert s["context"] == "Main Street 12, 10115 Berlin, Germany"
    assert s["street_address"] == "Main Street 12"
    assert s["country_code"] == "DE"
    assert s["timezone"] == "Europe/Berlin"
    assert s["place_id"] == "geo-123"
    assert s["provider"] == "geoapify"


def test_photon_city_maps_kind_and_bounding_box():
    s = places.photon_suggestion(PHOTON_CITY)

    assert s["place_kind"] == "city"
    assert s["context"] == "Ile-de-France, France"
    assert s["bounding_box"] == {
        "min_lat": 48.81,
        "min_lng": 2.22,
        "max_lat": 48.90,
        "max_lng": 2.47,
    }
    assert s["place_id"] == "R7444"


def test_autocomplete_uses_geoapify_when_enabled(session):
    with patch.object(
        places.httpx, "get", return_value=_response({"results": [GEOAPIFY_VENUE]})
    ) as get:
        results = places.autocomplete(session, "havana", kind="city", lang="de")

    assert [r["provider"] for r in results] == ["geoapify"]
    assert get.call_args.args[0] == places.GEOAPIFY_URL
    assert get.call_args.kwargs["params"]["type"] == "city"
    assert get.call_args.kwargs["params"]["lang"] == "de"


def test_autocomplete_uses_photon_when_flag_off(session):
    session.add(SiteSetting(key="geoapify_enabled", value="false"))
    session.commit()
    with patch.object(
        places.httpx, "get", return_value=_response({"features": [PHOTON_CITY]})
    ) as get:
        results = places.autocomplete(session, "paris", kind="city", lang="el")

    assert [r["provider"] for r in results] == ["photon"]
    assert get.call_args.args[0] == places.PHOTON_URL
    assert get.call_args.kwargs["params"]["layer"] == "city"
    assert get.call_args.kwargs["params"]["lang"] == "default"


def test_autocomplete_falls_back_to_photon_on_geoapify_error(session):
    def fake_get(url, **kwargs):
        if url == places.GEOAPIFY_URL:
            raise httpx.ConnectError("down")
        return _response({"features": [PHOTON_CITY]})

    with patch.object(places.httpx, "get", side_effect=fake_get):
        results = places.autocomplete(session, "paris")

    assert [r["provider"] for r in results] == ["photon"]


def test_autocomplete_falls_back_to_photon_when_budget_spent(session, monkeypatch):
    monkeypatch.setenv("GEOAPIFY_DAILY_BUDGET", "0")
    with patch.object(
        places.httpx, "get", return_value=_response({"features": [PHOTON_CITY]})
    ) as get:
        places.autocomplete(session, "paris")

    assert get.call_args.args[0] == places.PHOTON_URL


def test_autocomplete_caches_results(session):
    with patch.object(
        places.httpx, "get", return_value=_response({"results": [GEOAPIFY_VENUE]})
    ) as get:
        places.autocomplete(session, "Havana  Club")
        places.autocomplete(session, "havana club")

    assert get.call_count == 1


def _event(event_id: str, **overrides) -> CachedEvent:
    values = dict(
        event_id=event_id,
        calendar_id="cal",
        title="Social",
        start=START,
        end=START + timedelta(hours=3),
        location="Havana Club, Main Street 12, Berlin",
        latitude=52.52,
        longitude=13.4,
        review_status="reviewed",
        status="published",
    )
    values.update(overrides)
    return CachedEvent(**values)


def test_known_venues_ranks_by_use_and_hides_private_events(session):
    session.add(_event("a"))
    session.add(_event("b"))
    session.add(_event("c", location="Havana Bar, Berlin", latitude=52.5))
    session.add(_event("d", location="Havana Secret Loft", visibility="private"))
    session.commit()

    venues = places.known_venues(session, "havana")

    assert [v["display_name"] for v in venues] == [
        "Havana Club, Main Street 12, Berlin",
        "Havana Bar, Berlin",
    ]
    assert venues[0]["source"] == "known"
    assert venues[0]["name"] == "Havana Club"


def test_merge_drops_provider_duplicates_of_known_venues():
    known = [{"name": "Havana Club", "latitude": 52.52, "longitude": 13.4}]
    found = [
        {"name": "havana club", "latitude": 52.5201, "longitude": 13.4001},
        {"name": "Havana Club", "latitude": 48.85, "longitude": 2.35},
    ]

    merged = places.merge_suggestions(known, found)

    assert merged == known + [found[1]]


def test_clear_stale_place_only_when_location_typed_by_hand():
    typed = {"location": "Somewhere new"}
    places.clear_stale_place(typed, "Havana Club")
    assert typed["venue_name"] is None and typed["place_id"] is None

    picked = {"location": "Salsa Bar", "venue_name": "Salsa Bar", "place_id": "p1"}
    places.clear_stale_place(picked, "Havana Club")
    assert picked["place_id"] == "p1"

    unchanged = {"location": "Havana Club"}
    places.clear_stale_place(unchanged, "Havana Club")
    assert unchanged == {"location": "Havana Club"}
