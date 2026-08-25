export interface JourneyCoordinate {
    lat: number;
    lng: number;
}

export interface JourneyBounds {
    minLng: number;
    maxLng: number;
    minLat: number;
    maxLat: number;
}

const WORLD_BOUNDS: JourneyBounds = {
    minLng: -180,
    maxLng: 180,
    minLat: -60,
    maxLat: 85,
};

export function journeyBounds(coords: JourneyCoordinate[]): JourneyBounds {
    if (coords.length === 0) return WORLD_BOUNDS;

    const lats = coords.map((coordinate) => coordinate.lat);
    const lngs = coords.map((coordinate) => coordinate.lng);
    const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
    const midLng = (Math.min(...lngs) + Math.max(...lngs)) / 2;
    const latSpan = Math.max(Math.max(...lats) - Math.min(...lats), 6) * 1.6;
    const lngSpan = Math.max(Math.max(...lngs) - Math.min(...lngs), 6) * 1.6;
    return {
        minLat: Math.max(midLat - latSpan / 2, -84),
        maxLat: Math.min(midLat + latSpan / 2, 84),
        minLng: Math.max(midLng - lngSpan / 2, -180),
        maxLng: Math.min(midLng + lngSpan / 2, 180),
    };
}

export function journeyProjector(bounds: JourneyBounds, width: number, height: number) {
    const midLat = (bounds.minLat + bounds.maxLat) / 2;
    const cosLat = Math.max(Math.cos((midLat * Math.PI) / 180), 0.2);
    const projectedMinLng = bounds.minLng * cosLat;
    const projectedMinLat = -bounds.maxLat;
    const scale = Math.min(
        width / ((bounds.maxLng - bounds.minLng) * cosLat),
        height / (bounds.maxLat - bounds.minLat),
    );
    const offsetX = (width - (bounds.maxLng - bounds.minLng) * cosLat * scale) / 2;
    const offsetY = (height - (bounds.maxLat - bounds.minLat) * scale) / 2;

    return (lat: number, lng: number) => ({
        x: (lng * cosLat - projectedMinLng) * scale + offsetX,
        y: (-lat - projectedMinLat) * scale + offsetY,
    });
}

export function journeyRingIntersects(
    ring: [number, number][],
    bounds: JourneyBounds,
): boolean {
    let minLng = Infinity;
    let maxLng = -Infinity;
    let minLat = Infinity;
    let maxLat = -Infinity;
    for (const [lng, lat] of ring) {
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
    }
    return !(
        maxLng < bounds.minLng || minLng > bounds.maxLng ||
        maxLat < bounds.minLat || minLat > bounds.maxLat
    );
}
