"""Unit tests for price_extractor service."""

import pytest

from backend.services.price_extractor import extract_price


class TestExtractPriceFree:
    def test_free_keyword(self):
        result = extract_price("Join us for a free salsa night!")
        assert result is not None
        assert result["is_free"] is True
        assert result["min"] == 0
        assert result["max"] == 0

    def test_free_entry(self):
        result = extract_price("Free entry for all dancers.")
        assert result is not None
        assert result["is_free"] is True

    def test_gratis(self):
        result = extract_price("Eintritt gratis!")
        assert result is not None
        assert result["is_free"] is True

    def test_gratuit(self):
        result = extract_price("Entrée gratuite pour tous.")
        assert result is not None
        assert result["is_free"] is True

    def test_kostenlos(self):
        result = extract_price("Kostenlos tanzen!")
        assert result is not None
        assert result["is_free"] is True

    def test_entree_libre(self):
        result = extract_price("Entrée libre, venez nombreux!")
        assert result is not None
        assert result["is_free"] is True


class TestExtractPriceSingle:
    def test_eur_symbol_before(self):
        result = extract_price("Tickets: €15 at the door.")
        assert result is not None
        assert result["min"] == 15
        assert result["max"] == 15
        assert result["currency"] == "EUR"
        assert result["is_free"] is False

    def test_eur_code_before(self):
        result = extract_price("Entry EUR 20.")
        assert result is not None
        assert result["min"] == 20
        assert result["max"] == 20
        assert result["currency"] == "EUR"

    def test_usd_symbol_before(self):
        result = extract_price("Cover charge $25.")
        assert result is not None
        assert result["min"] == 25
        assert result["max"] == 25
        assert result["currency"] == "USD"

    def test_gbp_symbol_before(self):
        result = extract_price("Entry: £12.")
        assert result is not None
        assert result["min"] == 12
        assert result["max"] == 12
        assert result["currency"] == "GBP"

    def test_currency_after(self):
        result = extract_price("Tickets 15 EUR available online.")
        assert result is not None
        assert result["min"] == 15
        assert result["max"] == 15
        assert result["currency"] == "EUR"

    def test_currency_symbol_after(self):
        result = extract_price("Price: 20€ at the door.")
        assert result is not None
        assert result["min"] == 20
        assert result["max"] == 20
        assert result["currency"] == "EUR"

    def test_decimal_price(self):
        result = extract_price("Tickets €15.50 online.")
        assert result is not None
        assert result["min"] == 15.50
        assert result["max"] == 15.50

    def test_comma_decimal(self):
        result = extract_price("Tickets: 15,50€")
        assert result is not None
        assert result["min"] == 15.50


class TestExtractPriceRange:
    def test_eur_range_symbol(self):
        result = extract_price("Tickets: €15-€25")
        assert result is not None
        assert result["min"] == 15
        assert result["max"] == 25
        assert result["currency"] == "EUR"
        assert result["is_free"] is False

    def test_eur_range_code_before(self):
        result = extract_price("Entry EUR 15-25.")
        assert result is not None
        assert result["min"] == 15
        assert result["max"] == 25
        assert result["currency"] == "EUR"

    def test_range_currency_after(self):
        result = extract_price("Price: 10-20 EUR")
        assert result is not None
        assert result["min"] == 10
        assert result["max"] == 20
        assert result["currency"] == "EUR"

    def test_range_with_dash_spaces(self):
        result = extract_price("Cost: €10 - €30")
        assert result is not None
        assert result["min"] == 10
        assert result["max"] == 30

    def test_usd_range(self):
        result = extract_price("Admission $15-$30")
        assert result is not None
        assert result["min"] == 15
        assert result["max"] == 30
        assert result["currency"] == "USD"


class TestExtractPriceWordPatterns:
    def test_price_colon(self):
        result = extract_price("price: €15")
        assert result is not None
        assert result["min"] == 15
        assert result["currency"] == "EUR"

    def test_cost_colon(self):
        result = extract_price("cost: $20")
        assert result is not None
        assert result["min"] == 20
        assert result["currency"] == "USD"

    def test_entry_colon(self):
        result = extract_price("entry: £10")
        assert result is not None
        assert result["min"] == 10
        assert result["currency"] == "GBP"


class TestExtractPriceNone:
    def test_no_description(self):
        assert extract_price(None) is None

    def test_empty_description(self):
        assert extract_price("") is None

    def test_no_price_info(self):
        result = extract_price("Join us for a great salsa night in Paris!")
        assert result is None

    def test_number_without_currency(self):
        """Numbers without currency symbols should NOT be detected as prices."""
        result = extract_price("3 rooms, 20 workshops, nonstop socials.")
        assert result is None

    def test_no_price_is_not_free(self):
        """Crucial: no price found does NOT mean free."""
        result = extract_price("Great bachata workshop with international instructors.")
        assert result is None


class TestExtractPriceCurrencies:
    def test_chf(self):
        result = extract_price("CHF 30 entry fee.")
        assert result is not None
        assert result["currency"] == "CHF"

    def test_sek(self):
        result = extract_price("Tickets: SEK 200")
        assert result is not None
        assert result["currency"] == "SEK"

    def test_czk(self):
        result = extract_price("Entry: 350 CZK")
        assert result is not None
        assert result["currency"] == "CZK"
        assert result["min"] == 350

    def test_pln(self):
        result = extract_price("Cost: 50 PLN at the door.")
        assert result is not None
        assert result["currency"] == "PLN"
