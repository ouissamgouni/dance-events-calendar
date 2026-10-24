import { useCallback, useEffect, useRef, useState } from 'react';
import {
    dismissSuggestion,
    fetchMySuggestions,
    followUser,
    type FoFSuggestionItem,
} from '../api';

/**
 * "People you may know" trail (For You, Home sheet, People page). The server
 * caps each page to the admin trail size; `refresh` reshuffles the pool.
 * After a follow or "Not interested" the server-side pool already excludes
 * that person, so a plain refetch backfills the gap with the next candidate.
 */
export function usePeopleSuggestions(enabled: boolean) {
    const [items, setItems] = useState<FoFSuggestionItem[] | null>(null);
    const [total, setTotal] = useState(0);
    const [trailSize, setTrailSize] = useState(0);
    const [trailPosition, setTrailPosition] = useState<'top' | 'bottom'>('bottom');
    const [pending, setPending] = useState<string | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const seedRef = useRef<number | undefined>(undefined);
    const requestRef = useRef(0);

    const load = useCallback(async (seed: number | undefined) => {
        const id = ++requestRef.current;
        const r = await fetchMySuggestions({ trail: true, seed });
        if (id !== requestRef.current) return;
        seedRef.current = seed;
        setItems(r.items);
        setTotal(r.total);
        setTrailSize(r.trail_size ?? r.items.length);
        setTrailPosition(r.trail_position ?? 'bottom');
    }, []);

    useEffect(() => {
        if (!enabled) return;
        const refetch = () => {
            load(seedRef.current).catch(() => {
                setItems([]);
                setTotal(0);
            });
        };
        refetch();
        window.addEventListener('network:changed', refetch);
        return () => {
            requestRef.current += 1;
            window.removeEventListener('network:changed', refetch);
        };
    }, [enabled, load]);

    const canRefresh = trailSize > 0 && total > trailSize;
    const refresh = useCallback(async () => {
        if (!canRefresh || refreshing) return;
        setRefreshing(true);
        try {
            await load(Math.floor(Math.random() * 2 ** 31));
        } catch {
            /* keep the current page on failure */
        } finally {
            setRefreshing(false);
        }
    }, [canRefresh, refreshing, load]);

    const remove = useCallback(
        async (handle: string, action: (h: string) => Promise<unknown>) => {
            setPending(handle);
            try {
                await action(handle);
                setItems((prev) => prev?.filter((it) => it.handle !== handle) ?? prev);
                setTotal((t) => Math.max(0, t - 1));
            } finally {
                setPending(null);
            }
        },
        [],
    );

    // Listeners (this hook included) refetch to backfill the freed slot.
    const follow = useCallback(async (handle: string) => {
        await remove(handle, followUser);
        window.dispatchEvent(new CustomEvent('network:changed'));
    }, [remove]);

    const dismiss = useCallback(async (handle: string) => {
        await remove(handle, dismissSuggestion);
        window.dispatchEvent(new CustomEvent('network:changed'));
    }, [remove]);

    return {
        items,
        total,
        trailPosition,
        pending,
        follow,
        dismiss,
        refresh: canRefresh ? refresh : undefined,
        refreshing,
    };
}
