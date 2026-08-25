import { describe, expect, it } from 'vitest';
import type { GeocodeSuggestion, InterestProfile } from '../api';
import {
    radiusSearchArea,
    radiusToCustomBbox,
    searchAreaContainsCoordinates,
    searchAreaFromProfile,
    searchAreaFromSuggestion,
    squareBoundsContaining,
    toProfileGeometry,
    withRadiusKm,
} from './searchArea';

const baseSuggestion: GeocodeSuggestion = {
    display_name: 'Paris, Ile-de-France, France',
    latitude: 48.8566,
    longitude: 2.3522,
    name: 'Paris',
    context: 'Ile-de-France, France',
    country: 'France',
    region: 'Ile-de-France',
    place_kind: 'city',
    type_label: 'City',
    bounding_box: { min_lat: 48.815, min_lng: 2.224, max_lat: 48.902, max_lng: 2.47 },
};

function profile(overrides: Partial<InterestProfile> = {}): InterestProfile {
    return {
        id: 1,
        label: 'Near home',
        area_label: 'Paris · 25 km',
        geo_kind: 'radius',
        min_lat: 48.63,
        min_lng: 2.01,
        max_lat: 49.08,
        max_lng: 2.69,
        center_lat: 48.8566,
        center_lng: 2.3522,
        radius_km: 25,
        dance_tag_ids: [],
        reach_filter: 'any',
        reach_tag_ids: [],
        matches_enabled: false,
        notify_enabled: false,
        is_active: true,
        created_at: '2026-01-01T00:00:00Z',
        ...overrides,
    };
}

describe('search area inference', () => {
    it('infers a city as a radius even when Nominatim returns a bbox', () => {
        const area = searchAreaFromSuggestion(baseSuggestion);
        expect(area.kind).toBe('radius');
        expect(area.label).toBe('Paris · 25 km');
    });

    it('infers a country as a bbox and contains the complete returned extent', () => {
        const source = { min_lat: 41.263, min_lng: -5.453, max_lat: 51.269, max_lng: 9.868 };
        const area = searchAreaFromSuggestion({
            ...baseSuggestion,
            display_name: 'France',
            name: 'France',
            latitude: 46.6034,
            longitude: 1.8883,
            place_kind: 'country',
            type_label: 'Country',
            bounding_box: source,
        });
        expect(area.kind).toBe('bbox');
        expect(area.label).toBe('France');
        expect(area.min_lat).toBeLessThanOrEqual(source.min_lat);
        expect(area.min_lng).toBeLessThanOrEqual(source.min_lng);
        expect(area.max_lat).toBeGreaterThanOrEqual(source.max_lat);
        expect(area.max_lng).toBeGreaterThanOrEqual(source.max_lng);
    });

    it('defaults an unclear point-like result to radius', () => {
        const area = searchAreaFromSuggestion({ ...baseSuggestion, place_kind: 'unknown' });
        expect(area.kind).toBe('radius');
    });
});

describe('search area geometry', () => {
    it('expands the shorter projected dimension instead of cropping', () => {
        const source = { min_lat: 40, min_lng: -10, max_lat: 50, max_lng: 0 };
        const square = squareBoundsContaining(source);
        expect(square.min_lat).toBeLessThanOrEqual(source.min_lat);
        expect(square.min_lng).toBeLessThanOrEqual(source.min_lng);
        expect(square.max_lat).toBeGreaterThanOrEqual(source.max_lat);
        expect(square.max_lng).toBeGreaterThanOrEqual(source.max_lng);
    });

    it('preserves a saved radius representation and payload fields', () => {
        const area = searchAreaFromProfile(profile());
        expect(area.kind).toBe('radius');
        expect(area.label).toBe('Paris · 25 km');
        expect(toProfileGeometry(area)).toMatchObject({
            geo_kind: 'radius',
            center_lat: 48.8566,
            center_lng: 2.3522,
            radius_km: 25,
        });
    });

    it('updates the canonical label with distance changes', () => {
        const area = withRadiusKm(radiusSearchArea('Paris', { lat: 48.8566, lng: 2.3522 }), 50);
        expect(area.label).toBe('Paris · 50 km');
    });

    it('converts the radius escape hatch to a custom bbox', () => {
        const area = radiusToCustomBbox(radiusSearchArea('Paris', { lat: 48.8566, lng: 2.3522 }));
        expect(area).toMatchObject({ kind: 'bbox', label: 'Custom area', source: 'custom' });
    });

    it('excludes a point in a radius bounding-box corner', () => {
        const area = radiusSearchArea('Paris', { lat: 48.8566, lng: 2.3522 });
        expect(searchAreaContainsCoordinates(area, 48.8566, 2.5)).toBe(true);
        expect(searchAreaContainsCoordinates(area, area.max_lat, area.max_lng)).toBe(false);
    });
});
