import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { fetchEventAssetSummaries } from '../api';
import type { EventAssetSummary } from '../types';
import { useAuth } from './AuthContext';
import { useFeatureFlags } from './FeatureFlagsContext';

// null = fetched, user is not Going (no summary row).
type Entry = EventAssetSummary | null;

interface EventAssetSummaryContextValue {
    register: (eventId: string) => () => void;
    get: (eventId: string) => Entry | undefined;
    patch: (eventId: string, change: Partial<EventAssetSummary>) => void;
    version: number;
}

const Ctx = createContext<EventAssetSummaryContextValue | null>(null);
const FLUSH_DELAY_MS = 50;
const MAX_BATCH = 200;
const EMPTY: EventAssetSummary = {
    ticket_count: 0,
    memory_count: 0,
    memory_thumbs: [],
    can_add_memory: false,
    memory_window_closes_at: null,
};

export function EventAssetSummaryProvider({ children }: { children: ReactNode }) {
    const { user } = useAuth();
    const { eventTicketsEnabled, eventMemoriesEnabled } = useFeatureFlags();
    // Cache per signed-in user so switching accounts never shows stale rows.
    const scope = user?.user_id && (eventTicketsEnabled || eventMemoriesEnabled) ? user.user_id : null;
    const cachesRef = useRef<Map<string, Map<string, Entry>>>(new Map());
    const pendingRef = useRef<Set<string>>(new Set());
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [version, setVersion] = useState(0);

    const cacheFor = useCallback((key: string) => {
        let cache = cachesRef.current.get(key);
        if (!cache) {
            cache = new Map();
            cachesRef.current.set(key, cache);
        }
        return cache;
    }, []);

    const flush = useCallback(() => {
        timerRef.current = null;
        if (!scope) return;
        const ids = Array.from(pendingRef.current);
        pendingRef.current.clear();
        const cache = cacheFor(scope);
        for (let index = 0; index < ids.length; index += MAX_BATCH) {
            const batch = ids.slice(index, index + MAX_BATCH);
            fetchEventAssetSummaries(batch)
                .then((rows) => {
                    for (const id of batch) cache.set(id, rows[id] ?? null);
                    setVersion((v) => v + 1);
                })
                .catch(() => { /* Unknown stays hidden. */ });
        }
    }, [cacheFor, scope]);

    useEffect(() => () => {
        if (timerRef.current != null) clearTimeout(timerRef.current);
        timerRef.current = null;
        pendingRef.current.clear();
    }, [scope]);

    const register = useCallback((eventId: string) => {
        if (scope && !cacheFor(scope).has(eventId)) {
            pendingRef.current.add(eventId);
            if (timerRef.current == null) timerRef.current = setTimeout(flush, FLUSH_DELAY_MS);
        }
        return () => { };
    }, [cacheFor, flush, scope]);

    const get = useCallback(
        (eventId: string) => (scope ? cacheFor(scope).get(eventId) : undefined),
        [cacheFor, scope],
    );

    const patch = useCallback((eventId: string, change: Partial<EventAssetSummary>) => {
        if (!scope) return;
        const cache = cacheFor(scope);
        cache.set(eventId, { ...EMPTY, ...cache.get(eventId), ...change });
        setVersion((v) => v + 1);
    }, [cacheFor, scope]);

    const value = useMemo(() => ({ register, get, patch, version }), [get, patch, register, version]);
    return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The current user's ticket/memory summary for an event; undefined while
 *  unknown or outside the provider, null when the user is not Going. */
export function useEventAssetSummary(eventId: string | null | undefined): Entry | undefined {
    const ctx = useContext(Ctx);
    useEffect(() => {
        if (!ctx || !eventId) return;
        return ctx.register(eventId);
    }, [ctx, eventId]);
    if (!ctx || !eventId) return undefined;
    void ctx.version;
    return ctx.get(eventId);
}

export function usePatchEventAssetSummary(): (eventId: string, change: Partial<EventAssetSummary>) => void {
    const ctx = useContext(Ctx);
    return ctx?.patch ?? noop;
}

function noop() { }
