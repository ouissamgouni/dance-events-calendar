import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { trackAttendance } from '../utils/tracking';
import { useAuth } from './AuthContext';
import { fetchMyAttendingEvents } from '../api';
import { useInvalidateAttendanceSummary } from './AttendanceSummariesContext';

const STORAGE_KEY = 'movida_attending_events';
// New shape stored alongside the legacy array: per-event share_publicly map.
// Kept under a separate key so we can ignore corrupt/legacy values without
// having to migrate the existing array on read.
const SHARE_KEY = 'movida_attending_share_publicly';

interface AttendingEventsContextValue {
    attendingEventIds: string[];
    attendingCount: number;
    isAttending: (eventId: string) => boolean;
    /**
     * Toggle the going state for an event.
     * - When transitioning off→going on a logged-in user, callers SHOULD pass
     *   `sharePublicly` (collected via the share-confirmation popover).
     *   Omitted means "let the server pick" (falls back to user prefs).
     * - When transitioning going→off, `sharePublicly` is ignored.
     */
    toggleAttending: (eventId: string, sharePublicly?: boolean) => void;
    /**
     * Update the share_publicly flag for an event the user is already going
     * to, without changing the going/not_going state. Used by the "edit
     * sharing" affordance on the Going ✓ pill.
     */
    setSharePublicly: (eventId: string, sharePublicly: boolean) => void;
    /** True when the user is going AND share_publicly is true for this event. */
    isSharingPublicly: (eventId: string) => boolean;
}

const AttendingEventsContext = createContext<AttendingEventsContextValue | null>(null);

function readIdsFromStorage(): Set<string> {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const arr = JSON.parse(raw);
            if (Array.isArray(arr)) return new Set(arr.filter((x: unknown) => typeof x === 'string'));
        }
    } catch { /* ignore corrupt data */ }
    return new Set();
}

function readShareMapFromStorage(): Record<string, boolean> {
    try {
        const raw = localStorage.getItem(SHARE_KEY);
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

function writeIdsToStorage(ids: Set<string>) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
}

function writeShareMapToStorage(map: Record<string, boolean>) {
    localStorage.setItem(SHARE_KEY, JSON.stringify(map));
}

export function AttendingEventsProvider({ children }: { children: ReactNode }) {
    const [attendingIds, setAttendingIds] = useState<Set<string>>(() => readIdsFromStorage());
    const [shareMap, setShareMap] = useState<Record<string, boolean>>(() => readShareMapFromStorage());
    const { user } = useAuth();
    const lastSyncedUserId = useRef<string | null | undefined>(undefined);
    const invalidate = useInvalidateAttendanceSummary();

    useEffect(() => { writeIdsToStorage(attendingIds); }, [attendingIds]);
    useEffect(() => { writeShareMapToStorage(shareMap); }, [shareMap]);

    useEffect(() => {
        const currentUserKey = user?.user_id ?? user?.email ?? null;
        const previous = lastSyncedUserId.current;
        if (previous === currentUserKey) return;
        lastSyncedUserId.current = currentUserKey;
        if (!user) return;
        // We don't wipe local state on sign-out: attendance is not sensitive
        // and the device id rotates on logout (see AuthContext) so a different
        // user signing in next can't inherit this device's anonymous activity.
        fetchMyAttendingEvents()
            .then((entries) => {
                if (!entries.length) return;
                setAttendingIds((prev) => {
                    const next = new Set(prev);
                    for (const e of entries) next.add(e.event_id);
                    return next;
                });
                setShareMap((prev) => {
                    const next = { ...prev };
                    for (const e of entries) next[e.event_id] = e.share_publicly;
                    return next;
                });
            })
            .catch(() => { /* ignore */ });
    }, [user]);

    const toggleAttending = useCallback((eventId: string, sharePublicly?: boolean) => {
        const wasAttending = attendingIds.has(eventId);
        setAttendingIds((prev) => {
            const next = new Set(prev);
            if (wasAttending) next.delete(eventId);
            else next.add(eventId);
            return next;
        });
        if (!wasAttending && sharePublicly !== undefined) {
            setShareMap((prev) => ({ ...prev, [eventId]: sharePublicly }));
        }
        if (wasAttending) {
            setShareMap((prev) => {
                if (!(eventId in prev)) return prev;
                const next = { ...prev };
                delete next[eventId];
                return next;
            });
        }
        trackAttendance(
            eventId,
            wasAttending ? 'not_going' : 'going',
            wasAttending ? undefined : sharePublicly,
        ).then(() => invalidate(eventId));
        // Optimistic invalidate too, so any in-flight read is superseded.
        invalidate(eventId);
    }, [attendingIds]);

    const setSharePublicly = useCallback((eventId: string, sharePublicly: boolean) => {
        if (!attendingIds.has(eventId)) return;
        setShareMap((prev) => ({ ...prev, [eventId]: sharePublicly }));
        // Re-emit "going" with the new flag to update the server-side row
        // without changing attendance state.
        trackAttendance(eventId, 'going', sharePublicly).then(() => invalidate(eventId));
        invalidate(eventId);
    }, [attendingIds]);

    const isAttending = useCallback((eventId: string) => attendingIds.has(eventId), [attendingIds]);
    const isSharingPublicly = useCallback(
        (eventId: string) => attendingIds.has(eventId) && shareMap[eventId] === true,
        [attendingIds, shareMap],
    );

    const value = useMemo<AttendingEventsContextValue>(() => ({
        attendingEventIds: [...attendingIds],
        attendingCount: attendingIds.size,
        isAttending,
        toggleAttending,
        setSharePublicly,
        isSharingPublicly,
    }), [attendingIds, isAttending, toggleAttending, setSharePublicly, isSharingPublicly]);

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
