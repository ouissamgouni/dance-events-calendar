"""Extract price information from event description text."""

import re
from typing import Optional, TypedDict


class PriceInfo(TypedDict):
    min: float
    max: float
    currency: str
    is_free: bool


# Currency symbol/code → ISO code
_CURRENCY_MAP: dict[str, str] = {
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

# Regex fragments
_CURR_SYMBOLS = r"[€$£]"
_CURR_CODES = r"(?:EUR|USD|GBP|CHF|SEK|NOK|DKK|PLN|CZK)"
_CURR = rf"(?:{_CURR_SYMBOLS}|{_CURR_CODES})"
_NUM = r"\d+(?:[.,]\d{1,2})?"

# "Free" patterns (case-insensitive).
# Bare "free" is intentionally NOT matched: it produces too many false positives
# ("free parking", "free wifi", "feel free to bring a partner", "free shuttle",
# "free salsa night" → often refers to the style, not entry). We require an
# explicit admission/entry context.
_FREE_PATTERN = re.compile(
    r"\b(?:"
    r"free\s+(?:entry|entrance|admission|admittance|event)"
    r"|admission\s+free"
    r"|no\s+(?:cover|charge|entry\s+fee|admission\s+fee)"
    r"|gratis"
    r"|gratuit(?:e|es)?"
    r"|kostenlos"
    r"|eintritt\s+frei"
    r"|entr[ée]e?\s+(?:libre|gratuite)"
    r")\b",
    re.IGNORECASE,
)

# Price patterns (ordered by specificity)
# Range: currency before numbers — EUR 15-25, €15 - €25
_RANGE_CURR_BEFORE = re.compile(
    rf"({_CURR})\s*({_NUM})\s*[-–—]\s*(?:{_CURR}\s*)?({_NUM})",
    re.IGNORECASE,
)
# Range: currency after numbers — 15-25 EUR, 15€-25€
_RANGE_CURR_AFTER = re.compile(
    rf"({_NUM})\s*{_CURR}?\s*[-–—]\s*({_NUM})\s*({_CURR})",
    re.IGNORECASE,
)
# Single: currency before — EUR 15, €15, $20
_SINGLE_CURR_BEFORE = re.compile(
    rf"({_CURR})\s*({_NUM})",
    re.IGNORECASE,
)
# Single: currency after — 15 EUR, 15€, 20$
_SINGLE_CURR_AFTER = re.compile(
    rf"({_NUM})\s*({_CURR})",
    re.IGNORECASE,
)
# Word patterns: price: 15, cost: 15, entry: 15 (with optional currency and range)
_WORD_PRICE_RANGE = re.compile(
    rf"(?:price|cost|entry|entr[ée]e|precio|preis|prix)\s*[:=]\s*(?:({_CURR})\s*)?({_NUM})\s*[-–—]\s*(?:{_CURR}\s*)?({_NUM})\s*({_CURR})?",
    re.IGNORECASE,
)
_WORD_PRICE = re.compile(
    rf"(?:price|cost|entry|entr[ée]e|precio|preis|prix)\s*[:=]\s*(?:({_CURR})\s*)?({_NUM})\s*({_CURR})?",
    re.IGNORECASE,
)


def _parse_number(s: str) -> float:
    """Parse a number string like '15', '15.50', '15,50'."""
    return float(s.replace(",", "."))


def _normalize_currency(raw: str) -> str:
    """Normalize a currency symbol or code to ISO code."""
    return _CURRENCY_MAP.get(raw.lower(), raw.upper())


def extract_price(description: Optional[str]) -> Optional[PriceInfo]:
    """Extract price info from an event description.

    Returns a PriceInfo dict if price information is found, None otherwise.
    'No price found' does NOT mean free — returns None in that case.
    """
    if not description:
        return None

    # Check for free first
    if _FREE_PATTERN.search(description):
        return PriceInfo(min=0, max=0, currency="", is_free=True)

    # Try word patterns first (most explicit)
    # Word range: cost: €10-€30
    m = _WORD_PRICE_RANGE.search(description)
    if m:
        curr_before, low, high, curr_after = m.groups()
        curr = curr_before or curr_after
        if curr:
            return PriceInfo(
                min=_parse_number(low),
                max=_parse_number(high),
                currency=_normalize_currency(curr),
                is_free=False,
            )

    # Word single: cost: €10
    m = _WORD_PRICE.search(description)
    if m:
        curr_before, num, curr_after = m.groups()
        curr = curr_before or curr_after
        if curr:
            val = _parse_number(num)
            return PriceInfo(
                min=val, max=val, currency=_normalize_currency(curr), is_free=False
            )

    # Try range with currency before: EUR 15-25, €15-€25
    m = _RANGE_CURR_BEFORE.search(description)
    if m:
        curr, low, high = m.groups()
        return PriceInfo(
            min=_parse_number(low),
            max=_parse_number(high),
            currency=_normalize_currency(curr),
            is_free=False,
        )

    # Try range with currency after: 15-25 EUR, 15€-25€
    m = _RANGE_CURR_AFTER.search(description)
    if m:
        low, high, curr = m.groups()
        return PriceInfo(
            min=_parse_number(low),
            max=_parse_number(high),
            currency=_normalize_currency(curr),
            is_free=False,
        )

    # Try single with currency before: EUR 15, €15, $20
    m = _SINGLE_CURR_BEFORE.search(description)
    if m:
        curr, num = m.groups()
        val = _parse_number(num)
        return PriceInfo(
            min=val, max=val, currency=_normalize_currency(curr), is_free=False
        )

    # Try single with currency after: 15 EUR, 15€, 20$
    m = _SINGLE_CURR_AFTER.search(description)
    if m:
        num, curr = m.groups()
        val = _parse_number(num)
        return PriceInfo(
            min=val, max=val, currency=_normalize_currency(curr), is_free=False
        )

    # No price found — NOT free, just unknown
    return None
