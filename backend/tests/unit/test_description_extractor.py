import pytest

from backend.services.description_extractor import extract_description


START = "<<<EXTRACTOR_JSON>>>"
END = "<<<END_EXTRACTOR_JSON>>>"


@pytest.mark.unit
def test_missing_markers_preserves_description():
    description = "Salsa social with tickets at the door"

    result = extract_description(description)

    assert result.description == description
    assert result.payload is None


@pytest.mark.unit
@pytest.mark.parametrize(
    "description",
    [
        f"Human text\n{START}\n{{bad json}}\n{END}",
        f'Human text\n{START}\n{{"tags": []}}',
        f"Human text\n{START}\n[]\n{END}",
        f'Human text\n{START}\n{{"tags": "salsa"}}\n{END}',
    ],
)
def test_invalid_block_preserves_description_exactly(description):
    result = extract_description(description)

    assert result.description == description
    assert result.payload is None


@pytest.mark.unit
def test_valid_block_is_normalized_and_removed():
    description = f"""Human-readable event details.

{START}
{{
  "links": ["https://example.com", "ftp://invalid.test", "https://example.com", "http://tickets.test/x"],
  "image": "https://images.test/poster.jpg",
  "tags": [" Salsa ", "MAMBO", "salsa", ""],
  "price_range": " €100–€150 ",
  "future_field": {{"ignored": true}}
}}
{END}"""

    result = extract_description(description)

    assert result.description == "Human-readable event details."
    assert result.payload is not None
    assert result.payload.links == [
        "https://example.com",
        "http://tickets.test/x",
    ]
    assert result.payload.image == "https://images.test/poster.jpg"
    assert result.payload.tags == ["salsa", "mambo"]
    assert result.payload.price_range == "€100–€150"


@pytest.mark.unit
def test_missing_fields_use_empty_schema_values():
    result = extract_description(f"{START}{{}}{END}")

    assert result.payload is not None
    assert result.payload.links == []
    assert result.payload.image == ""
    assert result.payload.tags == []
    assert result.payload.price_range == ""


@pytest.mark.unit
def test_invalid_image_url_becomes_empty():
    result = extract_description(f'{START}{{"image":"file:///tmp/poster.jpg"}}{END}')

    assert result.payload is not None
    assert result.payload.image == ""


@pytest.mark.unit
def test_only_first_block_is_parsed_and_all_complete_blocks_are_cleaned():
    description = (
        f'Before\n{START}{{"tags":["salsa"]}}{END}\n'
        f'Middle\n{START}{{"tags":["bachata"]}}{END}\nAfter'
    )

    result = extract_description(description)

    assert result.payload is not None
    assert result.payload.tags == ["salsa"]
    assert result.description == "Before\n\nMiddle\n\nAfter"
