import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { fetchMyPlanCounts } from '../api';
import { useAuth } from './AuthContext';

interface MyPlanCountContextValue {
    register: (eventId: string) => () => void;
    get: (eventId: string) => number | undefined;
    set: (eventId: string, count: number) => void;
    version: number;
}

const Ctx = createContext<MyPlanCountContextValue | null>(null);
const FLUSH_DELAY_MS = 50;
const MAX_BATCH = 50;

export function MyPlanCountProvider({ children }: { children: ReactNode }) {
    const { user } = useAuth();
    const cacheRef = useRef<Map<string, number>>(new Map());
    const refCountRef = useRef<Map<string, number>>(new Map());
    const pendingRef = useRef<Set<string>>(new Set());
    const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const authGenerationRef = useRef(0);
    const [version, setVersion] = useState(0);

    const flush = useCallback(() => {
        flushTimerRef.current = null;
        if (!user?.user_id) {
            pendingRef.current.clear();
            return;
        }
        const ids = Array.from(pendingRef.current);
        pendingRef.current.clear();
        const authGeneration = authGenerationRef.current;
        for (let index = 0; index < ids.length; index += MAX_BATCH) {
            fetchMyPlanCounts(ids.slice(index, index + MAX_BATCH))
                .then((rows) => {
                    if (authGeneration !== authGenerationRef.current) return;
                    for (const row of rows) cacheRef.current.set(row.event_id, row.plan_count);
                    setVersion((current) => current + 1);
                })
                .catch(() => { /* Keep failed counts unknown. */ });
        }
    }, [user?.user_id]);

    const scheduleFlush = useCallback(() => {
        if (!user?.user_id || flushTimerRef.current != null) return;
        flushTimerRef.current = setTimeout(flush, FLUSH_DELAY_MS);
    }, [flush, user?.user_id]);

    useEffect(() => {
        authGenerationRef.current += 1;
        cacheRef.current.clear();
        pendingRef.current.clear();
        if (flushTimerRef.current != null) clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
        if (user?.user_id) {
            for (const eventId of refCountRef.current.keys()) pendingRef.current.add(eventId);
            scheduleFlush();
        }
        setVersion((current) => current + 1);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user?.user_id]);

    const register = useCallback((eventId: string) => {
        refCountRef.current.set(eventId, (refCountRef.current.get(eventId) ?? 0) + 1);
        if (user?.user_id && !cacheRef.current.has(eventId)) {
            pendingRef.current.add(eventId);
            scheduleFlush();
        }
        return () => {
            const count = refCountRef.current.get(eventId) ?? 0;
            if (count <= 1) refCountRef.current.delete(eventId);
            else refCountRef.current.set(eventId, count - 1);
        };
    }, [scheduleFlush, user?.user_id]);

    const get = useCallback((eventId: string) => cacheRef.current.get(eventId), []);
    const set = useCallback((eventId: string, count: number) => {
        if (cacheRef.current.get(eventId) === count) return;
        cacheRef.current.set(eventId, count);
        setVersion((current) => current + 1);
    }, []);
    const value = useMemo(() => ({ register, get, set, version }), [get, register, set, version]);
    return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMyPlanCount(eventId: string | null | undefined): number | undefined {
    const ctx = useContext(Ctx);
    if (!ctx) throw new Error('useMyPlanCount must be used within MyPlanCountProvider');
    useEffect(() => {
        if (!eventId) return;
        return ctx.register(eventId);
    }, [ctx, eventId]);
    if (!eventId) return undefined;
    void ctx.version;
    return ctx.get(eventId);
}

export function useSetMyPlanCount(): (eventId: string, count: number) => void {
    const ctx = useContext(Ctx);
    return ctx?.set ?? noop;
}

function noop() { }
