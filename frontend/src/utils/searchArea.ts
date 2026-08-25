import type {
    GeocodeSuggestion,
    InterestProfile,
    InterestProfilePayload,
    PreferredAreaPayload,
} from '../api';
import { clampArea, type AreaBbox } from '../constants/area';

export const DEFAULT_RADIUS_KM = 25;

export type SearchAreaSource = 'preset' | 'profile' | 'place' | 'custom' | 'preference';

interface SearchAreaBase {
    label: string;
    min_lat: number;
    min_lng: number;
    max_lat: number;
    max_lng: number;
    source: SearchAreaSource;
}

export interface BboxSearchArea extends SearchAreaBase {
    kind: 'bbox';
}

export interface RadiusSearchArea extends SearchAreaBase {
    kind: 'radius';
    placeName: string;
    center_lat: number;
    center_lng: number;
    radius_km: number;
}

export type SearchArea = BboxSearchArea | RadiusSearchArea;

const LARGE_GEOGRAPHY_KINDS = new Set(['country', 'region', 'county']);

export function radiusAreaLabel(placeName: string, radiusKm: number): string {
    return `${placeName} · ${radiusKm} km`;
}

export function radiusBounds(
    center: { lat: number; lng: number },
    radiusKm: number,
): Pick<SearchAreaBase, 'min_lat' | 'min_lng' | 'max_lat' | 'max_lng'> {
    const latitudeRadians = center.lat * Math.PI / 180;
    const latitudeDelta = radiusKm / 111;
    const longitudeDelta = radiusKm / (111 * Math.max(0.1, Math.cos(latitudeRadians)));
    return clampArea({
        min_lat: center.lat - latitudeDelta,
        min_lng: center.lng - longitudeDelta,
        max_lat: center.lat + latitudeDelta,
        max_lng: center.lng + longitudeDelta,
    });
}

function latitudeToMercator(latitude: number): number {
    const bounded = Math.max(-85.05112878, Math.min(85.05112878, latitude));
    const radians = bounded * Math.PI / 180;
    return Math.log(Math.tan(Math.PI / 4 + radians / 2));
}

function mercatorToLatitude(value: number): number {
    return (2 * Math.atan(Math.exp(value)) - Math.PI / 2) * 180 / Math.PI;
}

export function squareBoundsContaining(
    bounds: Pick<SearchAreaBase, 'min_lat' | 'min_lng' | 'max_lat' | 'max_lng'>,
): Pick<SearchAreaBase, 'min_lat' | 'min_lng' | 'max_lat' | 'max_lng'> {
    const west = bounds.min_lng * Math.PI / 180;
    const east = bounds.max_lng * Math.PI / 180;
    const south = latitudeToMercator(bounds.min_lat);
    const north = latitudeToMercator(bounds.max_lat);
    const side = Math.max(east - west, north - south);
    const centerX = (west + east) / 2;
    const centerY = (south + north) / 2;
    return clampArea({
        min_lat: Math.min(bounds.min_lat, mercatorToLatitude(centerY - side / 2)),
        min_lng: Math.min(bounds.min_lng, (centerX - side / 2) * 180 / Math.PI),
        max_lat: Math.max(bounds.max_lat, mercatorToLatitude(centerY + side / 2)),
        max_lng: Math.max(bounds.max_lng, (centerX + side / 2) * 180 / Math.PI),
    });
}

export function bboxSearchArea(
    area: PreferredAreaPayload | AreaBbox,
    source: SearchAreaSource = 'custom',
): BboxSearchArea {
    return { kind: 'bbox', source, ...clampArea(area) };
}

export function radiusSearchArea(
    placeName: string,
    center: { lat: number; lng: number },
    radiusKm = DEFAULT_RADIUS_KM,
    source: SearchAreaSource = 'place',
): RadiusSearchArea {
    return {
        kind: 'radius',
        source,
        placeName,
        center_lat: center.lat,
        center_lng: center.lng,
        radius_km: radiusKm,
        label: radiusAreaLabel(placeName, radiusKm),
        ...radiusBounds(center, radiusKm),
    };
}

export function searchAreaFromSuggestion(suggestion: GeocodeSuggestion): SearchArea {
    const placeName = suggestion.name?.trim() || suggestion.display_name;
    if (suggestion.place_kind && LARGE_GEOGRAPHY_KINDS.has(suggestion.place_kind)) {
        const sourceBounds = suggestion.bounding_box ?? radiusBounds(
            { lat: suggestion.latitude, lng: suggestion.longitude },
            100,
        );
        return bboxSearchArea({ label: placeName, ...squareBoundsContaining(sourceBounds) }, 'place');
    }
    return radiusSearchArea(
        placeName,
        { lat: suggestion.latitude, lng: suggestion.longitude },
    );
}

