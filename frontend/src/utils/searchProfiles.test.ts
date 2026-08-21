import { describe, it, expect } from 'vitest';
import type { InterestProfile } from '../api';
import type { TagGroup } from '../types';
import {
    bboxApproxEquals,
    matchSearchProfile,
    sameIdSet,
    summarizeSearchProfile,
    summarizeSelection,
} from './searchProfiles';

function makeProfile(overrides: Partial<InterestProfile> = {}): InterestProfile {
    return {
        id: 1,
        label: 'Barcelona area',
        min_lat: 41,
        min_lng: 2,
        max_lat: 42,
        max_lng: 3,
        dance_tag_ids: [10, 11],
        reach_tag_ids: [20],
        matches_enabled: false,
        notify_enabled: false,
        is_active: false,
        created_at: '2024-01-01T00:00:00Z',
        ...overrides,
    };
}

const danceGroup: TagGroup = {
    id: 1,
    slug: 'dance-style',
    label: 'Dance styles',
    tags: [
        { id: 10, slug: 'salsa', label: 'Salsa' },
        { id: 11, slug: 'bachata', label: 'Bachata' },
        { id: 12, slug: 'kizomba', label: 'Kizomba' },
    ],
} as TagGroup;

const reachGroup: TagGroup = {
    id: 2,
    slug: 'reach',
    label: 'Reach',
    tags: [
        { id: 20, slug: 'international', label: 'International' },
        { id: 21, slug: 'local', label: 'Local' },
    ],
} as TagGroup;

describe('bboxApproxEquals', () => {
    it('returns true within epsilon', () => {
        const a = { min_lat: 41, min_lng: 2, max_lat: 42, max_lng: 3 };
        const b = { min_lat: 41.00005, min_lng: 2.00005, max_lat: 42, max_lng: 3 };
        expect(bboxApproxEquals(a, b)).toBe(true);
    });

    it('returns false outside epsilon', () => {
        const a = { min_lat: 41, min_lng: 2, max_lat: 42, max_lng: 3 };
        const b = { min_lat: 41.5, min_lng: 2, max_lat: 42, max_lng: 3 };
        expect(bboxApproxEquals(a, b)).toBe(false);
    });

    it('returns false when either side is null', () => {
        expect(bboxApproxEquals(null, { min_lat: 0, min_lng: 0, max_lat: 1, max_lng: 1 })).toBe(false);
        expect(bboxApproxEquals({ min_lat: 0, min_lng: 0, max_lat: 1, max_lng: 1 }, null)).toBe(false);
    });
});

describe('sameIdSet', () => {
    it('is order-independent', () => {
        expect(sameIdSet([1, 2, 3], [3, 2, 1])).toBe(true);
    });
    it('detects differing lengths', () => {
        expect(sameIdSet([1, 2], [1, 2, 3])).toBe(false);
    });
    it('detects differing members', () => {
        expect(sameIdSet([1, 2], [1, 3])).toBe(false);
    });
    it('treats two empty sets as equal', () => {
        expect(sameIdSet([], [])).toBe(true);
    });
});

describe('matchSearchProfile', () => {
    const profiles = [makeProfile({ id: 1 }), makeProfile({ id: 2, label: 'Other', dance_tag_ids: [12], reach_tag_ids: [21] })];

    it('matches an exact Area + Dance + Reach selection', () => {
        const match = matchSearchProfile(
            { area: { min_lat: 41, min_lng: 2, max_lat: 42, max_lng: 3 }, danceIds: [11, 10], reachIds: [20] },
            profiles,
        );
        expect(match?.id).toBe(1);
    });

    it('returns null (Custom) when the area is null', () => {
        expect(matchSearchProfile({ area: null, danceIds: [10, 11], reachIds: [20] }, profiles)).toBeNull();
    });

    it('returns null (Custom) when dance tags differ', () => {
        expect(
            matchSearchProfile(
                { area: { min_lat: 41, min_lng: 2, max_lat: 42, max_lng: 3 }, danceIds: [10], reachIds: [20] },
                profiles,
            ),
        ).toBeNull();
    });

    it('returns null when profiles list is null', () => {
        expect(matchSearchProfile({ area: { min_lat: 41, min_lng: 2, max_lat: 42, max_lng: 3 }, danceIds: [10, 11], reachIds: [20] }, null)).toBeNull();
    });

    it('re-matches after the selection returns to a saved combination', () => {
        const current = { area: { min_lat: 41, min_lng: 2, max_lat: 42, max_lng: 3 }, danceIds: [10, 11], reachIds: [20] };
        expect(matchSearchProfile(current, profiles)?.id).toBe(1);
        const changed = { ...current, danceIds: [10] };
        expect(matchSearchProfile(changed, profiles)).toBeNull();
        expect(matchSearchProfile(current, profiles)?.id).toBe(1);
    });

    it('returns the first profile on a tie (created order)', () => {
        const dupes = [makeProfile({ id: 1 }), makeProfile({ id: 2 })];
        const match = matchSearchProfile(
            { area: { min_lat: 41, min_lng: 2, max_lat: 42, max_lng: 3 }, danceIds: [10, 11], reachIds: [20] },
            dupes,
        );
        expect(match?.id).toBe(1);
    });
});

describe('summarizeSearchProfile', () => {
    it('condenses multiple dance tags and joins reach labels', () => {
        expect(summarizeSearchProfile(makeProfile(), danceGroup, reachGroup)).toBe('Barcelona area · Salsa +1 · International');
    });

    it('falls back to Any style / Any scale when empty', () => {
        expect(summarizeSearchProfile(makeProfile({ dance_tag_ids: [], reach_tag_ids: [] }), danceGroup, reachGroup)).toBe(
            'Barcelona area · Any style · Any scale',
        );
    });
});

describe('summarizeSelection', () => {
    it('uses the supplied area label', () => {
        expect(
            summarizeSelection({ area: null, danceIds: [10], reachIds: [20, 21] }, 'Anywhere', danceGroup, reachGroup),
        ).toBe('Anywhere · Salsa · International/Local');
    });
});
