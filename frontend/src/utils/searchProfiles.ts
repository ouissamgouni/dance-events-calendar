import type { InterestProfile, ReachFilter } from '../api';
import type { TagGroup } from '../types';
import { REACH_FILTER_LABELS } from './reach';
import {
    bboxSearchArea,
    searchAreaContainsCoordinates,
    searchAreaFromProfile,
    searchAreasEqual,
    type SearchArea,
} from './searchArea';

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
    return searchAreaContainsCoordinates(searchAreaFromProfile(profile), latitude, longitude);
}

export interface CurrentSearchSelection {
    /** Current effective geography, or ``null`` when browsing worldwide. */
    area: SearchArea | SearchProfileArea | null;
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
    const currentArea = 'kind' in current.area
        ? current.area
        : bboxSearchArea({ label: '', ...current.area });
    for (const profile of profiles) {
        if (
            searchAreasEqual(currentArea, searchAreaFromProfile(profile)) &&
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

export function generateProfileName({
    danceIds,
    danceGroup,
    areaLabel,
    reachFilter,
}: {
    danceIds: number[];
    danceGroup: TagGroup | null | undefined;
    areaLabel: string;
    reachFilter: InterestProfile['reach_filter'];
}): string {
    return [
        condense(tagLabels(danceIds, danceGroup), 'Any style'),
        areaLabel.trim() || 'Anywhere',
        REACH_FILTER_LABELS[reachFilter],
    ].join(' · ').slice(0, 120);
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
