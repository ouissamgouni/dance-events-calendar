#!/usr/bin/env python3
"""Deterministically generate worldwide onboarding preview events + curator
attendances and append them to scenarios/onboarding/db-events.yaml.

Run once; safe to re-run (it rewrites the generated block between markers).
"""

from __future__ import annotations

import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "scenarios" / "onboarding" / "db-events.yaml"

BEGIN = "  # === BEGIN generated worldwide events (gen_onboarding_events.py) ==="
END = "  # === END generated worldwide events ==="

# (city, country, country_code, lat, lng)
CITIES = [
    ("Paris", "France", "FR", 48.8566, 2.3522),
    ("London", "United Kingdom", "GB", 51.5074, -0.1278),
    ("Madrid", "Spain", "ES", 40.4168, -3.7038),
    ("Barcelona", "Spain", "ES", 41.3874, 2.1686),
    ("Rome", "Italy", "IT", 41.9028, 12.4964),
    ("Milan", "Italy", "IT", 45.4642, 9.1900),
    ("Amsterdam", "Netherlands", "NL", 52.3676, 4.9041),
    ("Lisbon", "Portugal", "PT", 38.7223, -9.1393),
    ("Warsaw", "Poland", "PL", 52.2297, 21.0122),
    ("Zurich", "Switzerland", "CH", 47.3769, 8.5417),
    ("Prague", "Czechia", "CZ", 50.0755, 14.4378),
    ("Istanbul", "Turkiye", "TR", 41.0082, 28.9784),
    ("Vienna", "Austria", "AT", 48.2082, 16.3738),
    ("Stockholm", "Sweden", "SE", 59.3293, 18.0686),
    ("Berlin", "Germany", "DE", 52.5200, 13.4050),
    ("New York", "United States", "US", 40.7128, -74.0060),
    ("Miami", "United States", "US", 25.7617, -80.1918),
    ("Los Angeles", "United States", "US", 34.0522, -118.2437),
    ("Chicago", "United States", "US", 41.8781, -87.6298),
    ("San Francisco", "United States", "US", 37.7749, -122.4194),
    ("Toronto", "Canada", "CA", 43.6532, -79.3832),
    ("Montreal", "Canada", "CA", 45.5019, -73.5674),
    ("Mexico City", "Mexico", "MX", 19.4326, -99.1332),
    ("Havana", "Cuba", "CU", 23.1136, -82.3666),
    ("Bogota", "Colombia", "CO", 4.7110, -74.0721),
    ("Cali", "Colombia", "CO", 3.4516, -76.5320),
    ("Medellin", "Colombia", "CO", 6.2442, -75.5812),
    ("Buenos Aires", "Argentina", "AR", -34.6037, -58.3816),
    ("Sao Paulo", "Brazil", "BR", -23.5505, -46.6333),
    ("Rio de Janeiro", "Brazil", "BR", -22.9068, -43.1729),
    ("Lima", "Peru", "PE", -12.0464, -77.0428),
    ("Tokyo", "Japan", "JP", 35.6762, 139.6503),
    ("Singapore", "Singapore", "SG", 1.3521, 103.8198),
    ("Bangkok", "Thailand", "TH", 13.7563, 100.5018),
    ("Dubai", "United Arab Emirates", "AE", 25.2048, 55.2708),
    ("Seoul", "South Korea", "KR", 37.5665, 126.9780),
    ("Hong Kong", "Hong Kong", "HK", 22.3193, 114.1694),
    ("Bengaluru", "India", "IN", 12.9716, 77.5946),
    ("Tel Aviv", "Israel", "IL", 32.0853, 34.7818),
    ("Cape Town", "South Africa", "ZA", -33.9249, 18.4241),
    ("Nairobi", "Kenya", "KE", -1.2921, 36.8219),
    ("Lagos", "Nigeria", "NG", 6.5244, 3.3792),
    ("Marrakech", "Morocco", "MA", 31.6295, -7.9811),
    ("Accra", "Ghana", "GH", 5.6037, -0.1870),
    ("Luanda", "Angola", "AO", -8.8390, 13.2894),
    ("Sydney", "Australia", "AU", -33.8688, 151.2093),
    ("Melbourne", "Australia", "AU", -37.8136, 144.9631),
    ("Auckland", "New Zealand", "NZ", -36.8485, 174.7633),
]

