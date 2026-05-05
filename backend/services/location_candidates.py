"""Utilities for generating ordered geocoding candidate strings from event data.

Priority order returned by ``extract_candidates``:
  1. Raw location text (as-is from calendar)
  2. Location + locale hint  (helps resolve bare venue names like "Salsa O'sulli")
  3. Decoded Google Maps URLs from description (most structured)
  4. Address-like fragments extracted from description
"""

import re
from typing import Optional
from urllib.parse import parse_qs, unquote_plus, urlparse

# Matches "123 Rue de la Paix", "10 Downing Street", etc.
_ADDRESS_NUMBER_FIRST_RE = re.compile(
    r"\b\d{1,5}[,\s]+[A-Za-zÀ-ÿ][^\n,;]{5,60}",
    re.UNICODE,
)

# Matches "75011 Paris", "EC1A 1BB London", etc.
_POSTAL_CITY_RE = re.compile(
    r"\b[A-Z0-9]{4,8}[\s\-]+[A-Za-zÀ-ÿ][^\n,;]{3,40}",
    re.UNICODE,
)

# All common Google Maps URL formats
_MAPS_URL_RE = re.compile(
    r"https?://(?:www\.)?maps\.google\.[a-z]{2,6}/[^\s<>\"')]*"
    r"|https?://goo\.gl/maps/[^\s<>\"')]*"
    r"|https?://maps\.app\.goo\.gl/[^\s<>\"')]*",
    re.IGNORECASE,
)


def _decode_maps_url(url: str) -> Optional[str]:
    """Extract a geocodable query string from a Google Maps URL.

    Handles:
    - ?q=... / ?query=...
    - /maps/place/<Name>/@lat,lng
    """
    try:
        parsed = urlparse(url)
        qs = parse_qs(parsed.query)
        for key in ("q", "query", "destination", "origin", "daddr"):
            vals = qs.get(key)
            if vals:
                decoded = unquote_plus(vals[0]).strip()
                if decoded:
                    return decoded
        # /maps/place/<Name>/...
        m = re.search(r"/place/([^/@?]+)", parsed.path)
        if m:
            name = unquote_plus(m.group(1)).replace("+", " ").strip()
            if name:
                return name
    except Exception:
        pass
    return None


def _address_fragments(text: str) -> list[str]:
    """Extract address-like substrings from free text (deduped, ordered by appearance)."""
    seen: set[str] = set()
    results: list[str] = []
    for pattern in (_ADDRESS_NUMBER_FIRST_RE, _POSTAL_CITY_RE):
        for m in pattern.finditer(text):
            frag = m.group(0).strip(" ,\t\n")
            if len(frag) > 6 and frag not in seen:
                seen.add(frag)
                results.append(frag)
    return results


def extract_candidates(
    location: Optional[str],
    description: Optional[str],
    locale_hint: Optional[str] = None,
) -> list[str]:
    """Return an ordered list of candidate strings for geocoding.

    Parameters
    ----------
    location:
        The raw ``event.location`` field from the calendar provider.
    description:
        The event description, searched for Maps URLs and address fragments.
    locale_hint:
        An optional city/country string (e.g. ``"Paris, France"``) to append
        to ambiguous venue names to improve geocoding success rate.

    Returns
    -------
    list[str]
        Deduplicated candidate strings, most-specific first.
    """
    seen: set[str] = set()
    candidates: list[str] = []

    def _add(s: str) -> None:
        s = s.strip()
        if s and len(s) >= 3 and s not in seen:
            seen.add(s)
            candidates.append(s)

    # 1. Raw location (highest priority — already has whatever structure the organiser provided)
    if location:
        _add(location)
        if locale_hint:
            _add(f"{location}, {locale_hint}")

    if description:
        # 2. Decoded Maps URLs (structured, high quality)
        for url in _MAPS_URL_RE.findall(description):
            decoded = _decode_maps_url(url)
            if decoded:
                _add(decoded)
                if locale_hint:
                    _add(f"{decoded}, {locale_hint}")

        # 3. Address-like fragments (last resort)
        for frag in _address_fragments(description):
            _add(frag)
            if locale_hint:
                _add(f"{frag}, {locale_hint}")

    return candidates
