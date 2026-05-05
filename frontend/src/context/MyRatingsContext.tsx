import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { fetchMyRatings } from '../api';
import type { EventRating, MyRating } from '../types';
import { useAuth } from './AuthContext';

interface Ctx {
    get: (eventId: string) => MyRating | null;
    /** Called by RateEventModal after submit/edit/delete to keep the store in sync. */
    upsert: (eventId: string, rating: EventRating | null) => void;
    loaded: boolean;
}

const MyRatingsCtx = createContext<Ctx | null>(null);

function toMyRating(eventId: string, r: EventRating): MyRating {
    return {
        id: r.id,
        event_id: eventId,
        event_title: null,
        event_start: null,
        stars: r.stars,
        comment: r.comment,
        review_tag_ids: r.review_tag_ids ?? [],
        is_anonymous: r.is_anonymous,
        status: r.status,
        created_at: r.created_at,
        updated_at: r.updated_at,
    };
}

export function MyRatingsProvider({ children }: { children: ReactNode }) {
    const { user } = useAuth();
    const [byEventId, setByEventId] = useState<Map<string, MyRating>>(new Map());
    const [loaded, setLoaded] = useState(false);

    useEffect(() => {
        if (!user) {
            setByEventId(new Map());
            setLoaded(true);
            return;
        }
        setLoaded(false);
        fetchMyRatings()
            .then((items) => {
                const m = new Map<string, MyRating>();
                for (const r of items) m.set(r.event_id, r);
                setByEventId(m);
            })
            .catch(() => setByEventId(new Map()))
            .finally(() => setLoaded(true));
    }, [user?.user_id]); // eslint-disable-line react-hooks/exhaustive-deps

    const get = useCallback((eventId: string) => byEventId.get(eventId) ?? null, [byEventId]);

    const upsert = useCallback((eventId: string, rating: EventRating | null) => {
        setByEventId((prev) => {
            const next = new Map(prev);
            if (rating == null) next.delete(eventId);
            else next.set(eventId, toMyRating(eventId, rating));
            return next;
        });
    }, []);

    const value = useMemo<Ctx>(() => ({ get, upsert, loaded }), [get, upsert, loaded]);
    return <MyRatingsCtx.Provider value={value}>{children}</MyRatingsCtx.Provider>;
}

export function useMyRating(eventId: string | null | undefined): MyRating | null {
    const ctx = useContext(MyRatingsCtx);
    if (!ctx || !eventId) return null;
    return ctx.get(eventId);
}

export function useUpsertMyRating(): (eventId: string, rating: EventRating | null) => void {
    const ctx = useContext(MyRatingsCtx);
    return ctx?.upsert ?? (() => { /* no-op */ });
}
