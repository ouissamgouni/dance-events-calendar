from datetime import datetime

import pytest

from backend.db.models import CachedEvent
from backend.services.event_extractor import apply_calendar_description


START = "<<<EXTRACTOR_JSON>>>"
END = "<<<END_EXTRACTOR_JSON>>>"


def _event(description=None, **overrides):
    values = {
        "event_id": "evt-1",
        "calendar_id": "cal-1",
        "title": "Salsa Night",
        "description": description,
        "start": datetime(2026, 10, 1, 20),
        "end": datetime(2026, 10, 1, 23),
    }
    values.update(overrides)
    return CachedEvent(**values)


@pytest.mark.unit
def test_new_event_applies_clean_description_links_and_price():
    raw = (
        f"Human text\n{START}"
        '{"links":["https://tickets.test"],"price_range":"€10–€20"}'
        f"{END}"
    )
    event = _event()

    apply_calendar_description(event, raw, is_new=True)

    assert event.source_description == raw
    assert event.description == "Human text"
    assert event.links == [{"url": "https://tickets.test", "label": None}]
    assert event.price_min == 10
    assert event.price_max == 20
    assert event.price_currency == "EUR"
    assert event.extractor_state["valid"] is True


@pytest.mark.unit
def test_existing_extractor_owned_values_refresh():
    event = _event()
    first = f'First{START}{{"links":["https://one.test"]}}{END}'
    second = f'Second{START}{{"links":["https://two.test"]}}{END}'
    apply_calendar_description(event, first, is_new=True)

    apply_calendar_description(event, second, is_new=False)

    assert event.description == "Second"
    assert event.links == [{"url": "https://two.test", "label": None}]


@pytest.mark.unit
def test_backfilled_legacy_raw_description_is_cleaned_on_first_sync():
    raw = f'Human text{START}{{"tags":["salsa"]}}{END}'
    event = _event(description=raw, source_description=raw)

    apply_calendar_description(event, raw, is_new=False)

    assert event.description == "Human text"


@pytest.mark.unit
def test_admin_values_survive_later_extractor_changes():
    event = _event()
    first = f'First{START}{{"links":["https://one.test"],"price_range":"€10"}}{END}'
    second = f'Second{START}{{"links":["https://two.test"],"price_range":"€20"}}{END}'
    apply_calendar_description(event, first, is_new=True)
    event.description = "Admin description"
    event.links = [{"url": "https://admin.test", "label": "Official"}]
    event.price_min = event.price_max = 15
    event.price_currency = "EUR"
    event.price_is_free = False

    apply_calendar_description(event, second, is_new=False)

    assert event.source_description == second
    assert event.description == "Admin description"
    assert event.links == [{"url": "https://admin.test", "label": "Official"}]
    assert event.price_min == event.price_max == 15


@pytest.mark.unit
def test_invalid_block_preserves_existing_structured_values():
    event = _event(
        description="Admin text",
        links=[{"url": "https://admin.test", "label": None}],
        price_min=12,
        price_max=12,
        price_currency="EUR",
        price_is_free=False,
    )
    raw = f"Source{START}{{bad json}}{END}"

    apply_calendar_description(event, raw, is_new=False)

    assert event.description == "Admin text"
    assert event.links == [{"url": "https://admin.test", "label": None}]
    assert event.price_min == 12
    assert event.extractor_state["valid"] is False
