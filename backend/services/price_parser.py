import re
from typing import Optional, TypedDict


class PriceInfo(TypedDict):
    min: float
    max: Optional[float]
    currency: str
    is_free: bool


_CURRENCY_MAP = {
    "€": "EUR",
    "$": "USD",
    "£": "GBP",
    "eur": "EUR",
    "usd": "USD",
    "gbp": "GBP",
    "chf": "CHF",
    "sek": "SEK",
    "nok": "NOK",
    "dkk": "DKK",
    "pln": "PLN",
    "czk": "CZK",
}
_CURRENCY = r"(?:€|\$|£|EUR|USD|GBP|CHF|SEK|NOK|DKK|PLN|CZK)"
_NUMBER = r"\d+(?:[.,]\d{1,2})?"
_RANGE_BEFORE = re.compile(
    rf"^\s*(?P<currency>{_CURRENCY})\s*(?P<low>{_NUMBER})\s*[-–—]\s*(?:(?P<second_currency>{_CURRENCY})\s*)?(?P<high>{_NUMBER})\s*\+?\s*$",
    re.IGNORECASE,
)
_RANGE_AFTER = re.compile(
    rf"^\s*(?P<low>{_NUMBER})\s*(?P<first_currency>{_CURRENCY})?\s*[-–—]\s*(?P<high>{_NUMBER})\s*(?P<currency>{_CURRENCY})\s*\+?\s*$",
    re.IGNORECASE,
)
_SINGLE_BEFORE = re.compile(
    rf"^\s*(?P<currency>{_CURRENCY})\s*(?P<value>{_NUMBER})\s*(?P<minimum_only>\+)?\s*$",
    re.IGNORECASE,
)
_SINGLE_AFTER = re.compile(
    rf"^\s*(?P<value>{_NUMBER})\s*(?P<currency>{_CURRENCY})\s*(?P<minimum_only>\+)?\s*$",
    re.IGNORECASE,
)
_FREE_VALUES = {
    "free",
    "free entry",
    "free admission",
    "gratis",
    "gratuit",
    "kostenlos",
}


def _number(value: str) -> float:
    return float(value.replace(",", "."))


def _currency(value: str) -> str:
    return _CURRENCY_MAP[value.lower()]


def parse_price_range(value: Optional[str]) -> Optional[PriceInfo]:
    if not value:
        return None
    if value.strip().lower() in _FREE_VALUES:
        return PriceInfo(min=0, max=0, currency="", is_free=True)

    match = _RANGE_BEFORE.fullmatch(value)
    if match:
        currency = _currency(match.group("currency"))
        second = match.group("second_currency")
        if second and _currency(second) != currency:
            return None
        return PriceInfo(
            min=_number(match.group("low")),
            max=_number(match.group("high")),
            currency=currency,
            is_free=False,
        )

    match = _RANGE_AFTER.fullmatch(value)
    if match:
        currency = _currency(match.group("currency"))
        first = match.group("first_currency")
        if first and _currency(first) != currency:
            return None
        return PriceInfo(
            min=_number(match.group("low")),
            max=_number(match.group("high")),
            currency=currency,
            is_free=False,
        )

    match = _SINGLE_BEFORE.fullmatch(value) or _SINGLE_AFTER.fullmatch(value)
    if match:
        amount = _number(match.group("value"))
        if amount == 0:
            return PriceInfo(min=0, max=0, currency="", is_free=True)
        return PriceInfo(
            min=amount,
            max=None if match.group("minimum_only") else amount,
            currency=_currency(match.group("currency")),
            is_free=False,
        )
    return None
