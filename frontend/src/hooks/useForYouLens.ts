import { useCallback, useEffect, useRef, useState } from 'react';
import type { CalendarEvent } from '../types';
import { fetchEventsPage } from '../api';

interface ForYouLensFetchArgs {
    startDate?: string;
    endDate?: string;
    area?: { min_lat: number; min_lng: number; max_lat: number; max_lng: number } | null;
    interestSource?: 'follows' | 'friends';
    interestKind?: 'any' | 'going' | 'saved';
    profiles?: 'me';
}

interface UseForYouLensOptions {
    enabled: boolean;
    fetchArgs: ForYouLensFetchArgs;
    /** Serialized cache-buster: change to force a fresh offset=0 fetch. */
    resetKey: string;
    /** Rows requested from the server per call. */
    serverBatchSize?: number;
}

export interface UseForYouLensResult {
    events: CalendarEvent[];
    hasMore: boolean;
    loading: boolean;
    loadMore: () => Promise<void>;
}

/**
 * Server-paginated fetch for a single For-you rail lens. Each call to
 * ``loadMore`` issues one real ``GET /events?offset=…`` request and
 * appends the returned rows to ``events``. ``hasMore`` mirrors the
 * backend's ``X-Has-More`` header so the "+more" affordance can be
 * hidden once the underlying page stream is exhausted.
 */
export function useForYouLens(options: UseForYouLensOptions): UseForYouLensResult {
    const { enabled, fetchArgs, resetKey, serverBatchSize = 20 } = options;
    const [events, setEvents] = useState<CalendarEvent[]>([]);
    const [hasMore, setHasMore] = useState(false);
    const [loading, setLoading] = useState(false);
    const offsetRef = useRef(0);
    // Guards against stale async completions from a previous ``resetKey``
    // clobbering fresh state (e.g. user changes preferred area mid-fetch).
    const activeKeyRef = useRef(resetKey);
    const fetchArgsRef = useRef(fetchArgs);
    fetchArgsRef.current = fetchArgs;

    const fetchAt = useCallback(async (offset: number, keyAtCall: string) => {
        setLoading(true);
        try {
            const { events: page, hasMore: pageHasMore } = await fetchEventsPage({
                ...fetchArgsRef.current,
                limit: serverBatchSize,
                offset,
            });
            if (activeKeyRef.current !== keyAtCall) return;
            setEvents((prev) => (offset === 0 ? page : [...prev, ...page]));
            setHasMore(pageHasMore);
            offsetRef.current = offset + page.length;
        } catch {
            if (activeKeyRef.current !== keyAtCall) return;
            setHasMore(false);
        } finally {
            if (activeKeyRef.current === keyAtCall) setLoading(false);
        }
    }, [serverBatchSize]);

    useEffect(() => {
        activeKeyRef.current = resetKey;
        offsetRef.current = 0;
        setEvents([]);
        setHasMore(false);
        setLoading(false);
        if (!enabled) return;
        fetchAt(0, resetKey);
    }, [enabled, resetKey, fetchAt]);

    const loadMore = useCallback(async () => {
        if (!enabled || loading || !hasMore) return;
        await fetchAt(offsetRef.current, activeKeyRef.current);
    }, [enabled, loading, hasMore, fetchAt]);

    return { events, hasMore, loading, loadMore };
}
