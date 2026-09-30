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


@pytest.mark.unit
def test_google_rich_text_description_is_normalized_before_extraction():
    description = (
        "<p>Multi-style sensual festival in Germany.</p>"
        "<p>&lt;&lt;&lt;EXTRACTOR_JSON&gt;&gt;&gt;\n"
        "{&quot;links&quot;:[&quot;https://www.goandance.com/event/9756&quot;,&quot;https://sensual-festival.de/&quot;],"
        "&quot;image&quot;:&quot;&quot;,&quot;tags&quot;:[&quot;salsa&quot;,&quot;bachata&quot;,&quot;kizomba&quot;],"
        "&quot;price_range&quot;:&quot;EUR 169-179&quot;}\n"
        "&lt;&lt;&lt;END_EXTRACTOR_JSON&gt;&gt;&gt;</p>"
    )

    result = extract_description(description)

    assert result.description == "Multi-style sensual festival in Germany."
    assert result.payload is not None
    assert result.payload.links == [
        "https://www.goandance.com/event/9756",
        "https://sensual-festival.de/",
    ]
    assert result.payload.tags == ["salsa", "bachata", "kizomba"]
    assert result.payload.price_range == "EUR 169-179"


@pytest.mark.unit
def test_google_rich_text_preserves_meaningful_line_breaks():
    result = extract_description("<p>First paragraph</p><p>Second<br>line</p>")

    assert result.description == "First paragraph\nSecond\nline"
    assert result.payload is None


@pytest.mark.unit
def test_invalid_google_rich_text_block_preserves_source_exactly():
    description = (
        "<p>Human text</p>"
        "<p>&lt;&lt;&lt;EXTRACTOR_JSON&gt;&gt;&gt;{bad json}"
        "&lt;&lt;&lt;END_EXTRACTOR_JSON&gt;&gt;&gt;</p>"
    )

    result = extract_description(description)

    assert result.description == description
    assert result.payload is None


@pytest.mark.unit
def test_plain_text_with_angle_brackets_is_preserved():
    description = "Meet at <venue> near the station"

    result = extract_description(description)

    assert result.description == description
    assert result.payload is None
