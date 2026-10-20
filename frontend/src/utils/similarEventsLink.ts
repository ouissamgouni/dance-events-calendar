import type { SimilarEvents } from '../types';
import { bboxSearchArea, radiusSearchArea, type SearchArea } from './searchArea';

export const AREA_URL_PARAMS = [
    'area_lat', 'area_lng', 'area_radius_km',
    'area_min_lat', 'area_min_lng', 'area_max_lat', 'area_max_lng',
    'area_label',
] as const;

/** Explorer (/browse) link pre-filtered like a similar-events result. */
export function similarEventsExplorerUrl(similar: SimilarEvents): string {
    const params = new URLSearchParams();
    if (similar.style_tag_ids.length) params.set('tag_ids', similar.style_tag_ids.join(','));
    if (similar.reach_filter !== 'any') params.set('reach', similar.reach_filter);
    const area = similar.area;
    if (area) {
        if (area.radius_km != null && area.center_lat != null && area.center_lng != null) {
            params.set('area_lat', area.center_lat.toFixed(5));
            params.set('area_lng', area.center_lng.toFixed(5));
            params.set('area_radius_km', String(Math.round(area.radius_km)));
        } else {
            params.set('area_min_lat', area.min_lat.toFixed(5));
            params.set('area_min_lng', area.min_lng.toFixed(5));
            params.set('area_max_lat', area.max_lat.toFixed(5));
            params.set('area_max_lng', area.max_lng.toFixed(5));
        }
        if (area.label) params.set('area_label', area.label);
    }
    return `/browse?${params.toString()}`;
}

function finite(params: URLSearchParams, key: string): number | null {
    const raw = params.get(key);
    if (raw == null || raw.trim() === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
}

/** Reads the `area_*` params written by {@link similarEventsExplorerUrl}. */
export function searchAreaFromUrlParams(params: URLSearchParams): SearchArea | null {
    const label = params.get('area_label')?.trim() || 'Selected area';
    const lat = finite(params, 'area_lat');
    const lng = finite(params, 'area_lng');
    const radius = finite(params, 'area_radius_km');
    if (lat != null && lng != null && radius != null && radius > 0) {
        return radiusSearchArea(label, { lat, lng }, radius, 'preset');
    }
    const minLat = finite(params, 'area_min_lat');
    const minLng = finite(params, 'area_min_lng');
    const maxLat = finite(params, 'area_max_lat');
    const maxLng = finite(params, 'area_max_lng');
    if (minLat == null || minLng == null || maxLat == null || maxLng == null) return null;
    if (minLat >= maxLat || minLng >= maxLng) return null;
    return bboxSearchArea(
        { label, min_lat: minLat, min_lng: minLng, max_lat: maxLat, max_lng: maxLng },
        'preset',
    );
}
