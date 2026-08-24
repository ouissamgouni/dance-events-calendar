import { describe, expect, it } from 'vitest';
import {
    areaSideLengthsKm,
    bboxFromPinRadius,
    hasMeaningfulAreaChange,
    hasMinimumAreaCoverage,
} from './onboardingGeometry';

describe('bboxFromPinRadius', () => {
    it('creates a valid bbox centered on the selected location', () => {
        const area = bboxFromPinRadius({ lat: 48.8566, lng: 2.3522 }, 25, 'Paris, France');

        expect(area.label).toBe('Paris, France');
        expect((area.min_lat + area.max_lat) / 2).toBeCloseTo(48.8566, 5);
        expect((area.min_lng + area.max_lng) / 2).toBeCloseTo(2.3522, 5);
        expect(area.min_lat).toBeLessThan(area.max_lat);
        expect(area.min_lng).toBeLessThan(area.max_lng);
    });
});

describe('international area geometry', () => {
    const europe = { label: 'Europe', min_lat: 20, min_lng: -10, max_lat: 65, max_lng: 40 };

    it('measures geographic side lengths and enforces the international minimum', () => {
        const sides = areaSideLengthsKm(europe);
        expect(sides.horizontal).toBeGreaterThan(3500);
        expect(sides.vertical).toBeGreaterThan(4500);
        expect(hasMinimumAreaCoverage(europe, 1000)).toBe(true);
        expect(hasMinimumAreaCoverage({ label: 'City', min_lat: 48, min_lng: 2, max_lat: 49, max_lng: 3 }, 1000)).toBe(false);
    });

    it('ignores tiny preset movement but detects a meaningful change', () => {
        expect(hasMeaningfulAreaChange(europe, { ...europe, min_lat: 20.5 })).toBe(false);
        expect(hasMeaningfulAreaChange(europe, { ...europe, min_lat: 22 })).toBe(true);
    });
});
