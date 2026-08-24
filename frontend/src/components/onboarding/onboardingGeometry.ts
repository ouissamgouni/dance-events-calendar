import type { HomeLocationPayload, PreferredAreaPayload } from '../../api';
import { clampArea } from '../../constants/area';

export interface CityRadiusValue {
    location: HomeLocationPayload;
    radiusKm: number;
}

export function cityRadiusArea(value: CityRadiusValue): PreferredAreaPayload {
    return bboxFromPinRadius(
        value.location,
        value.radiusKm,
        `${value.location.label.split(',')[0]} · ${value.radiusKm} km`,
    );
}

export function bboxFromPinRadius(pin: { lat: number; lng: number }, radiusKm: number, label: string): PreferredAreaPayload {
    const latitudeRadians = (pin.lat * Math.PI) / 180;
    const latitudeDelta = radiusKm / 111;
    const longitudeDelta = radiusKm / (111 * Math.max(0.1, Math.cos(latitudeRadians)));
    return clampArea({
        label,
        min_lat: pin.lat - latitudeDelta,
        min_lng: pin.lng - longitudeDelta,
        max_lat: pin.lat + latitudeDelta,
        max_lng: pin.lng + longitudeDelta,
    });
}

export function areaSideLengthsKm(area: PreferredAreaPayload): { horizontal: number; vertical: number } {
    const centerLat = (area.min_lat + area.max_lat) / 2;
    const centerLng = (area.min_lng + area.max_lng) / 2;
    return {
        horizontal: haversineKm(centerLat, area.min_lng, centerLat, area.max_lng),
        vertical: haversineKm(area.min_lat, centerLng, area.max_lat, centerLng),
    };
}

export function hasMinimumAreaCoverage(area: PreferredAreaPayload, minimumSideKm: number): boolean {
    const sides = areaSideLengthsKm(area);
    return sides.horizontal >= minimumSideKm && sides.vertical >= minimumSideKm;
}

export function hasMeaningfulAreaChange(
    initial: PreferredAreaPayload,
    current: PreferredAreaPayload,
    toleranceRatio = 0.02,
): boolean {
    const latitudeTolerance = Math.max(0.01, (initial.max_lat - initial.min_lat) * toleranceRatio);
    const longitudeTolerance = Math.max(0.01, (initial.max_lng - initial.min_lng) * toleranceRatio);
    return (
        Math.abs(current.min_lat - initial.min_lat) > latitudeTolerance
        || Math.abs(current.max_lat - initial.max_lat) > latitudeTolerance
        || Math.abs(current.min_lng - initial.min_lng) > longitudeTolerance
        || Math.abs(current.max_lng - initial.max_lng) > longitudeTolerance
    );
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const earthRadiusKm = 6371;
    const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
    const latitudeDelta = toRadians(lat2 - lat1);
    const longitudeDelta = toRadians(lng2 - lng1);
    const a = (
        Math.sin(latitudeDelta / 2) ** 2
        + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(longitudeDelta / 2) ** 2
    );
    return 2 * earthRadiusKm * Math.asin(Math.min(1, Math.sqrt(a)));
}
