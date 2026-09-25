import pytest

from backend.services.price_parser import parse_price_range


@pytest.mark.unit
@pytest.mark.parametrize(
    ("value", "minimum", "maximum", "currency"),
    [
        ("€100–€150", 100, 150, "EUR"),
        ("EUR 15-25", 15, 25, "EUR"),
        ("EUR 12-18", 12, 18, "EUR"),
        ("EUR 120+", 120, None, "EUR"),
        ("EUR 15", 15, 15, "EUR"),
        ("EUR 100-300+", 100, 300, "EUR"),
        ("10-20 EUR", 10, 20, "EUR"),
        ("$15-$30", 15, 30, "USD"),
        ("15,50€", 15.5, 15.5, "EUR"),
        ("CHF 30", 30, 30, "CHF"),
    ],
)
def test_parses_structured_price_values(value, minimum, maximum, currency):
    result = parse_price_range(value)

    assert result is not None
    assert result["min"] == minimum
    assert result["max"] == maximum
    assert result["currency"] == currency
    assert result["is_free"] is False


@pytest.mark.unit
def test_parses_explicit_free_value():
    result = parse_price_range("free entry")

    assert result == {"min": 0, "max": 0, "currency": "", "is_free": True}


@pytest.mark.unit
def test_parses_zero_amount_as_free():
    result = parse_price_range("EUR 0")

    assert result == {"min": 0, "max": 0, "currency": "", "is_free": True}


@pytest.mark.unit
@pytest.mark.parametrize(
    "value",
    [
        None,
        "",
        "Tickets are €15 at the door",
        "Price: €15",
        "3 rooms and 20 workshops",
        "€10-$20",
    ],
)
def test_rejects_empty_prose_and_mixed_currencies(value):
    assert parse_price_range(value) is None
