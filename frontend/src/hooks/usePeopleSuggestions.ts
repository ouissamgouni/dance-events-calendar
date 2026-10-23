import { useCallback, useEffect, useState } from 'react';
import {
    dismissSuggestion,
    fetchMySuggestions,
    followUser,
    type FoFSuggestionItem,
} from '../api';

export const PEOPLE_TRAIL_SIZE = 5;

/**
 * Top "people you may know" for the For You trail and Home sheet. Fetches one
 * extra row so "See all" knows there is more; after a follow or "Not
 * interested" the server-side pool already excludes that person, so a plain
 * refetch backfills the gap with the next candidate.
 */
export function usePeopleSuggestions(enabled: boolean) {
    const [items, setItems] = useState<FoFSuggestionItem[] | null>(null);
    const [total, setTotal] = useState(0);
    const [trailPosition, setTrailPosition] = useState<'top' | 'bottom'>('bottom');
    const [pending, setPending] = useState<string | null>(null);

    useEffect(() => {
        if (!enabled) return;
        let cancelled = false;
        const refresh = () => {
            fetchMySuggestions({ limit: PEOPLE_TRAIL_SIZE + 1 })
                .then((r) => {
                    if (cancelled) return;
                    setItems(r.items);
                    setTotal(r.total);
                    setTrailPosition(r.trail_position ?? 'bottom');
                })
                .catch(() => {
                    if (cancelled) return;
                    setItems([]);
                    setTotal(0);
                });
        };
        refresh();
        window.addEventListener('network:changed', refresh);
        return () => {
            cancelled = true;
            window.removeEventListener('network:changed', refresh);
        };
    }, [enabled]);

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
        items: items?.slice(0, PEOPLE_TRAIL_SIZE) ?? null,
        total,
        trailPosition,
        pending,
        follow,
        dismiss,
    };
}
