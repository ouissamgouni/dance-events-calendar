import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { usePreferences } from '../context/PreferencesContext';
import {
    fetchInterestProfiles,
    updateInterestProfile,
    type InterestProfile,
    type InterestProfileUpdatePayload,
    type PreferredAreaPayload,
    type ReachFilter,
} from '../api';

export interface ActiveProfileSaveInput {
    /** New default area. Omit the key to leave the area unchanged. */
    area?: PreferredAreaPayload | null;
    /** New default dance-style tag ids. Omit to leave unchanged. */
    danceTagIds?: number[];
    /** New default event reach filter. Omit to leave unchanged. */
    reachFilter?: ReachFilter;
}

/**
 * Canonical accessor for the user's default filters (area + dance styles +
 * event reach). The active interest profile is the source of truth for
 * authenticated users; anonymous users fall back to the local prefs cache.
 * Explore reads defaults via ``prefs.area``/``prefs.tagIds`` (kept in sync
 * here) and persists new defaults through ``saveDefaults``.
 */
export function useActiveProfile() {
    const { user } = useAuth();
    const { setPrefs, applyLocalMirror } = usePreferences();
    const [activeProfile, setActiveProfile] = useState<InterestProfile | null>(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!user) {
            setActiveProfile(null);
            return;
        }
        let cancelled = false;
        setLoading(true);
        fetchInterestProfiles()
            .then((list) => {
                if (cancelled) return;
                const active = list.find((p) => p.is_active) ?? list[0] ?? null;
                setActiveProfile(active);
                if (active) {
                    applyLocalMirror({
                        area: {
                            min_lat: active.min_lat,
                            min_lng: active.min_lng,
                            max_lat: active.max_lat,
                            max_lng: active.max_lng,
                            label: active.area_label,
                        },
                        tagIds: active.dance_tag_ids,
                    });
                }
            })
            .catch(() => {
                if (!cancelled) setActiveProfile(null);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [user, applyLocalMirror]);

    const saveDefaults = useCallback(
        async (input: ActiveProfileSaveInput): Promise<void> => {
            if (user && activeProfile) {
                const payload: InterestProfileUpdatePayload = {};
                if (input.area) {
                    payload.area_label = input.area.label;
                    payload.min_lat = input.area.min_lat;
                    payload.min_lng = input.area.min_lng;
                    payload.max_lat = input.area.max_lat;
                    payload.max_lng = input.area.max_lng;
                }
                if (input.danceTagIds) payload.dance_tag_ids = input.danceTagIds;
                if (input.reachFilter) payload.reach_filter = input.reachFilter;
                const updated = await updateInterestProfile(activeProfile.id, payload);
                setActiveProfile(updated);
                applyLocalMirror({
                    ...(input.area !== undefined ? { area: input.area } : {}),
                    tagIds: updated.dance_tag_ids,
                });
                return;
            }
            const nextTags =
                input.danceTagIds
                    ? input.danceTagIds
                    : undefined;
            await setPrefs({
                ...(input.area !== undefined ? { area: input.area } : {}),
                ...(nextTags !== undefined ? { tagIds: nextTags } : {}),
            });
        },
        [user, activeProfile, applyLocalMirror, setPrefs],
    );

    return { activeProfile, loading, saveDefaults };
}
