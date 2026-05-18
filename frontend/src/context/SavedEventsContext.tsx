import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { trackSave } from '../utils/tracking';
import { useAuth } from './AuthContext';
import { useInvalidateAttendanceSummary } from './AttendanceSummariesContext';
import { fetchMySavedEvents } from '../api';
import type { ShareAudience } from '../api';
import { identityKey } from '../utils/identity';

// Per-identity cache key prefix. The full key is
// ``movida_saved_events:<user:UUID|anon:device_id>`` so two users on the
// same browser never read each other's cached saves.
const STORAGE_PREFIX = 'movida_saved_events';
const AUDIENCE_PREFIX = 'movida_saved_audience';
// Legacy unnamespaced key. Deleted once on app load (pre-launch, no migration).
const LEGACY_STORAGE_KEY = 'movida_saved_events';

function storageKeyFor(idKey: string): string {
    return `${STORAGE_PREFIX}:${idKey}`;
}

function audienceKeyFor(idKey: string): string {
    return `${AUDIENCE_PREFIX}:${idKey}`;
}

interface SavedEventsContextValue {
    savedEventIds: string[];
    savedCount: number;
    isSaved: (eventId: string) => boolean;
    /**
     * Toggle the saved state for an event. Resolves with `true` on success,
     * or `false` if the optimistic update was rolled back due to a server
     * write failure. Callers are expected to surface success / failure
     * feedback (e.g. anchored toast) themselves.
     */
    toggleSave: (eventId: string) => Promise<boolean>;
    /** Per-event audience for the current user. Defaults to 'private' if unknown. */
    getSavedAudience: (eventId: string) => ShareAudience;
    /**
     * Update the audience for an event the user has already saved, without
     * changing the saved state. Re-emits ``track_event_save(action='save')``
     * with the new audience.
     */
    setSavedAudience: (eventId: string, audience: ShareAudience) => Promise<boolean>;
    clearAll: () => void;
}

const SavedEventsContext = createContext<SavedEventsContextValue | null>(null);

function readFromStorage(idKey: string): Set<string> {
    try {
        const raw = localStorage.getItem(storageKeyFor(idKey));
        if (raw) {
            const arr = JSON.parse(raw);
            if (Array.isArray(arr)) return new Set(arr.filter((x: unknown) => typeof x === 'string'));
        }
    } catch { /* ignore corrupt data */ }
    return new Set();
}

function readAudienceMapFromStorage(idKey: string): Record<string, ShareAudience> {
    try {
        const raw = localStorage.getItem(audienceKeyFor(idKey));
        if (raw) {
            const obj = JSON.parse(raw);
            if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                const out: Record<string, ShareAudience> = {};
                for (const [k, v] of Object.entries(obj)) {
                    if (v === 'public' || v === 'friends' || v === 'private') out[k] = v;
                }
                return out;
            }
        }
    } catch { /* ignore */ }
    return {};
}

function writeToStorage(idKey: string, ids: Set<string>) {
    try {
        localStorage.setItem(storageKeyFor(idKey), JSON.stringify([...ids]));
    } catch { /* quota / disabled — non-fatal, server is source of truth */ }
}

function writeAudienceMapToStorage(idKey: string, map: Record<string, ShareAudience>) {
    try { localStorage.setItem(audienceKeyFor(idKey), JSON.stringify(map)); } catch { /* ignore */ }
}

// Pre-launch one-shot cleanup: drop the legacy unnamespaced key so it
// can never bleed into a per-identity bucket. Idempotent; runs once per
// page load. No migration: server is the source of truth and any data
// the user cares about is already there (or was anonymous and will be
// replaced by the next anon read).
let legacyCleaned = false;
function cleanupLegacyStorageOnce(): void {
    if (legacyCleaned) return;
    legacyCleaned = true;
    try { localStorage.removeItem(LEGACY_STORAGE_KEY); } catch { /* ignore */ }
}