# (dance-style slugs, human label)
COMBOS = [
    (["salsa"], "Salsa"),
    (["bachata"], "Bachata"),
    (["kizomba"], "Kizomba"),
    (["zouk"], "Zouk"),
    (["mambo"], "Mambo"),
    (["salsa", "bachata"], "Salsa & Bachata"),
    (["salsa", "bachata", "kizomba"], "Salsa, Bachata & Kizomba"),
    (["salsa", "mambo"], "Salsa & Mambo"),
]

REACH = ["local", "regional", "international"]
FORMATS = [("social", "Social"), ("workshop", "Workshop"), ("festival", "Festival")]
DAYS = ["Thu", "Fri", "Sat", "Sun"]
NEXT_DAY = {"Thu": "Fri", "Fri": "Sat", "Sat": "Sun", "Sun": "Mon"}

# The curator (verifiedcurator) is publicly going to every Nth generated event,
# giving us a "curator with events" the newbie can discover after following.
CURATOR_EMAIL = "verifiedcurator@example.com"
CURATOR_EVERY = 6


def slugify(text: str) -> str:
    ascii_text = (
        unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    )
    return "-".join(ascii_text.lower().split())


def build() -> tuple[list[str], list[str]]:
    events: list[str] = []
    curator_events: list[str] = []
    idx = 0
    for city, country, code, lat, lng in CITIES:
        for _ in range(2):
            styles, style_label = COMBOS[idx % len(COMBOS)]
            reach = REACH[(idx // 2) % len(REACH)]
            fmt_slug, fmt_label = FORMATS[(idx // 3) % len(FORMATS)]
            day = DAYS[idx % len(DAYS)]
            week = 1 + ((idx * 7) % 51)
            city_slug = slugify(city)
            eid = f"onb-gen-{idx:03d}-{city_slug}"

            if fmt_slug == "social":
                start = f"w{week} {day} 20:00"
                end = f"w{week} {NEXT_DAY[day]} 01:00"
            elif fmt_slug == "workshop":
                start = f"w{week} {day} 14:00"
                end = f"w{week} {day} 18:00"
            else:  # festival
                start = f"w{week} {day} 18:00"
                end = f"w{week} {day} 23:00"

            title = f"{style_label} {fmt_label} \u2013 {city}"
            desc = f"{style_label} {fmt_label.lower()} in {city} ({reach} scale)."

            tag_lines = [f"      - format:{fmt_slug}"]
            tag_lines += [f"      - dance-style:{s}" for s in styles]
            tag_lines.append(f"      - reach:{reach}")

            block = [
                f"  - id: {eid}",
                "    calendar_id: salsa-cal-001",
                f"    title: {title}",
                f"    description: {desc}",
                f"    location: {city}, {country}",
                f"    latitude: {lat}",
                f"    longitude: {lng}",
                f"    city: {city}",
                f"    country: {country}",
                f"    country_code: {code}",
                f"    start: {start}",
                f"    end: {end}",
                "    tags:",
                *tag_lines,
                "",
            ]
            events.extend(block)

            if idx % CURATOR_EVERY == 0:
                curator_events.append(eid)
            idx += 1

    return events, curator_events


def main() -> None:
    text = TARGET.read_text()

    # Strip any prior generated block + attendances block so re-runs are clean.
    if BEGIN in text:
        head, rest = text.split(BEGIN, 1)
        _, tail = rest.split(END, 1)
        text = head + tail
    if "\nattendances:" in text:
        text = text.split("\nattendances:", 1)[0] + "\n"

    text = text.rstrip("\n") + "\n"

    events, curator_events = build()

    gen = [BEGIN, ""] + events + [END, ""]
    text += "\n".join(gen)

    att_lines = ["", "attendances:"]
    for eid in curator_events:
        att_lines.append(f"  - event_id: {eid}")
        att_lines.append(f"    email: {CURATOR_EMAIL}")
        att_lines.append("    share_publicly: true")
    text = text.rstrip("\n") + "\n" + "\n".join(att_lines) + "\n"

    TARGET.write_text(text)
    total_gen = sum(1 for line in events if line.startswith("  - id:"))
    print(f"Generated {total_gen} events; curator going to {len(curator_events)}.")


if __name__ == "__main__":
    main()
