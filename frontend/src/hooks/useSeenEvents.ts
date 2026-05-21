import { useCallback, useEffect, useMemo, useState } from 'react';

const STORAGE_KEY = 'new_events_state_v1';
const LEGACY_SEEN_KEY = 'seen_events';

interface StoredNewEventsState {
    known_event_ids?: unknown;
}

function stringsOnly(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
}

function readKnown(): Set<string> {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) {
            const legacyRaw = localStorage.getItem(LEGACY_SEEN_KEY);
            if (!legacyRaw) return new Set();
            return new Set(stringsOnly(JSON.parse(legacyRaw)));
        }
        const parsed = JSON.parse(raw);
        return new Set(stringsOnly((parsed as StoredNewEventsState).known_event_ids));
    } catch {
        return new Set();
    }
}

function hasStoredState(): boolean {
    try {
        return localStorage.getItem(STORAGE_KEY) !== null;
    } catch {
        return false;
    }
}

function writeKnown(set: Set<string>): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ known_event_ids: [...set] }));
    } catch {
        // localStorage may be unavailable (private mode, quota): degrade
        // silently — the in-memory set still drives the current session.
    }
}

export interface SeenEventsApi {
    newEventIds: Set<string>;
    isNew: (eventId: string) => boolean;
    markSeen: (eventId: string) => void;
}

export function useSeenEvents(eventIds: string[] = []): SeenEventsApi {
    const [known, setKnown] = useState<Set<string>>(() => readKnown());
    const baselineReady = hasStoredState();

    useEffect(() => {
        if (hasStoredState()) return;
        if (eventIds.length === 0) return;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- initialize localStorage baseline after async event inventory arrives
        setKnown((prev) => {
            const next = new Set([...prev, ...eventIds]);
            writeKnown(next);
            return next;
        });
    }, [eventIds]);

    // Cross-tab sync: pick up writes from other tabs/windows so the
    // counter and dots stay consistent.
    useEffect(() => {
        const onStorage = (e: StorageEvent) => {
            if (e.key === STORAGE_KEY || e.key === LEGACY_SEEN_KEY) {
                setKnown(readKnown());
            }
        };
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, []);

    const markSeen = useCallback((eventId: string) => {
        setKnown((prev) => {
            if (prev.has(eventId)) return prev;
            const next = new Set(prev);
            next.add(eventId);
            writeKnown(next);
            return next;
        });
    }, []);

    const newEventIds = useMemo(
        () => baselineReady ? new Set(eventIds.filter((eventId) => !known.has(eventId))) : new Set<string>(),
        [baselineReady, eventIds, known],
    );
    const isNew = useCallback((eventId: string) => newEventIds.has(eventId), [newEventIds]);

    return { newEventIds, isNew, markSeen };
}
