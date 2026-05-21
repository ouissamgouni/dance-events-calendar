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
    min_lat: 20,
    min_lng: -25,
    max_lat: 71,
    max_lng: 60,
    label: 'Europe & nearby',
};

export const DEFAULT_AREA_LABEL = DEFAULT_AREA_BBOX.label;

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
