import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { fetchRatingAggregates } from '../api';
import type { EventRatingAggregate } from '../types';

interface Ctx {
    register: (eventId: string) => () => void;
    get: (eventId: string) => EventRatingAggregate | null;
    invalidate: (eventId: string) => void;
    version: number;
}

const RatingCtx = createContext<Ctx | null>(null);

const FLUSH_DELAY_MS = 50;
const MAX_BATCH = 50;

export function RatingAggregatesProvider({ children }: { children: ReactNode }) {
    const cacheRef = useRef<Map<string, EventRatingAggregate>>(new Map());
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
            fetchRatingAggregates(chunk)
                .then((aggs) => {
                    if (!aggs.length) return;
                    for (const a of aggs) cacheRef.current.set(a.event_id, a);
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
    return <RatingCtx.Provider value={value}>{children}</RatingCtx.Provider>;
}

export function useRatingAggregate(eventId: string | null | undefined): EventRatingAggregate | null {
    const ctx = useContext(RatingCtx);
    useEffect(() => {
        if (!ctx || !eventId) return;
        return ctx.register(eventId);
    }, [ctx, eventId]);
    if (!ctx || !eventId) return null;
    return ctx.get(eventId);
}

export function useInvalidateRatingAggregate(): (eventId: string) => void {
    const ctx = useContext(RatingCtx);
    return ctx?.invalidate ?? (() => { /* no-op */ });
}
