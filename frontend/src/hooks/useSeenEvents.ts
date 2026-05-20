import { useCallback, useEffect, useState } from 'react';

// localStorage key for per-viewer "seen" event ids. The Unseen state UI
// (dot + bolder title on cards, "Unseen only" filter chip, header
// counter) treats anything NOT in this set as unseen. The feature is
// first-class anonymous: no server-side state, no DB writes.
const STORAGE_KEY = 'seen_events';

function readSeen(): Set<string> {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return new Set();
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return new Set();
        return new Set(parsed.filter((x): x is string => typeof x === 'string'));
    } catch {
        return new Set();
    }
}

function writeSeen(set: Set<string>): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
    } catch {
        // localStorage may be unavailable (private mode, quota): degrade
        // silently — the in-memory set still drives the current session.
    }
}

export interface SeenEventsApi {
    seen: Set<string>;
    isSeen: (eventId: string) => boolean;
    markSeen: (eventId: string) => void;
}

export function useSeenEvents(): SeenEventsApi {
    const [seen, setSeen] = useState<Set<string>>(() => readSeen());

    // Cross-tab sync: pick up writes from other tabs/windows so the
    // counter and dots stay consistent.
    useEffect(() => {
        const onStorage = (e: StorageEvent) => {
            if (e.key === STORAGE_KEY) setSeen(readSeen());
        };
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, []);

    const markSeen = useCallback((eventId: string) => {
        setSeen((prev) => {
            if (prev.has(eventId)) return prev;
            const next = new Set(prev);
            next.add(eventId);
            writeSeen(next);
            return next;
        });
    }, []);

    const isSeen = useCallback((eventId: string) => seen.has(eventId), [seen]);

    return { seen, isSeen, markSeen };
}
