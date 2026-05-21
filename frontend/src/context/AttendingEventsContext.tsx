import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { trackAttendance } from '../utils/tracking';
import { useAuth } from './AuthContext';
import { fetchMyAttendingEvents } from '../api';
import type { ShareAudience } from '../api';
import { useInvalidateAttendanceSummary } from './AttendanceSummariesContext';
import { identityKey } from '../utils/identity';

// Per-identity cache key prefixes (see SavedEventsContext for rationale).
const STORAGE_PREFIX = 'movida_attending_events';
const SHARE_PREFIX = 'movida_attending_share_publicly';
const AUDIENCE_PREFIX = 'movida_attending_audience';
// Legacy unnamespaced keys; deleted once on app load (pre-launch).
const LEGACY_STORAGE_KEY = 'movida_attending_events';
const LEGACY_SHARE_KEY = 'movida_attending_share_publicly';

function storageKeyFor(idKey: string): string { return `${STORAGE_PREFIX}:${idKey}`; }
function shareKeyFor(idKey: string): string { return `${SHARE_PREFIX}:${idKey}`; }
function audienceKeyFor(idKey: string): string { return `${AUDIENCE_PREFIX}:${idKey}`; }

interface AttendingEventsContextValue {
    attendingEventIds: string[];
    attendingCount: number;
    isAttending: (eventId: string) => boolean;
    /**
     * Toggle the going state for an event.
     * - When transitioning off→going on a logged-in user, callers SHOULD pass
     *   `audience` (collected via the audience picker).
     *   Omitted means "let the server pick" (falls back to user prefs).
     * - When transitioning going→off, `audience` is ignored.
     *
     * Resolves with `true` on success, or `false` if the optimistic update
     * was rolled back due to a server write failure. Callers are expected
     * to surface success / failure feedback (e.g. anchored toast) themselves.
     */
    toggleAttending: (eventId: string, audience?: ShareAudience) => Promise<boolean>;
    /**
     * Update the audience for an event the user is already going to,
     * without changing the going/not_going state. Used by the audience
     * picker on the Going pill. Resolves with `true` on success, `false`
     * if rolled back.
     */
    setAudience: (eventId: string, audience: ShareAudience) => Promise<boolean>;
    /** Per-event audience for the current user. Defaults to 'private' if unknown. */
    getAudience: (eventId: string) => ShareAudience;
    /** True when the user is going AND audience !== 'private'. */
    isSharingPublicly: (eventId: string) => boolean;
}

const AttendingEventsContext = createContext<AttendingEventsContextValue | null>(null);

function readIdsFromStorage(idKey: string): Set<string> {
    try {
        const raw = localStorage.getItem(storageKeyFor(idKey));
        if (raw) {
            const arr = JSON.parse(raw);
            if (Array.isArray(arr)) return new Set(arr.filter((x: unknown) => typeof x === 'string'));
        }
    } catch { /* ignore corrupt data */ }
    return new Set();
}

function readShareMapFromStorage(idKey: string): Record<string, boolean> {
    try {
        const raw = localStorage.getItem(shareKeyFor(idKey));
        if (raw) {
            const obj = JSON.parse(raw);
            if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                const out: Record<string, boolean> = {};
                for (const [k, v] of Object.entries(obj)) {
                    if (typeof v === 'boolean') out[k] = v;
                }
                return out;
            }
        }
    } catch { /* ignore */ }
    return {};
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

function writeIdsToStorage(idKey: string, ids: Set<string>) {
    try { localStorage.setItem(storageKeyFor(idKey), JSON.stringify([...ids])); } catch { /* ignore */ }
}

function writeShareMapToStorage(idKey: string, map: Record<string, boolean>) {
    try { localStorage.setItem(shareKeyFor(idKey), JSON.stringify(map)); } catch { /* ignore */ }
}

function writeAudienceMapToStorage(idKey: string, map: Record<string, ShareAudience>) {
    try { localStorage.setItem(audienceKeyFor(idKey), JSON.stringify(map)); } catch { /* ignore */ }
}

let legacyCleaned = false;
function cleanupLegacyStorageOnce(): void {
    if (legacyCleaned) return;
    legacyCleaned = true;
    try { localStorage.removeItem(LEGACY_STORAGE_KEY); } catch { /* ignore */ }
    try { localStorage.removeItem(LEGACY_SHARE_KEY); } catch { /* ignore */ }
}

