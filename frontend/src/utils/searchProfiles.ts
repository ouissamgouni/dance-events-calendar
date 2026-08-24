import type { InterestProfile, ReachFilter } from '../api';
import type { TagGroup } from '../types';
import { REACH_FILTER_LABELS } from './reach';

// Bounding boxes are floats round-tripped through the server; compare with a
// small epsilon so a re-applied profile still matches its stored bbox.
const BBOX_EPS = 1e-4;

export interface SearchProfileArea {
    min_lat: number;
    min_lng: number;
    max_lat: number;
    max_lng: number;
}

export function bboxApproxEquals(
    a: SearchProfileArea | null | undefined,
    b: SearchProfileArea | null | undefined,
    eps = BBOX_EPS,
): boolean {
    if (!a || !b) return false;
    return (
        Math.abs(a.min_lat - b.min_lat) <= eps &&
        Math.abs(a.min_lng - b.min_lng) <= eps &&
        Math.abs(a.max_lat - b.max_lat) <= eps &&
        Math.abs(a.max_lng - b.max_lng) <= eps
    );
}

export function sameIdSet(a: number[], b: number[]): boolean {
    if (a.length !== b.length) return false;
    const set = new Set(a);
    return b.every((id) => set.has(id));
}

export function profileContainsCoordinates(
    profile: InterestProfile,
    latitude: number | null | undefined,
    longitude: number | null | undefined,
): boolean {
    if (latitude == null || longitude == null) return true;
    if (
        latitude < profile.min_lat || latitude > profile.max_lat ||
        longitude < profile.min_lng || longitude > profile.max_lng
    ) return false;
    if (profile.geo_kind !== 'radius') return true;
    if (profile.center_lat == null || profile.center_lng == null || profile.radius_km == null) return false;
    const earthRadiusKm = 6371;
    const latitudeDelta = (latitude - profile.center_lat) * Math.PI / 180;
    const longitudeDelta = (longitude - profile.center_lng) * Math.PI / 180;
    const startLatitude = profile.center_lat * Math.PI / 180;
    const endLatitude = latitude * Math.PI / 180;
    const haversine = Math.sin(latitudeDelta / 2) ** 2
        + Math.cos(startLatitude) * Math.cos(endLatitude) * Math.sin(longitudeDelta / 2) ** 2;
    const distanceKm = earthRadiusKm * 2 * Math.asin(Math.min(1, Math.sqrt(haversine)));
    return distanceKm <= profile.radius_km;
}

export interface CurrentSearchSelection {
    /** Current effective area bbox, or ``null`` when browsing worldwide. */
    area: SearchProfileArea | null;
    danceIds: number[];
    reachFilter: ReachFilter;
    /** Legacy picker state retained during the profile-flow transition. */
    reachIds: number[];
}

/**
 * Find the saved profile whose Area + Dance + Reach exactly match the current
 * search selection, or ``null`` when the combination is "Custom". On ties the
 * first profile (created order) wins.
 */
export function matchSearchProfile(
    current: CurrentSearchSelection,
    profiles: InterestProfile[] | null | undefined,
): InterestProfile | null {
    if (!profiles || current.area == null) return null;
    for (const profile of profiles) {
        if (
            bboxApproxEquals(current.area, profile) &&
            sameIdSet(current.danceIds, profile.dance_tag_ids) &&
            current.reachFilter === profile.reach_filter
        ) {
            return profile;
        }
    }
    return null;
}

function tagLabels(ids: number[], group: TagGroup | null | undefined): string[] {
    if (!group) return [];
    const byId = new Map(group.tags.map((t) => [t.id, t.label]));
    return ids.map((id) => byId.get(id)).filter((l): l is string => !!l);
}

function condense(labels: string[], emptyLabel: string): string {
    if (labels.length === 0) return emptyLabel;
    if (labels.length === 1) return labels[0];
    return `${labels[0]} +${labels.length - 1}`;
}

/** "Barcelona area · Salsa +2 · International" one-line summary for a profile. */
export function summarizeSearchProfile(
    profile: Pick<InterestProfile, 'label' | 'dance_tag_ids' | 'reach_filter'>,
    danceGroup: TagGroup | null | undefined,
    _reachGroup: TagGroup | null | undefined,
): string {
    return [
        profile.label,
        condense(tagLabels(profile.dance_tag_ids, danceGroup), 'Any style'),
        REACH_FILTER_LABELS[profile.reach_filter],
    ].join(' · ');
}

/** Same, but for a raw current selection (uses the supplied area label). */
export function summarizeSelection(
    current: CurrentSearchSelection,
    areaLabel: string,
    danceGroup: TagGroup | null | undefined,
    _reachGroup: TagGroup | null | undefined,
): string {
    return [
        areaLabel,
        condense(tagLabels(current.danceIds, danceGroup), 'Any style'),
        REACH_FILTER_LABELS[current.reachFilter],
    ].join(' · ');
}
