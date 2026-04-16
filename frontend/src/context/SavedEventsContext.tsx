import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { trackEventSave } from '../api';
import { getDeviceId } from '../utils/deviceId';

const STORAGE_KEY = 'salsa_saved_events';

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

    useEffect(() => {
        writeToStorage(savedIds);
    }, [savedIds]);

    const toggleSave = useCallback((eventId: string) => {
        setSavedIds((prev) => {
            const next = new Set(prev);
            const action = next.has(eventId) ? 'unsave' : 'save';
            if (action === 'unsave') {
                next.delete(eventId);
            } else {
                next.add(eventId);
            }
            // Fire-and-forget server tracking
            trackEventSave(eventId, getDeviceId(), action as 'save' | 'unsave').catch(() => { });
            return next;
        });
    }, []);

    const isSaved = useCallback((eventId: string) => savedIds.has(eventId), [savedIds]);

    const clearAll = useCallback(() => {
        // Track unsave for each
        const deviceId = getDeviceId();
        savedIds.forEach((id) => {
            trackEventSave(id, deviceId, 'unsave').catch(() => { });
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