export function radiusPlaceName(areaLabel: string, radiusKm: number): string {
    const suffix = ` · ${radiusKm} km`;
    return areaLabel.endsWith(suffix) ? areaLabel.slice(0, -suffix.length) : areaLabel;
}

export function searchAreaFromProfile(profile: InterestProfile): SearchArea {
    if (
        profile.geo_kind === 'radius'
        && profile.center_lat != null
        && profile.center_lng != null
        && profile.radius_km != null
    ) {
        return radiusSearchArea(
            radiusPlaceName(profile.area_label, profile.radius_km),
            { lat: profile.center_lat, lng: profile.center_lng },
            profile.radius_km,
            'profile',
        );
    }
    return bboxSearchArea({
        label: profile.area_label,
        min_lat: profile.min_lat,
        min_lng: profile.min_lng,
        max_lat: profile.max_lat,
        max_lng: profile.max_lng,
    }, 'profile');
}

export function withRadiusKm(area: RadiusSearchArea, radiusKm: number): RadiusSearchArea {
    return radiusSearchArea(
        area.placeName,
        { lat: area.center_lat, lng: area.center_lng },
        radiusKm,
        area.source,
    );
}

export function radiusToCustomBbox(area: RadiusSearchArea): BboxSearchArea {
    return bboxSearchArea({ label: 'Custom area', ...squareBoundsContaining(area) }, 'custom');
}

export function customAreaFromBounds(
    bounds: Pick<SearchAreaBase, 'min_lat' | 'min_lng' | 'max_lat' | 'max_lng'>,
): BboxSearchArea {
    return bboxSearchArea({ label: 'Custom area', ...squareBoundsContaining(bounds) }, 'custom');
}

export function toPreferredArea(area: SearchArea): PreferredAreaPayload {
    return {
        label: area.label,
        min_lat: area.min_lat,
        min_lng: area.min_lng,
        max_lat: area.max_lat,
        max_lng: area.max_lng,
    };
}

export function toProfileGeometry(area: SearchArea): Pick<
    InterestProfilePayload,
    'area_label' | 'geo_kind' | 'min_lat' | 'min_lng' | 'max_lat' | 'max_lng' | 'center_lat' | 'center_lng' | 'radius_km'
> {
    return {
        area_label: area.label,
        geo_kind: area.kind === 'bbox' ? 'area' : 'radius',
        min_lat: area.min_lat,
        min_lng: area.min_lng,
        max_lat: area.max_lat,
        max_lng: area.max_lng,
        center_lat: area.kind === 'radius' ? area.center_lat : null,
        center_lng: area.kind === 'radius' ? area.center_lng : null,
        radius_km: area.kind === 'radius' ? area.radius_km : null,
    };
}

export function searchAreasEqual(a: SearchArea, b: SearchArea, epsilon = 1e-4): boolean {
    if (a.kind !== b.kind) return false;
    const bboxMatches = (
        Math.abs(a.min_lat - b.min_lat) <= epsilon
        && Math.abs(a.min_lng - b.min_lng) <= epsilon
        && Math.abs(a.max_lat - b.max_lat) <= epsilon
        && Math.abs(a.max_lng - b.max_lng) <= epsilon
    );
    if (!bboxMatches || a.kind === 'bbox' || b.kind === 'bbox') return bboxMatches;
    return (
        Math.abs(a.center_lat - b.center_lat) <= epsilon
        && Math.abs(a.center_lng - b.center_lng) <= epsilon
        && Math.abs(a.radius_km - b.radius_km) <= epsilon
    );
}

export function searchAreaContainsCoordinates(
    area: SearchArea,
    latitude: number | null | undefined,
    longitude: number | null | undefined,
): boolean {
    if (latitude == null || longitude == null) return true;
    if (
        latitude < area.min_lat || latitude > area.max_lat
        || longitude < area.min_lng || longitude > area.max_lng
    ) return false;
    if (area.kind === 'bbox') return true;
    const earthRadiusKm = 6371;
    const toRadians = (degrees: number) => degrees * Math.PI / 180;
    const latitudeDelta = toRadians(latitude - area.center_lat);
    const longitudeDelta = toRadians(longitude - area.center_lng);
    const startLatitude = toRadians(area.center_lat);
    const endLatitude = toRadians(latitude);
    const haversine = Math.sin(latitudeDelta / 2) ** 2
        + Math.cos(startLatitude) * Math.cos(endLatitude) * Math.sin(longitudeDelta / 2) ** 2;
    const distanceKm = earthRadiusKm * 2 * Math.asin(Math.min(1, Math.sqrt(haversine)));
    return distanceKm <= area.radius_km;
}
