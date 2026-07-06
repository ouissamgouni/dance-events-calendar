import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { updateUserPreferences } from '../api';
import type { HomeLocationPayload, PreferredAreaPayload, UpdatePreferencesPayload, UserPreferences } from '../api';

const STORAGE_KEY = 'movida.preferences.v1';

export interface PreferencesState {
    /** Saved preferred map area, or null if none. */
    area: PreferredAreaPayload | null;
    /** Saved preferred dance-style tag IDs (empty when none). */
    tagIds: number[];
    /** Home pin used as the default center for radius-mode interest
     * profiles, or null if none has been set. */
    homeLocation: HomeLocationPayload | null;
    /** ISO timestamp set when the user (or anon→authed merge) explicitly saved
     * preferences. Null = never opted in (the explorer still shows the default
     * area chip but no "Save as my defaults" affordance is required). */
    setAt: string | null;
}

const EMPTY: PreferencesState = { area: null, tagIds: [], homeLocation: null, setAt: null };

/**
 * The shape we persist to localStorage. Versioned via the storage key; if we
 * ever change the shape we bump to ``v2`` so old blobs are silently ignored
 * by ``readFromStorage`` rather than crashing the app. Embedded ``set_at``
 * mirrors the server column.
 */
interface StoredPreferences {
    preferred_area: PreferredAreaPayload | null;
    preferred_tag_ids: number[];
    home_location: HomeLocationPayload | null;
    set_at: string | null;
}

function readFromStorage(): PreferencesState {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return EMPTY;
        const parsed = JSON.parse(raw) as Partial<StoredPreferences>;
        if (!parsed || typeof parsed !== 'object') return EMPTY;
        const area = parsed.preferred_area;
        const validArea =
            area &&
                typeof area === 'object' &&
                typeof area.min_lat === 'number' &&
                typeof area.min_lng === 'number' &&
                typeof area.max_lat === 'number' &&
                typeof area.max_lng === 'number' &&
                typeof area.label === 'string'
                ? (area as PreferredAreaPayload)
                : null;
        const tagIds = Array.isArray(parsed.preferred_tag_ids)
            ? parsed.preferred_tag_ids.filter((x): x is number => typeof x === 'number')
            : [];
        const home = parsed.home_location;
        const validHome =
            home &&
                typeof home === 'object' &&
                typeof home.lat === 'number' &&
                typeof home.lng === 'number' &&
                typeof home.label === 'string'
                ? (home as HomeLocationPayload)
                : null;
        const setAt = typeof parsed.set_at === 'string' ? parsed.set_at : null;
        return { area: validArea, tagIds, homeLocation: validHome, setAt };
    } catch {
        // Defensive: a malformed blob (older shape, hand-edited, etc.) must
        // never crash the app or block sign-in. Treat as "no anon prefs".
        return EMPTY;
    }
}

