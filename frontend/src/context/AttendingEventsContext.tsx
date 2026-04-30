import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { trackAttendance } from '../utils/tracking';

const STORAGE_KEY = 'movida_attending_events';

interface AttendingEventsContextValue {
    attendingEventIds: string[];
    attendingCount: number;
    isAttending: (eventId: string) => boolean;
    toggleAttending: (eventId: string) => void;
}

const AttendingEventsContext = createContext<AttendingEventsContextValue | null>(null);

function readFromStorage(): Set<string> {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const arr = JSON.parse(raw);
            if (Array.isArray(arr)) return new Set(arr.filter((x: unknown) => typeof x === 'string'));
        }
    } catch { /* ignore corrupt data */ }
    return new Set();
}

function writeToStorage(ids: Set<string>) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
}

export function AttendingEventsProvider({ children }: { children: ReactNode }) {
    const [attendingIds, setAttendingIds] = useState<Set<string>>(() => readFromStorage());

    useEffect(() => {
        writeToStorage(attendingIds);
    }, [attendingIds]);

    const toggleAttending = useCallback((eventId: string) => {
        setAttendingIds((prev) => {
            const next = new Set(prev);
            if (next.has(eventId)) {
                next.delete(eventId);
            } else {
                next.add(eventId);
            }
            return next;
        });
        // Side effect outside the updater — safe under StrictMode double-invoke
        const action = attendingIds.has(eventId) ? 'not_going' : 'going';
        trackAttendance(eventId, action);
    }, [attendingIds]);

    const isAttending = useCallback((eventId: string) => attendingIds.has(eventId), [attendingIds]);

    const value = useMemo<AttendingEventsContextValue>(() => ({
        attendingEventIds: [...attendingIds],
        attendingCount: attendingIds.size,
        isAttending,
        toggleAttending,
    }), [attendingIds, isAttending, toggleAttending]);

    return (
        <AttendingEventsContext.Provider value={value}>
            {children}
        </AttendingEventsContext.Provider>
    );
}

export function useAttendingEvents(): AttendingEventsContextValue {
    const ctx = useContext(AttendingEventsContext);
    if (!ctx) throw new Error('useAttendingEvents must be used within AttendingEventsProvider');
    return ctx;
}
