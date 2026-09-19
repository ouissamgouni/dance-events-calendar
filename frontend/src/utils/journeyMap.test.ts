import { describe, expect, it } from 'vitest';
import { journeyBounds, journeyProjector } from './journeyMap';

describe('journeyBounds', () => {
    it('uses a stable world view when no attended coordinates exist', () => {
        expect(journeyBounds([])).toEqual({
            minLng: -180,
            maxLng: 180,
            minLat: -60,
            maxLat: 85,
        });
    });

    it('pads a single location enough to avoid over-zooming', () => {
        const bounds = journeyBounds([{ lat: 48.8566, lng: 2.3522 }]);

        expect(bounds.maxLat - bounds.minLat).toBeCloseTo(9.6);
        expect(bounds.maxLng - bounds.minLng).toBeCloseTo(9.6);
    });

    it('projects attended locations inside the requested frame', () => {
        const coords = [
            { lat: 48.8566, lng: 2.3522 },
            { lat: 40.4168, lng: -3.7038 },
        ];
        const bounds = journeyBounds(coords);
        const project = journeyProjector(bounds, 320, 140);

        for (const coordinate of coords) {
            const point = project(coordinate.lat, coordinate.lng);
            expect(point.x).toBeGreaterThanOrEqual(0);
            expect(point.x).toBeLessThanOrEqual(320);
            expect(point.y).toBeGreaterThanOrEqual(0);
            expect(point.y).toBeLessThanOrEqual(140);
        }
    });
});