export function AttendingEventsProvider({ children }: { children: ReactNode }) {
    const { user } = useAuth();
    const invalidate = useInvalidateAttendanceSummary();

    const idKey = identityKey(user);
    const [attendingIds, setAttendingIds] = useState<Set<string>>(() => {
        cleanupLegacyStorageOnce();
        return readIdsFromStorage(idKey);
    });
    const [shareMap, setShareMap] = useState<Record<string, boolean>>(() => readShareMapFromStorage(idKey));
    const [audienceMap, setAudienceMap] = useState<Record<string, ShareAudience>>(() => readAudienceMapFromStorage(idKey));
    const lastIdentity = useRef<string>(idKey);

    useEffect(() => { writeIdsToStorage(lastIdentity.current, attendingIds); }, [attendingIds]);
    useEffect(() => { writeShareMapToStorage(lastIdentity.current, shareMap); }, [shareMap]);
    useEffect(() => { writeAudienceMapToStorage(lastIdentity.current, audienceMap); }, [audienceMap]);

    // Identity-change reconciliation. REPLACE local state with server truth
    // (no union). See SavedEventsContext for the same rationale.
    useEffect(() => {
        if (lastIdentity.current !== idKey) {
            lastIdentity.current = idKey;
            setAttendingIds(readIdsFromStorage(idKey));
            setShareMap(readShareMapFromStorage(idKey));
            setAudienceMap(readAudienceMapFromStorage(idKey));
        }
        let cancelled = false;
        fetchMyAttendingEvents()
            .then((entries) => {
                if (cancelled) return;
                setAttendingIds(new Set(entries.map((e) => e.event_id)));
                const nextShare: Record<string, boolean> = {};
                const nextAudience: Record<string, ShareAudience> = {};
                for (const e of entries) {
                    nextShare[e.event_id] = e.share_publicly;
                    nextAudience[e.event_id] = e.share_audience
                        ?? (e.share_publicly ? 'public' : 'private');
                }
                setShareMap(nextShare);
                setAudienceMap(nextAudience);
            })
            .catch(() => { /* offline — keep cached state */ });
        return () => { cancelled = true; };
    }, [idKey]);

    const toggleAttending = useCallback((eventId: string, audience?: ShareAudience): Promise<boolean> => {
        const wasAttending = attendingIds.has(eventId);
        // Snapshots for rollback.
        const previousIds = new Set(attendingIds);
        const previousShare = { ...shareMap };
        const previousAudience = { ...audienceMap };

        const sharePublicly = audience === undefined ? undefined : audience === 'public';

        // Optimistic flip.
        const optimisticIds = new Set(attendingIds);
        if (wasAttending) optimisticIds.delete(eventId); else optimisticIds.add(eventId);
        setAttendingIds(optimisticIds);
        if (!wasAttending && audience !== undefined) {
            setShareMap((prev) => ({ ...prev, [eventId]: audience === 'public' }));
            setAudienceMap((prev) => ({ ...prev, [eventId]: audience }));
        }
        if (wasAttending) {
            setShareMap((prev) => {
                if (!(eventId in prev)) return prev;
                const next = { ...prev };
                delete next[eventId];
                return next;
            });
            setAudienceMap((prev) => {
                if (!(eventId in prev)) return prev;
                const next = { ...prev };
                delete next[eventId];
                return next;
            });
        }
        // Optimistic invalidate too, so any in-flight read is superseded.
        invalidate(eventId);

        return trackAttendance(
            eventId,
            wasAttending ? 'not_going' : 'going',
            wasAttending ? undefined : sharePublicly,
            !!user,
            wasAttending ? undefined : audience,
        ).then(() => { invalidate(eventId); return true; }).catch(() => {
            // Rollback all maps on functional-state failure. Caller surfaces
            // a user-visible error (anchored toast).
            setAttendingIds(previousIds);
            setShareMap(previousShare);
            setAudienceMap(previousAudience);
            invalidate(eventId);
            return false;
        });
    }, [attendingIds, shareMap, audienceMap, user, invalidate]);

    const setAudience = useCallback((eventId: string, audience: ShareAudience): Promise<boolean> => {
        if (!attendingIds.has(eventId)) return Promise.resolve(true);
        const previousShare = { ...shareMap };
        const previousAudience = { ...audienceMap };
        const sharePublicly = audience === 'public';
        // Optimistic update.
        setShareMap((prev) => ({ ...prev, [eventId]: sharePublicly }));
        setAudienceMap((prev) => ({ ...prev, [eventId]: audience }));
        invalidate(eventId);
        // Re-emit "going" with the new audience to update the server-side
        // row without changing attendance state.
        return trackAttendance(eventId, 'going', sharePublicly, !!user, audience)
            .then(() => { invalidate(eventId); return true; })
            .catch(() => {
                setShareMap(previousShare);
                setAudienceMap(previousAudience);
                invalidate(eventId);
                return false;
            });
    }, [attendingIds, shareMap, audienceMap, user, invalidate]);

    const isAttending = useCallback((eventId: string) => attendingIds.has(eventId), [attendingIds]);
    const isSharingPublicly = useCallback(
        (eventId: string) => attendingIds.has(eventId) && (audienceMap[eventId] ?? (shareMap[eventId] ? 'public' : 'private')) !== 'private',
        [attendingIds, shareMap, audienceMap],
    );
    const getAudience = useCallback(
        (eventId: string): ShareAudience => audienceMap[eventId] ?? (shareMap[eventId] ? 'public' : 'private'),
        [shareMap, audienceMap],
    );

    const value = useMemo<AttendingEventsContextValue>(() => ({
        attendingEventIds: [...attendingIds],
        attendingCount: attendingIds.size,
        isAttending,
        toggleAttending,
        setAudience,
        getAudience,
        isSharingPublicly,
    }), [attendingIds, isAttending, toggleAttending, setAudience, getAudience, isSharingPublicly]);

    return (
        <AttendingEventsContext.Provider value={value}>
            {children}
        </AttendingEventsContext.Provider>
    );
}

export function useAttendingEvents(): AttendingEventsContextValue {
    const ctx = useContext(AttendingEventsContext);
    if (!ctx) throw new Error('useAttendingEvents must be used within AttendingEventsProvider');
    return ctx;
}
