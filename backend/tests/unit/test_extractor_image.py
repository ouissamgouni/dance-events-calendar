from datetime import datetime
from unittest.mock import patch

import pytest

from backend.db.models import CachedEvent
from backend.services.event_extractor import (
    apply_calendar_description,
    apply_extractor_image,
    extractor_image_needed,
)


START = "<<<EXTRACTOR_JSON>>>"
END = "<<<END_EXTRACTOR_JSON>>>"


def _event():
    return CachedEvent(
        event_id="evt-1",
        calendar_id="cal-1",
        title="Salsa Night",
        start=datetime(2026, 10, 1, 20),
        end=datetime(2026, 10, 1, 23),
    )


@pytest.mark.unit
def test_imports_extracted_image_and_records_ownership():
    event = _event()
    raw = f'{START}{{"image":"https://images.test/poster.jpg"}}{END}'
    apply_calendar_description(event, raw, is_new=True)

    with patch(
        "backend.services.event_images.replace_event_image_from_url",
        return_value="events/evt-1/imported",
    ) as replace:
        assert apply_extractor_image(event) is True

    replace.assert_called_once_with("evt-1", "https://images.test/poster.jpg", None)
    assert event.image_key == "events/evt-1/imported"
    assert event.extractor_state["applied"]["image"] == {
        "url": "https://images.test/poster.jpg",
        "key": "events/evt-1/imported",
    }


@pytest.mark.unit
def test_admin_replacement_is_not_overwritten():
    event = _event()
    first = f'{START}{{"image":"https://images.test/one.jpg"}}{END}'
    second = f'{START}{{"image":"https://images.test/two.jpg"}}{END}'
    apply_calendar_description(event, first, is_new=True)
    with patch(
        "backend.services.event_images.replace_event_image_from_url",
        return_value="events/evt-1/imported",
    ):
        apply_extractor_image(event)
    event.image_key = "events/evt-1/admin"
    apply_calendar_description(event, second, is_new=False)

    assert extractor_image_needed(event) is False
    assert apply_extractor_image(event) is False
    assert event.image_key == "events/evt-1/admin"


@pytest.mark.unit
def test_empty_image_removes_only_extractor_owned_image():
    event = _event()
    first = f'{START}{{"image":"https://images.test/one.jpg"}}{END}'
    empty = f'{START}{{"image":""}}{END}'
    apply_calendar_description(event, first, is_new=True)
    with patch(
        "backend.services.event_images.replace_event_image_from_url",
        return_value="events/evt-1/imported",
    ):
        apply_extractor_image(event)
    apply_calendar_description(event, empty, is_new=False)

    with patch("backend.services.event_images.delete_event_image") as delete:
        assert apply_extractor_image(event) is True

    delete.assert_called_once_with("events/evt-1/imported")
    assert event.image_key is None