export function SavedEventsProvider({ children }: { children: ReactNode }) {
    const { user } = useAuth();
    const invalidateSummary = useInvalidateAttendanceSummary();

    // Per-identity client cache discriminator (see utils/identity.ts).
    const idKey = identityKey(user);

    // Synchronous initial state from the per-identity cache for instant
    // first paint. The reconciliation effect below replaces this with
    // server truth once the network call resolves.
    const [savedIds, setSavedIds] = useState<Set<string>>(() => {
        cleanupLegacyStorageOnce();
        return readFromStorage(idKey);
    });
    const [audienceMap, setAudienceMap] = useState<Record<string, ShareAudience>>(
        () => readAudienceMapFromStorage(idKey),
    );
    const lastIdentity = useRef<string>(idKey);

    // Persist to the current identity's cache on every state mutation
    // (write-through). Cheap and matches the pre-refactor behavior.
    useEffect(() => {
        writeToStorage(lastIdentity.current, savedIds);
    }, [savedIds]);
    useEffect(() => {
        writeAudienceMapToStorage(lastIdentity.current, audienceMap);
    }, [audienceMap]);

    // Identity-change reconciliation. REPLACE local state with server truth
    // (no union) so switching users never leaks the previous user's saves
    // into the new user's view. Anonymous reads return rows owned by the
    // ``movida_aid`` httpOnly cookie identity (or empty if absent).
    useEffect(() => {
        if (lastIdentity.current !== idKey) {
            // Identity changed: hydrate from the new identity's cache for
            // an immediate paint, then overlay server truth below.
            lastIdentity.current = idKey;
            setSavedIds(readFromStorage(idKey));
            setAudienceMap(readAudienceMapFromStorage(idKey));
        }
        let cancelled = false;
        fetchMySavedEvents()
            .then((entries) => {
                if (cancelled) return;
                // REPLACE — never union. Server is the source of truth.
                setSavedIds(new Set(entries.map((e) => e.event_id)));
                const next: Record<string, ShareAudience> = {};
                for (const e of entries) next[e.event_id] = e.audience;
                setAudienceMap(next);
            })
            .catch(() => { /* offline — keep cached state */ });
        return () => { cancelled = true; };
    }, [idKey]);

    const toggleSave = useCallback((eventId: string): Promise<boolean> => {
        const wasSaved = savedIds.has(eventId);
        const action: 'save' | 'unsave' = wasSaved ? 'unsave' : 'save';
        // Optimistic local flip — the user sees the change immediately.
        const optimistic = new Set(savedIds);
        if (wasSaved) optimistic.delete(eventId); else optimistic.add(eventId);
        setSavedIds(optimistic);
        invalidateSummary(eventId);

        return trackSave(eventId, action).then(() => true).catch(() => {
            // Rollback on functional-state failure so the UI doesn't lie
            // about server state. The caller is responsible for surfacing
            // a user-visible error (anchored toast).
            setSavedIds((current) => {
                const reverted = new Set(current);
                if (wasSaved) reverted.add(eventId); else reverted.delete(eventId);
                return reverted;
            });
            invalidateSummary(eventId);
            return false;
        });
    }, [savedIds, invalidateSummary]);

    const isSaved = useCallback((eventId: string) => savedIds.has(eventId), [savedIds]);

    const getSavedAudience = useCallback(
        (eventId: string): ShareAudience => audienceMap[eventId] ?? 'private',
        [audienceMap],
    );

    const setSavedAudience = useCallback(
        (eventId: string, audience: ShareAudience): Promise<boolean> => {
            if (!savedIds.has(eventId)) return Promise.resolve(true);
            const previous = { ...audienceMap };
            setAudienceMap((prev) => ({ ...prev, [eventId]: audience }));
            // Re-emit ``save`` with the new audience to update the row.
            return trackSave(eventId, 'save', audience).then(() => true).catch(() => {
                setAudienceMap(previous);
                return false;
            });
        },
        [savedIds, audienceMap],
    );

    const clearAll = useCallback(() => {
        // Snapshot for rollback if any individual unsave fails. We don't
        // bother with per-event rollback granularity here; just restore
        // the events whose unsave write failed so the user can retry.
        const previous = new Set(savedIds);
        setSavedIds(new Set());
        const failures: string[] = [];
        Promise.allSettled(
            [...previous].map((id) => trackSave(id, 'unsave').catch((err) => {
                failures.push(id);
                throw err;
            })),
        ).then(() => {
            if (failures.length === 0) return;
            setSavedIds((current) => {
                const restored = new Set(current);
                for (const id of failures) restored.add(id);
                return restored;
            });
        });
    }, [savedIds]);

    const value = useMemo<SavedEventsContextValue>(() => ({
        savedEventIds: [...savedIds],
        savedCount: savedIds.size,
        isSaved,
        toggleSave,
        getSavedAudience,
        setSavedAudience,
        clearAll,
    }), [savedIds, isSaved, toggleSave, getSavedAudience, setSavedAudience, clearAll]);

    return (
        <SavedEventsContext.Provider value={value}>
            {children}
        </SavedEventsContext.Provider>
    );
}

export function useSavedEvents(): SavedEventsContextValue {
    const ctx = useContext(SavedEventsContext);
    if (!ctx) throw new Error('useSavedEvents must be used within SavedEventsProvider');
    return ctx;
}