function writeToStorage(state: PreferencesState): void {
    try {
        const payload: StoredPreferences = {
            preferred_area: state.area,
            preferred_tag_ids: state.tagIds,
            home_location: state.homeLocation,
            set_at: state.setAt,
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
        /* localStorage full / disabled — best-effort */
    }
}

function fromServer(prefs: UserPreferences | undefined): PreferencesState {
    if (!prefs) return EMPTY;
    return {
        area: prefs.preferred_area,
        tagIds: [...prefs.preferred_tag_ids],
        homeLocation: prefs.home_location,
        setAt: prefs.set_at,
    };
}

interface PreferencesContextValue {
    /** Current effective preferences (server-hydrated when authed, else local). */
    prefs: PreferencesState;
    /** True once the user has explicitly saved preferences (anon or authed). */
    hasSetPrefs: boolean;
    /** Save preferences. When authed, persists to the server and overwrites
     * local storage with the server response. When anon, writes only to
     * local storage. */
    setPrefs: (next: { area?: PreferredAreaPayload | null; tagIds?: number[]; homeLocation?: HomeLocationPayload | null }) => Promise<PreferencesState>;
    /** Clear both area + tags (sets ``setAt`` to now so we don't re-prompt). */
    clearPrefs: () => Promise<PreferencesState>;
    /** Build the payload to include in ``POST /api/auth/google`` so the
     * backend can merge anon prefs into a fresh user row. Returns null when
     * there is nothing to merge. */
    buildAnonPayload: () => { preferred_area: PreferredAreaPayload | null; preferred_tag_ids: number[]; home_location: HomeLocationPayload | null } | null;
    /** Hydrate the context from the server payload after sign-in. */
    hydrateFromServer: (prefs: UserPreferences | undefined) => void;
}

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

export function PreferencesProvider({ children }: { children: ReactNode }) {
    const { user } = useAuth();
    const [state, setState] = useState<PreferencesState>(() => readFromStorage());
    const lastSyncedUserId = useRef<string | null | undefined>(undefined);

    // Persist on every change. Single source of truth.
    useEffect(() => {
        writeToStorage(state);
    }, [state]);

    // On sign-in, replace local state with server prefs (server is source of
    // truth for authed users — anon prefs were already merged server-side via
    // the sign-in body). On sign-out, keep local state — the device just
    // becomes anonymous again, mirroring SavedEventsContext.
    useEffect(() => {
        const currentUserKey = user?.user_id ?? user?.email ?? null;
        const previous = lastSyncedUserId.current;
        if (previous === currentUserKey) return;
        lastSyncedUserId.current = currentUserKey;
        if (!user) return;
        if (user.preferences) {
            setState(fromServer(user.preferences));
        }
    }, [user]);

    const hydrateFromServer = useCallback((prefs: UserPreferences | undefined) => {
        setState(fromServer(prefs));
    }, []);

    const setPrefs = useCallback(
        async (next: { area?: PreferredAreaPayload | null; tagIds?: number[]; homeLocation?: HomeLocationPayload | null }): Promise<PreferencesState> => {
            const merged: PreferencesState = {
                area: 'area' in next ? next.area ?? null : state.area,
                tagIds: 'tagIds' in next ? next.tagIds ?? [] : state.tagIds,
                homeLocation: 'homeLocation' in next ? next.homeLocation ?? null : state.homeLocation,
                setAt: new Date().toISOString(),
            };
            if (user) {
                const payload: UpdatePreferencesPayload = {};
                if ('area' in next) payload.preferred_area = next.area ?? null;
                if ('tagIds' in next) payload.preferred_tag_ids = next.tagIds ?? [];
                if ('homeLocation' in next) payload.home_location = next.homeLocation ?? null;
                const server = await updateUserPreferences(payload);
                const synced = fromServer(server);
                setState(synced);
                return synced;
            }
            setState(merged);
            return merged;
        },
        [state, user],
    );

    const clearPrefs = useCallback(async (): Promise<PreferencesState> => {
        return setPrefs({ area: null, tagIds: [] });
    }, [setPrefs]);

    const buildAnonPayload = useCallback(() => {
        // Always send the current local state on sign-in. Backend ignores it
        // when the user already has server-side prefs (cross-device safety).
        if (!state.setAt && !state.area && state.tagIds.length === 0 && !state.homeLocation) return null;
        return {
            preferred_area: state.area,
            preferred_tag_ids: state.tagIds,
            home_location: state.homeLocation,
        };
    }, [state]);

    const value = useMemo<PreferencesContextValue>(
        () => ({
            prefs: state,
            hasSetPrefs: state.setAt !== null,
            setPrefs,
            clearPrefs,
            buildAnonPayload,
            hydrateFromServer,
        }),
        [state, setPrefs, clearPrefs, buildAnonPayload, hydrateFromServer],
    );

    return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences(): PreferencesContextValue {
    const ctx = useContext(PreferencesContext);
    if (!ctx) throw new Error('usePreferences must be used within PreferencesProvider');
    return ctx;
}
