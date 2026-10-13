import type { GeocodeSuggestion } from '../api';
import type { PlaceFields } from '../types';

export type Place = Required<PlaceFields>;

/** A hand-typed location: nothing structured to keep. */
export const NO_PLACE: Place = {
    venue_name: null,
    street_address: null,
    city: null,
    country: null,
    country_code: null,
    place_id: null,
    place_provider: null,
};

/** The structured place stored with a picked suggestion; only POIs carry a venue name. */
export function placeFromSuggestion(s: GeocodeSuggestion): Place {
    return {
        venue_name: s.place_kind === 'poi' || s.source === 'known' ? (s.name ?? null) : null,
        street_address: s.street_address ?? null,
        city: s.city ?? null,
        country: s.country ?? null,
        country_code: s.country_code ?? null,
        place_id: s.place_id ?? null,
        place_provider: s.provider ?? null,
    };
}

/** The place fields of a saved record, for prefilling an edit form. */
export function pickPlace(source: PlaceFields): Place {
    return {
        venue_name: source.venue_name ?? null,
        street_address: source.street_address ?? null,
        city: source.city ?? null,
        country: source.country ?? null,
        country_code: source.country_code ?? null,
        place_id: source.place_id ?? null,
        place_provider: source.place_provider ?? null,
    };
}

/** The provider whose results are on screen and must be credited. */
export function attributedProvider(results: GeocodeSuggestion[]): 'geoapify' | 'photon' | null {
    const providers = new Set(results.filter((s) => s.source !== 'known').map((s) => s.provider));
    if (providers.has('geoapify')) return 'geoapify';
    if (providers.has('photon')) return 'photon';
    return null;
}
