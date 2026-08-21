import { useCallback, useEffect, useState } from 'react';
import {
    createInterestProfile,
    deleteInterestProfile,
    fetchInterestProfiles,
    updateInterestProfile,
    type InterestProfile,
    type InterestProfilePayload,
    type InterestProfileUpdatePayload,
    type PreferredAreaPayload,
} from '../api';
import { useAuth } from '../context/AuthContext';
import { usePreferences } from '../context/PreferencesContext';

/**
 * Shared list + CRUD orchestration for the signed-in user's interest profiles
 * (a.k.a. search profiles). Mirrors the active profile's area + tags into
 * {@link PreferencesContext} after every mutation so the Explorer's default
 * filters stay in sync. Consumed by both the Settings profiles manager and the
 * Explore filter-sheet search-profile flow.
 */
export function useInterestProfiles() {
    const { user } = useAuth();
    const { setPrefs } = usePreferences();
    const [profiles, setProfiles] = useState<InterestProfile[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    const mirrorActiveToPrefs = useCallback(
        async (profile: InterestProfile | undefined | null) => {
            if (!profile || !profile.is_active) return;
            const area: PreferredAreaPayload = {
                min_lat: profile.min_lat,
                min_lng: profile.min_lng,
                max_lat: profile.max_lat,
                max_lng: profile.max_lng,
                label: profile.label,
            };
            try {
                await setPrefs({ tagIds: [...profile.dance_tag_ids, ...profile.reach_tag_ids], area });
            } catch {
                /* best-effort: mirroring is non-critical */
            }
        },
        [setPrefs],
    );

    const reload = useCallback(async (): Promise<InterestProfile[]> => {
        const next = await fetchInterestProfiles();
        setProfiles(next);
        return next;
    }, []);

    useEffect(() => {
        if (!user) {
            setProfiles(null);
            return;
        }
        let cancelled = false;
        fetchInterestProfiles()
            .then((p) => {
                if (!cancelled) setProfiles(p);
            })
            .catch((e) => {
                if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load profiles');
            });
        return () => {
            cancelled = true;
        };
    }, [user]);

    const createProfile = useCallback(
        async (payload: InterestProfilePayload): Promise<InterestProfile> => {
            const created = await createInterestProfile(payload);
            const next = await reload();
            await mirrorActiveToPrefs(next.find((p) => p.is_active));
            return created;
        },
        [reload, mirrorActiveToPrefs],
    );

    const updateProfile = useCallback(
        async (id: number, payload: InterestProfileUpdatePayload): Promise<InterestProfile> => {
            const updated = await updateInterestProfile(id, payload);
            setProfiles((prev) => (prev ? prev.map((p) => (p.id === id ? updated : p)) : prev));
            await mirrorActiveToPrefs(updated);
            return updated;
        },
        [mirrorActiveToPrefs],
    );

    const deleteProfile = useCallback(
        async (id: number): Promise<void> => {
            await deleteInterestProfile(id);
            // A delete can promote another profile to active server-side.
            const next = await reload();
            await mirrorActiveToPrefs(next.find((p) => p.is_active));
        },
        [reload, mirrorActiveToPrefs],
    );

    const activateProfile = useCallback(
        async (id: number): Promise<void> => {
            await updateInterestProfile(id, { is_active: true });
            const next = await reload();
            await mirrorActiveToPrefs(next.find((p) => p.id === id));
        },
        [reload, mirrorActiveToPrefs],
    );

    return {
        profiles,
        error,
        setError,
        reload,
        createProfile,
        updateProfile,
        deleteProfile,
        activateProfile,
    };
}
