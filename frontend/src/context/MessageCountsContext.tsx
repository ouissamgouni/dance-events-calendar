import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { fetchEventMessageCounts } from '../api';

interface Ctx {
    register: (eventId: string) => () => void;
    get: (eventId: string) => number | null;
    invalidate: (eventId: string) => void;
    version: number;
}

const MessageCountCtx = createContext<Ctx | null>(null);

const FLUSH_DELAY_MS = 50;
const MAX_BATCH = 50;

export function MessageCountsProvider({ children }: { children: ReactNode }) {
    const cacheRef = useRef<Map<string, number>>(new Map());
    const refCountRef = useRef<Map<string, number>>(new Map());
    const pendingRef = useRef<Set<string>>(new Set());
    const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [version, setVersion] = useState(0);

    const flush = useCallback(() => {
        flushTimerRef.current = null;
        const ids = Array.from(pendingRef.current);
        pendingRef.current.clear();
        if (!ids.length) return;
        for (let i = 0; i < ids.length; i += MAX_BATCH) {
            const chunk = ids.slice(i, i + MAX_BATCH);
            fetchEventMessageCounts(chunk)
                .then((counts) => {
                    if (!counts.length) return;
                    for (const c of counts) cacheRef.current.set(c.event_id, c.count);
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
        // Message counts are public, so fetch whenever not cached yet.
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
        if ((refCountRef.current.get(eventId) ?? 0) > 0) {
            pendingRef.current.add(eventId);
            scheduleFlush();
        }
        setVersion((v) => v + 1);
    }, [scheduleFlush]);

    const value = useMemo<Ctx>(
        () => ({ register, get, version, invalidate }),
        [register, get, version, invalidate],
    );
    return <MessageCountCtx.Provider value={value}>{children}</MessageCountCtx.Provider>;
}

export function useEventMessageCount(eventId: string | null | undefined): number | null {
    const ctx = useContext(MessageCountCtx);
    useEffect(() => {
        if (!ctx || !eventId) return;
        return ctx.register(eventId);
    }, [ctx, eventId]);
    if (!ctx || !eventId) return null;
    return ctx.get(eventId);
}

export function useInvalidateEventMessageCount(): (eventId: string) => void {
    const ctx = useContext(MessageCountCtx);
    return ctx?.invalidate ?? (() => { /* no-op */ });
}
