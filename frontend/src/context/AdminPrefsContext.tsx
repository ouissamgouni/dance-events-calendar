/**
 * Admin-wide preferences shared across the admin panels.
 *
 * Currently exposes a single switch — `includePast` — that controls whether
 * admin listings and counters include events that have already finished.
 * The default is "upcoming only" because that matches how admins actually
 * curate the calendar (past events are bookkeeping, not work).
 *
 * Persisted in localStorage so the choice survives page reloads.
 */

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
    type ReactNode,
} from 'react';

const STORAGE_KEY = 'admin.includePast';

interface AdminPrefsValue {
    includePast: boolean;
    setIncludePast: (value: boolean) => void;
    toggleIncludePast: () => void;
}

const AdminPrefsContext = createContext<AdminPrefsValue | null>(null);

export function AdminPrefsProvider({ children }: { children: ReactNode }) {
    const [includePast, setIncludePastState] = useState<boolean>(() => {
        try {
            return localStorage.getItem(STORAGE_KEY) === 'true';
        } catch {
            return false;
        }
    });

    useEffect(() => {
        try {
            localStorage.setItem(STORAGE_KEY, includePast ? 'true' : 'false');
        } catch {
            /* ignore quota/private-mode errors */
        }
    }, [includePast]);

    const setIncludePast = useCallback((value: boolean) => {
        setIncludePastState(value);
    }, []);

    const toggleIncludePast = useCallback(() => {
        setIncludePastState((v) => !v);
    }, []);

    const value = useMemo(
        () => ({ includePast, setIncludePast, toggleIncludePast }),
        [includePast, setIncludePast, toggleIncludePast],
    );

    return <AdminPrefsContext.Provider value={value}>{children}</AdminPrefsContext.Provider>;
}

/**
 * Read admin preferences. Falls back to a sensible default (upcoming-only)
 * if no provider is mounted, so component tests don't need to wrap.
 */
export function useAdminPrefs(): AdminPrefsValue {
    const ctx = useContext(AdminPrefsContext);
    if (ctx) return ctx;
    return {
        includePast: false,
        setIncludePast: () => undefined,
        toggleIncludePast: () => undefined,
    };
}
