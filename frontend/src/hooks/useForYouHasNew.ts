import { useMemo } from 'react';
import type { CalendarEvent } from '../types';
import { useAuth } from '../context/AuthContext';
import { usePreferences } from '../context/PreferencesContext';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import { useForYouLens } from './useForYouLens';
import { useSeenEvents } from './useSeenEvents';
import { DEFAULT_AREA_BBOX } from '../constants/area';

function toApiDate(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function eventMatchesAnyTag(event: CalendarEvent, tagIds: number[]): boolean {
    if (tagIds.length === 0) return false;
    const tagSet = new Set((event.tags ?? []).map((tag) => tag.id));
    return tagIds.some((id) => tagSet.has(id));
}

// Peeks at the same "You might like" lens the /for-you page renders and
// returns true when any of those events are still unseen for the viewer.
// Skipped when the viewer is already on /for-you (that page runs its
// own full lens fetch) or when the unseen feature flag is off. Applies
// the exact same filter as the "New" trail on /for-you so the dot
// doesn't fire for events that would never appear in that trail.
export function useForYouHasNew(activeForYou: boolean): boolean {
    const { user } = useAuth();
    const { prefs } = usePreferences();
    const { unseenStateEnabled } = useFeatureFlags();
    const enabled = !!user && unseenStateEnabled && !activeForYou;
    const area = useMemo(() => {
        const src = prefs.area ?? DEFAULT_AREA_BBOX;
        return { min_lat: src.min_lat, min_lng: src.min_lng, max_lat: src.max_lat, max_lng: src.max_lng };
    }, [prefs.area]);
    const startDate = useMemo(() => toApiDate(new Date()), []);
    const resetKey = useMemo(() => JSON.stringify({ a: area, s: startDate, on: enabled }), [area, startDate, enabled]);
    const lens = useForYouLens({ enabled, fetchArgs: { startDate, area }, resetKey, serverBatchSize: 10 });
    // Pass the FULL fetched id list to useSeenEvents so the ``known`` baseline
    // and the resulting ``newEventIds`` scope matches what /for-you computes
    // for its "New" trail. Then intersect with the tag-preference / not-ended
    // filter that /for-you actually renders. This prevents the tab dot from
    // firing on events that would never appear in the "New" trail.
    const allIds = useMemo(() => lens.events.map((event) => event.event_id), [lens.events]);
    const { newEventIds } = useSeenEvents(allIds);
    const hasNew = useMemo(() => {
        // eslint-disable-next-line react-hooks/purity -- render-time clock snapshot for past-event filter
        const now = Date.now();
        return lens.events.some((event) => (
            newEventIds.has(event.event_id)
            && new Date(event.end).getTime() >= now
            && eventMatchesAnyTag(event, prefs.tagIds)
        ));
    }, [lens.events, newEventIds, prefs.tagIds]);
    return hasNew;
}
