/**
 * Centralised admin badge counters.
 *
 * Loads the four counters (pending review, ungeolocated, tag suggestions,
 * feedback) and exposes a `refresh()` callback. Refreshes automatically on:
 *   - Initial mount
 *   - `includePast` admin pref toggle
 *   - Window focus / tab visibility change (cheap when admin tab is open)
 *   - Whenever any code dispatches a `window` `admin:data-changed` CustomEvent
 *     (used by detail panels after save / delete / sync completion)
 *
 * This replaces the previous one-shot useEffect in Admin.tsx so badges stay
 * in sync with the current state of the DB without a full page reload.
 */

import { useCallback, useEffect, useState } from 'react';

import { fetchAdminRatings, fetchAdminTagSuggestions, fetchEventFilterOptions } from '../api';
import { useAdminPrefs } from '../context/AdminPrefsContext';

export interface AdminCounters {
    pendingReview: number;
    ungeolocated: number;
    tagSuggestions: number;
    feedbackPending: number;
}

const ZERO: AdminCounters = {
    pendingReview: 0,
    ungeolocated: 0,
    tagSuggestions: 0,
    feedbackPending: 0,
};

/**
 * Fire this anywhere admin data has just changed so all subscribed counter
 * panels refresh. Safe to call from any component, no provider needed.
 */
export function notifyAdminDataChanged(): void {
    try {
        window.dispatchEvent(new CustomEvent('admin:data-changed'));
    } catch {
        /* SSR / no-window — nothing to do */
    }
}

export function useAdminCounters(): { counters: AdminCounters; refresh: () => void } {
    const { includePast } = useAdminPrefs();
    const [counters, setCounters] = useState<AdminCounters>(ZERO);

    const refresh = useCallback(() => {
        // Each call is fire-and-forget; failures keep the last known value
        // rather than zeroing out (avoids the badge flickering to 0 on a
        // transient network blip).
        fetchEventFilterOptions(includePast ? { include_past: true } : {})
            .then((opts) => {
                setCounters((prev) => ({
                    ...prev,
                    pendingReview:
                        opts.review_statuses.find((s) => s.value === 'pending')?.count ?? 0,
                    ungeolocated:
                        opts.geo_statuses.find((s) => s.value === 'ungeolocated')?.count ?? 0,
                }));
            })
            .catch(() => undefined);

        fetchAdminTagSuggestions({
            status: 'pending',
            includePast: includePast || undefined,
        })
            .then((rows) =>
                setCounters((prev) => ({ ...prev, tagSuggestions: rows.length })),
            )
            .catch(() => undefined);

        fetchAdminRatings({ status: 'pending', page: 1, pageSize: 1 })
            .then((res) =>
                setCounters((prev) => ({ ...prev, feedbackPending: res.total })),
            )
            .catch(() => undefined);
    }, [includePast]);

    // Initial load + refresh whenever the include-past pref changes.
    useEffect(() => {
        refresh();
    }, [refresh]);

    // Refresh on tab visibility change & on data-change events from anywhere.
    useEffect(() => {
        const onVisibility = () => {
            if (document.visibilityState === 'visible') refresh();
        };
        const onFocus = () => refresh();
        const onChanged = () => refresh();
        document.addEventListener('visibilitychange', onVisibility);
        window.addEventListener('focus', onFocus);
        window.addEventListener('admin:data-changed', onChanged as EventListener);
        return () => {
            document.removeEventListener('visibilitychange', onVisibility);
            window.removeEventListener('focus', onFocus);
            window.removeEventListener('admin:data-changed', onChanged as EventListener);
        };
    }, [refresh]);

    return { counters, refresh };
}
