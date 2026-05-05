import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { trackSave } from '../utils/tracking';
import { useAuth } from './AuthContext';
import { fetchMySavedEventIds } from '../api';

const STORAGE_KEY = 'movida_saved_events';

interface SavedEventsContextValue {
    savedEventIds: string[];
    savedCount: number;
    isSaved: (eventId: string) => boolean;
    toggleSave: (eventId: string) => void;
    clearAll: () => void;
}

const SavedEventsContext = createContext<SavedEventsContextValue | null>(null);

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

export function SavedEventsProvider({ children }: { children: ReactNode }) {
    const [savedIds, setSavedIds] = useState<Set<string>>(() => readFromStorage());
    const { user } = useAuth();
    const lastSyncedUserId = useRef<string | null | undefined>(undefined);

    useEffect(() => {
        writeToStorage(savedIds);
    }, [savedIds]);

    // On sign-in: union server-side saved events into local state. We never
    // wipe local saves on sign-out: bookmarks are not sensitive data and the
    // signed-out device just becomes anonymous again. The device_id rotates
    // on logout (see AuthContext) so a different user signing in next can't
    // inherit this device's anonymous bookmarks.
    useEffect(() => {
        const currentUserKey = user?.user_id ?? user?.email ?? null;
        const previous = lastSyncedUserId.current;
        if (previous === currentUserKey) return;
        lastSyncedUserId.current = currentUserKey;
        if (!user) return;
        fetchMySavedEventIds()
            .then((serverIds) => {
                if (!serverIds.length) return;
                setSavedIds((prev) => {
                    const next = new Set(prev);
                    for (const id of serverIds) next.add(id);
                    return next;
                });
            })
            .catch(() => { /* offline / no consent — ignore */ });
    }, [user]);

    const toggleSave = useCallback((eventId: string) => {
        setSavedIds((prev) => {
            const next = new Set(prev);
            if (next.has(eventId)) {
                next.delete(eventId);
            } else {
                next.add(eventId);
            }
            return next;
        });
        // Side effect outside the updater — safe under StrictMode double-invoke
        const action = savedIds.has(eventId) ? 'unsave' : 'save';
        trackSave(eventId, action);
    }, [savedIds]);

    const isSaved = useCallback((eventId: string) => savedIds.has(eventId), [savedIds]);

    const clearAll = useCallback(() => {
        // Track unsave for each (consent-gated)
        savedIds.forEach((id) => {
            trackSave(id, 'unsave');
        });
        setSavedIds(new Set());
    }, [savedIds]);

    const value = useMemo<SavedEventsContextValue>(() => ({
        savedEventIds: [...savedIds],
        savedCount: savedIds.size,
        isSaved,
        toggleSave,
        clearAll,
    }), [savedIds, isSaved, toggleSave, clearAll]);

    return (
        <SavedEventsContext.Provider value={value}>
            {children}
        </SavedEventsContext.Provider>
    );
}

export function useSavedEvents(): SavedEventsContextValue {
    const ctx = useContext(SavedEventsContext);
    if (!ctx) throw new Error('useSavedEvents must be used within SavedEventsProvider');
    return ctx;
}
