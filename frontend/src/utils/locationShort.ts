/**
 * Reduce a free-form venue/address string ("Dance Studio, 10 Rue de Rivoli,
 * 75001 Paris, France") to a compact "City, Country" label. Heuristic
 * because the backend doesn't expose structured city/country on the event
 * yet — strips leading venue/street parts, drops postal codes.
 */
export function shortLocation(value: string | null | undefined): string | null {
    if (!value) return null;
    const parts = value.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0) return null;
    if (parts.length === 1) return parts[0];
    const tail = parts.slice(-2);
    // Strip leading digits (postal codes) from the city segment.
    const city = tail[0].replace(/^\d[\d\s-]*\s?/, '').trim() || tail[0];
    const country = tail[1];
    return city && country ? `${city}, ${country}` : city || country;
}
