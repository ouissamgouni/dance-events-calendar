import { describe, expect, it } from 'vitest';
import { searchAreaFromUrlParams, similarEventsExplorerUrl } from './similarEventsLink';
import type { SimilarEvents } from '../types';

const base: SimilarEvents = {
    event_ids: ['a'],
    style_tag_ids: [3, 7],
    reach_filter: 'regional_plus',
    area: {
        label: 'Lyon',
        min_lat: 44,
        min_lng: 3,
        max_lat: 47,
        max_lng: 6,
        center_lat: 45.764,
        center_lng: 4.8357,
        radius_km: 150,
    },
};

describe('similarEventsExplorerUrl', () => {
    it('round-trips a radius area with styles and reach', () => {
        const url = similarEventsExplorerUrl(base);
        const params = new URL(url, 'https://x.test').searchParams;
        expect(url.startsWith('/browse?')).toBe(true);
        expect(params.get('tag_ids')).toBe('3,7');
        expect(params.get('reach')).toBe('regional_plus');
        const area = searchAreaFromUrlParams(params);
        expect(area).toMatchObject({ kind: 'radius', radius_km: 150, center_lat: 45.764, placeName: 'Lyon' });
    });

    it('falls back to a bbox area and omits the reach filter for local events', () => {
        const url = similarEventsExplorerUrl({
            ...base,
            reach_filter: 'any',
            area: { ...base.area!, center_lat: null, center_lng: null, radius_km: null, label: 'Europe' },
        });
        const params = new URL(url, 'https://x.test').searchParams;
        expect(params.has('reach')).toBe(false);
        expect(searchAreaFromUrlParams(params)).toMatchObject({ kind: 'bbox', label: 'Europe', min_lat: 44, max_lng: 6 });
    });

    it('ignores incomplete area params', () => {
        expect(searchAreaFromUrlParams(new URLSearchParams('area_lat=1&area_lng=2'))).toBeNull();
    });
});
