/**
 * Default map area applied to the explorer when the user has no saved
 * preferences and the URL has no explicit bbox params. Covers Europe and
 * the Mediterranean basin (the "Europe & nearby" footprint that matches
 * the European salsa/kizomba/bachata festival circuit). Plain constants on
 * purpose — see `/memories/session/plan.md` for why this is not (yet)
 * admin-configurable.
 */
export interface AreaBbox {
    min_lat: number;
    min_lng: number;
    max_lat: number;
    max_lng: number;
    label: string;
}

export const DEFAULT_AREA_BBOX: AreaBbox = {
    min_lat: 24,
    min_lng: -18,
    max_lat: 69,
    max_lng: 50,
    label: 'Europe & nearby',
};

export const DEFAULT_AREA_LABEL = DEFAULT_AREA_BBOX.label;

/**
 * Quick-select region presets shown as pills under the area picker.
 * Bounding boxes are approximate continental extents (west/south/east/north)
 * aligned with standard map-picker continent shortcuts. "Worldwide" spans
 * the populated latitude band rather than the full poles so the resulting
 * view stays usable.
 */
export const AREA_PRESETS: readonly AreaBbox[] = [
    { label: 'Worldwide', min_lat: -55, min_lng: -170, max_lat: 75, max_lng: 170 },
    {
        label: 'Europe',
        min_lat: 20,
        min_lng: -10,
        max_lat: 65,
        max_lng: 40,
    },
    { label: 'Asia', min_lat: -11, min_lng: 60, max_lat: 60, max_lng: 150 },
    { label: 'North America', min_lat: 7, min_lng: -168, max_lat: 72, max_lng: -52 },
    { label: 'South America', min_lat: -56, min_lng: -82, max_lat: 13, max_lng: -34 },
    { label: 'Africa', min_lat: -35, min_lng: -18, max_lat: 38, max_lng: 52 },
    { label: 'Oceania', min_lat: -50, min_lng: 110, max_lat: 0, max_lng: 180 },
];

/** True when the supplied area is the unmodified default. */
export function isDefaultArea(area: AreaBbox | null | undefined): boolean {
    if (!area) return false;
    return (
        area.min_lat === DEFAULT_AREA_BBOX.min_lat &&
        area.min_lng === DEFAULT_AREA_BBOX.min_lng &&
        area.max_lat === DEFAULT_AREA_BBOX.max_lat &&
        area.max_lng === DEFAULT_AREA_BBOX.max_lng
    );
}

/**
 * Clamp a bbox to valid WGS-84 ranges before sending to the backend.
 * Leaflet allows wrapping the world horizontally, so the visible map
 * viewport can return longitudes outside [-180, 180]. The backend
 * enforces those ranges and returns 422 — clamp on the client so a
 * world-wide pan still produces a usable, accepted query.
 */
export function clampArea<T extends { min_lat: number; min_lng: number; max_lat: number; max_lng: number }>(
    area: T,
): T {
    const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
    return {
        ...area,
        min_lat: clamp(area.min_lat, -90, 90),
        max_lat: clamp(area.max_lat, -90, 90),
        min_lng: clamp(area.min_lng, -180, 180),
        max_lng: clamp(area.max_lng, -180, 180),
    };
}

/**
 * An area/profile geography counts as "WIDE" once its bounding-box diagonal
 * exceeds this many kilometres (interest-profiles PRD §11c). Used to decide
 * when to surface the spam-risk warning for area-mode profiles that also
 * include (or default to) the "local" reach tag.
 */
export const WIDE_AREA_THRESHOLD_KM = 150;

/** Great-circle distance between two lat/lng points, in kilometres. */
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * True when the given bbox's diagonal (min corner to max corner) exceeds
 * {@link WIDE_AREA_THRESHOLD_KM}. Used for area-mode interest profiles.
 */
export function isWideArea(area: { min_lat: number; min_lng: number; max_lat: number; max_lng: number }): boolean {
    const diagonalKm = haversineKm(area.min_lat, area.min_lng, area.max_lat, area.max_lng);
    return diagonalKm > WIDE_AREA_THRESHOLD_KM;
}
