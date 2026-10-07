import { useEffect, useState } from 'react';
import { CONFIGURABLE_COLUMNS } from './adminEventColumns';

export interface ConfigurableColumn {
    id: string;
    label: string;
    defaultHidden: boolean;
}

export interface AdminEventsTablePrefs {
    /** Configurable column ids in display order (pinned columns excluded). */
    order: string[];
    hidden: string[];
    sizing: Record<string, number>;
}

export function defaultTablePrefs(columns: ConfigurableColumn[] = CONFIGURABLE_COLUMNS): AdminEventsTablePrefs {
    return {
        order: columns.map((c) => c.id),
        hidden: columns.filter((c) => c.defaultHidden).map((c) => c.id),
        sizing: {},
    };
}

/** Drops unknown ids and slots columns added since the prefs were saved at their default spot. */
export function sanitizeTablePrefs(raw: unknown, columns: ConfigurableColumn[] = CONFIGURABLE_COLUMNS): AdminEventsTablePrefs {
    const defaults = defaultTablePrefs(columns);
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

function read(key: string, columns: ConfigurableColumn[]): AdminEventsTablePrefs | null {
    try {
        const raw = localStorage.getItem(key);
        return raw ? sanitizeTablePrefs(JSON.parse(raw), columns) : null;
    } catch {
        return null;
    }
}

function write(key: string, value: AdminEventsTablePrefs): void {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // Storage full or disabled: prefs just won't persist.
    }
}

/** Column layout persisted per table, plus an optional user-saved default that Reset returns to. */
export function useAdminTablePrefs(storageKey: string, columns: ConfigurableColumn[]) {
    const defaultKey = `${storageKey}:default`;
    const [prefs, setPrefs] = useState<AdminEventsTablePrefs>(() => read(storageKey, columns) ?? defaultTablePrefs(columns));
    const [userDefault, setUserDefault] = useState<AdminEventsTablePrefs | null>(() => read(defaultKey, columns));
    useEffect(() => write(storageKey, prefs), [storageKey, prefs]);
    const saveAsDefault = () => {
        setUserDefault(prefs);
        write(defaultKey, prefs);
    };
    const factoryReset = () => {
        setUserDefault(null);
        localStorage.removeItem(defaultKey);
        setPrefs(defaultTablePrefs(columns));
    };
    const target = userDefault ?? defaultTablePrefs(columns);
    return {
        prefs,
        setPrefs,
        reset: () => setPrefs(target),
        saveAsDefault,
        factoryReset,
        hasUserDefault: userDefault !== null,
        isDefault: JSON.stringify(prefs) === JSON.stringify(target),
    };
}

export default function useAdminEventsTablePrefs() {
    return useAdminTablePrefs('admin:events-table:v1', CONFIGURABLE_COLUMNS);
}
