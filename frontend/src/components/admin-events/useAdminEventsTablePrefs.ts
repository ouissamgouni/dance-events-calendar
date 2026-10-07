import { useEffect, useState } from 'react';
import { CONFIGURABLE_COLUMNS } from './adminEventColumns';

const STORAGE_KEY = 'admin:events-table:v1';

export interface AdminEventsTablePrefs {
    /** Configurable column ids in display order (pinned columns excluded). */
    order: string[];
    hidden: string[];
    sizing: Record<string, number>;
}

export function defaultTablePrefs(): AdminEventsTablePrefs {
    return {
        order: CONFIGURABLE_COLUMNS.map((c) => c.id),
        hidden: CONFIGURABLE_COLUMNS.filter((c) => c.defaultHidden).map((c) => c.id),
        sizing: {},
    };
}

/** Drops unknown ids and slots columns added since the prefs were saved at their default spot. */
export function sanitizeTablePrefs(raw: unknown): AdminEventsTablePrefs {
    const defaults = defaultTablePrefs();
    if (!raw || typeof raw !== 'object') return defaults;
    const value = raw as Partial<AdminEventsTablePrefs>;
    const known = new Set(defaults.order);
    const saved = Array.isArray(value.order) ? value.order.filter((id) => known.has(id)) : [];
    const order = [...saved];
    defaults.order.forEach((id, index) => {
        if (order.includes(id)) return;
        const before = defaults.order.slice(0, index).reverse().find((prev) => order.includes(prev));
        order.splice(before ? order.indexOf(before) + 1 : 0, 0, id);
    });
    const savedSet = new Set(saved);
    const hidden = [
        ...(Array.isArray(value.hidden) ? value.hidden.filter((id) => known.has(id)) : []),
        ...defaults.hidden.filter((id) => !savedSet.has(id)),
    ];
    const sizing: Record<string, number> = {};
    if (value.sizing && typeof value.sizing === 'object') {
        for (const [id, size] of Object.entries(value.sizing)) {
            if (typeof size === 'number' && size > 0) sizing[id] = size;
        }
    }
    return { order, hidden: [...new Set(hidden)], sizing };
}

function load(): AdminEventsTablePrefs {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return sanitizeTablePrefs(raw ? JSON.parse(raw) : null);
    } catch {
        return defaultTablePrefs();
    }
}

export default function useAdminEventsTablePrefs() {
    const [prefs, setPrefs] = useState<AdminEventsTablePrefs>(load);
    useEffect(() => {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
        } catch {
            // Storage full or disabled: prefs just won't persist.
        }
    }, [prefs]);
    return { prefs, setPrefs, reset: () => setPrefs(defaultTablePrefs()) };
}
