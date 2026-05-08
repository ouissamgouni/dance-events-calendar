import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { fetchAttendanceSummaryBatch } from '../api';
import type { AttendanceSummary } from '../types';
import { useAuth } from './AuthContext';

interface AttendanceSummariesContextValue {
    /**
     * Register interest in a single event id. Multiple subscribers within
     * the same tick are coalesced into a single batch request.
     * Returns a cleanup function.
     */
    register: (eventId: string) => () => void;
    /** Synchronous read of the cached summary, or null if not yet fetched. */
    get: (eventId: string) => AttendanceSummary | null;
    /** Bumps when the cache changes so subscribers can re-render. */
    version: number;
    /** Invalidate the cache for a specific event id. */
    invalidate: (eventId: string) => void;
    /**
     * Per-event version counter. Bumps every time `invalidate(eventId)` runs.
     * Consumers that maintain their own derived state (e.g. a separately
     * fetched full attendee list) can include this value in their effect
     * deps to refetch when attendance changes.
     */
    getInvalidationKey: (eventId: string) => number;
}

const Ctx = createContext<AttendanceSummariesContextValue | null>(null);

const FLUSH_DELAY_MS = 50;
// Cap a single batch HTTP request to keep payloads small.
const MAX_BATCH = 50;

export function AttendanceSummariesProvider({ children }: { children: ReactNode }) {
    const { user } = useAuth();
    const cacheRef = useRef<Map<string, AttendanceSummary>>(new Map());
    const refCountRef = useRef<Map<string, number>>(new Map());
    const invalidationKeysRef = useRef<Map<string, number>>(new Map());
    // event ids registered since the last flush
    const pendingRef = useRef<Set<string>>(new Set());
    const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [version, setVersion] = useState(0);

    // When auth state changes, the per-viewer fields (can_view_attendees,
    // viewer_is_sharing, preview_attendees) become stale — drop the cache and
    // re-request whatever is currently registered.
    useEffect(() => {
        cacheRef.current.clear();
        const all = Array.from(refCountRef.current.keys());
        for (const id of all) pendingRef.current.add(id);
        setVersion((v) => v + 1);
        scheduleFlush();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user?.user_id]);

    const flush = useCallback(() => {
        flushTimerRef.current = null;
        const ids = Array.from(pendingRef.current);
        pendingRef.current.clear();
        if (!ids.length) return;
        // Chunk to MAX_BATCH per request.
        for (let i = 0; i < ids.length; i += MAX_BATCH) {
            const chunk = ids.slice(i, i + MAX_BATCH);
            fetchAttendanceSummaryBatch(chunk)
                .then((summaries) => {
                    if (!summaries.length) return;
                    for (const s of summaries) cacheRef.current.set(s.event_id, s);
                    setVersion((v) => v + 1);
                })
                .catch(() => { /* ignore */ });
        }
    }, []);

    const scheduleFlush = useCallback(() => {
        if (flushTimerRef.current != null) return;
        flushTimerRef.current = setTimeout(flush, FLUSH_DELAY_MS);
    }, [flush]);

    const register = useCallback((eventId: string) => {
        const prev = refCountRef.current.get(eventId) ?? 0;
        refCountRef.current.set(eventId, prev + 1);
        // Only fetch if not already in cache.
        if (!cacheRef.current.has(eventId)) {
            pendingRef.current.add(eventId);
            scheduleFlush();
        }
        return () => {
            const cur = refCountRef.current.get(eventId) ?? 0;
            if (cur <= 1) refCountRef.current.delete(eventId);
            else refCountRef.current.set(eventId, cur - 1);
        };
    }, [scheduleFlush]);

    const get = useCallback((eventId: string) => cacheRef.current.get(eventId) ?? null, []);

    const invalidate = useCallback((eventId: string) => {
        cacheRef.current.delete(eventId);
        // Bump per-event key so consumers depending on it via effect deps refetch.
        invalidationKeysRef.current.set(
            eventId,
            (invalidationKeysRef.current.get(eventId) ?? 0) + 1,
        );
        // If anyone is currently subscribed, re-enqueue so they see fresh data
        // without forcing a remount/page reload.
        if ((refCountRef.current.get(eventId) ?? 0) > 0) {
            pendingRef.current.add(eventId);
            scheduleFlush();
        }
        setVersion((v) => v + 1);
    }, [scheduleFlush]);

    const getInvalidationKey = useCallback(
        (eventId: string) => invalidationKeysRef.current.get(eventId) ?? 0,
        [],
    );

    const value = useMemo<AttendanceSummariesContextValue>(
        () => ({ register, get, version, invalidate, getInvalidationKey }),
        [register, get, version, invalidate, getInvalidationKey],
    );

    return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * Subscribe to a single event's attendance summary. Returns null until the
 * batched request resolves. Safe to call from many cards on the same screen
 * — subscriptions in the same tick are coalesced into one HTTP request.
 */
export function useAttendanceSummary(eventId: string | null | undefined): AttendanceSummary | null {
    const ctx = useContext(Ctx);
    if (!ctx) throw new Error('useAttendanceSummary must be used within AttendanceSummariesProvider');
    useEffect(() => {
        if (!eventId) return;
        return ctx.register(eventId);
    }, [ctx, eventId]);
    if (!eventId) return null;
    // ctx.version is in the closure via the hook return reference, so when
    // the provider bumps version this consumer re-renders (the useContext
    // subscription re-fires on every value change).
    return ctx.get(eventId);
}

/**
 * Imperative invalidation handle for callers that mutate attendance state
 * (toggle going / change visibility). Returns a no-op when used outside the
 * provider so it stays safe to call.
 */
export function useInvalidateAttendanceSummary(): (eventId: string) => void {
    const ctx = useContext(Ctx);
    return ctx?.invalidate ?? (() => { /* no-op */ });
}

/**
 * Returns the per-event invalidation counter. Useful as an effect dep so a
 * component re-runs its own derived fetches whenever attendance for that
 * event changes.
 */
export function useAttendanceInvalidationKey(eventId: string | null | undefined): number {
    const ctx = useContext(Ctx);
    if (!ctx || !eventId) return 0;
    // ctx.version drives re-render; getInvalidationKey returns the latest count.
    void ctx.version;
    return ctx.getInvalidationKey(eventId);
}
