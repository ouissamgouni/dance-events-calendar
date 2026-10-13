import { describe, expect, it } from 'vitest';
import type { GeocodeSuggestion } from '../api';
import { attributedProvider, NO_PLACE, placeFromSuggestion } from './placeFields';

const base: GeocodeSuggestion = { display_name: 'Berlin, Germany', latitude: 52.52, longitude: 13.4 };

describe('placeFromSuggestion', () => {
    it('keeps the venue name only for points of interest', () => {
        expect(placeFromSuggestion({ ...base, name: 'Havana Club', place_kind: 'poi', provider: 'geoapify', place_id: 'g1' }))
            .toMatchObject({ venue_name: 'Havana Club', place_provider: 'geoapify', place_id: 'g1' });
        expect(placeFromSuggestion({ ...base, name: 'Berlin', place_kind: 'city', city: 'Berlin' }))
            .toEqual({ ...NO_PLACE, city: 'Berlin' });
    });
});

describe('attributedProvider', () => {
    it('credits the provider of the visible results, never known venues', () => {
        expect(attributedProvider([{ ...base, source: 'known', provider: 'geoapify' }])).toBeNull();
        expect(attributedProvider([{ ...base, provider: 'photon' }])).toBe('photon');
        expect(attributedProvider([{ ...base, provider: 'photon' }, { ...base, provider: 'geoapify' }])).toBe('geoapify');
    });
});
