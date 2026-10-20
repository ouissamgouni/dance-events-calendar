import { useEffect, useState } from 'react';
import { fetchMyPendingReviews } from '../api';
import { useAuth } from '../context/AuthContext';

// One shared fetch per user for every badge on screen; reviews invalidate it.
let cache: { userId: string; count: Promise<number> } | null = null;
const listeners = new Set<() => void>();

export function refreshPendingReviewCount(): void {
    cache = null;
    listeners.forEach((listener) => listener());
}

function loadCount(userId: string): Promise<number> {
    if (cache?.userId !== userId) {
        cache = { userId, count: fetchMyPendingReviews().then((rows) => rows.length).catch(() => 0) };
    }
    return cache.count;
}

/** Attended-but-unreviewed events (same list as the "Share your experience" rail). */
export function usePendingReviewCount(): number {
    const { user } = useAuth();
    const userId = user?.user_id ?? null;
    const [state, setState] = useState<{ userId: string | null; count: number }>({ userId: null, count: 0 });
    const [version, setVersion] = useState(0);

    useEffect(() => {
        const listener = () => setVersion((v) => v + 1);
        listeners.add(listener);
        return () => { listeners.delete(listener); };
    }, []);

    useEffect(() => {
        if (!userId) return;
        let cancelled = false;
        loadCount(userId).then((count) => {
            if (!cancelled) setState({ userId, count });
        });
        return () => { cancelled = true; };
    }, [userId, version]);

    return userId && state.userId === userId ? state.count : 0;
}
