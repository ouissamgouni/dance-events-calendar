import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchEventsPage, type PreferredAreaPayload } from '../api';
import { filterEventsByTags } from '../utils/tagFilter';
import { DEFAULT_AREA_BBOX } from '../constants/area';
import type { CalendarEvent, TagGroup } from '../types';

/** Worldwide footprint used to sample events for the preview map. The map
 * shows all sampled pins; the trail filters them to the chosen area. */
const WORLD_AREA = { min_lat: -55, min_lng: -170, max_lat: 75, max_lng: 170 } as const;
const WORLD_FETCH_LIMIT = 200;

function todayISODate(): string {
    return new Date().toISOString().slice(0, 10);
}

interface Params {
    danceGroup: TagGroup | null;
    reachGroup: TagGroup | null;
    danceIds: number[];
    reachIds: number[];
    area: PreferredAreaPayload | null;
    /** Gate the worldwide fetch (e.g. only when the editor is visible). */
    enabled: boolean;
}

/**
 * Shared live-event preview used by the onboarding area step and the profile
 * editors. One worldwide fetch per style/reach selection powers BOTH the map
 * pins (all matched events across the globe) and the trail (the same set
 * filtered to the chosen area client-side, no refetch). Mirrors the
 * Explorer's disjunctive faceting (OR within a group, AND across groups).
 */
export function useAreaEventPreview({ danceGroup, reachGroup, danceIds, reachIds, area, enabled }: Params) {
    const [previewEvents, setPreviewEvents] = useState<CalendarEvent[] | null>(null);
    const previewReqRef = useRef(0);
    const previewTagKey = [...danceIds, ...reachIds].join(',');

    useEffect(() => {
        if (!enabled) return;
        const reqId = ++previewReqRef.current;
        const timer = window.setTimeout(() => {
            if (danceIds.length === 0) {
                setPreviewEvents(null);
                return;
            }
            fetchEventsPage({
                startDate: todayISODate(),
                area: WORLD_AREA,
                limit: WORLD_FETCH_LIMIT,
            })
                .then((page) => {
                    if (reqId !== previewReqRef.current) return;
                    const groups = [danceGroup, reachGroup].filter((g): g is TagGroup => g != null);
                    const activeIds = new Set<number>([...danceIds, ...reachIds]);
                    setPreviewEvents(filterEventsByTags(page.events, activeIds, groups));
                })
                .catch(() => {
                    if (reqId !== previewReqRef.current) return;
                    setPreviewEvents([]);
                });
        }, 400);
        return () => window.clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch on tag selection / enablement change only.
    }, [previewTagKey, enabled]);

    // Worldwide pins for the map (matched events that carry coordinates).
    const previewMarkers = useMemo(
        () => (previewEvents ?? [])
            .filter((e): e is CalendarEvent & { latitude: number; longitude: number } =>
                e.latitude != null && e.longitude != null)
            .map((e) => ({ id: e.event_id, lat: e.latitude, lng: e.longitude })),
        [previewEvents],
    );

    // Trail = matched events whose coordinates fall inside the chosen area.
    const areaTrail = useMemo(() => {
        const evs = previewEvents ?? [];
        const a = area ?? DEFAULT_AREA_BBOX;
        return evs.filter((e) =>
            e.latitude != null && e.longitude != null &&
            e.latitude >= a.min_lat && e.latitude <= a.max_lat &&
            e.longitude >= a.min_lng && e.longitude <= a.max_lng,
        );
    }, [previewEvents, area]);

    return { previewEvents, previewMarkers, areaTrail };
}
