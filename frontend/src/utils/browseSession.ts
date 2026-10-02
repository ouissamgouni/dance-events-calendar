import type { SearchArea } from './searchArea';

export type BrowseAreaOverride =
    | { kind: 'show-all' }
    | { kind: 'preset'; area: SearchArea }
    | null;

interface BrowseSessionSnapshot {
    v: 1;
    search: string;
    area: BrowseAreaOverride;
    savedAt: number;
}

const STORAGE_KEY = 'movida:browse-filters';
export const BROWSE_SESSION_IDLE_MS = 30 * 60 * 1000;

export const BROWSE_FILTER_KEYS = [
    'start_date',
    'end_date',
    'tag_ids',
    'interest_source',
    'interest_kind',
    'interest_match',
    'interest_user_handle',
    'sort_by',
    'reach',
    'discount',
] as const;

export function hasBrowseFilterParams(params: URLSearchParams): boolean {
    return BROWSE_FILTER_KEYS.some((key) => params.has(key));
}

export function pickBrowseFilterParams(params: URLSearchParams): URLSearchParams {
    const picked = new URLSearchParams();
    for (const key of BROWSE_FILTER_KEYS) {
        for (const value of params.getAll(key)) picked.append(key, value);
    }
    return picked;
}

function todayIso(now: Date): string {
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function dropPastDates(params: URLSearchParams, now: Date): void {
    const today = todayIso(now);
    const end = params.get('end_date');
    if (end && end < today) {
        params.delete('start_date');
        params.delete('end_date');
        return;
    }
    const start = params.get('start_date');
    if (start && start < today) params.delete('start_date');
}

export function saveBrowseSession(params: URLSearchParams, area: BrowseAreaOverride, now = Date.now()): void {
    const snapshot: BrowseSessionSnapshot = {
        v: 1,
        search: pickBrowseFilterParams(params).toString(),
        area,
        savedAt: now,
    };
    try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    } catch { /* storage full or disabled: restoring is best-effort */ }
}

export function readBrowseSession(now = Date.now()): { params: URLSearchParams; area: BrowseAreaOverride } | null {
    let snapshot: BrowseSessionSnapshot;
    try {
        const raw = sessionStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        snapshot = JSON.parse(raw) as BrowseSessionSnapshot;
    } catch {
        return null;
    }
    if (snapshot?.v !== 1 || typeof snapshot.search !== 'string' || typeof snapshot.savedAt !== 'number') return null;
    if (now - snapshot.savedAt > BROWSE_SESSION_IDLE_MS) {
        clearBrowseSession();
        return null;
    }
    const params = pickBrowseFilterParams(new URLSearchParams(snapshot.search));
    dropPastDates(params, new Date(now));
    const area = snapshot.area?.kind === 'show-all' || snapshot.area?.kind === 'preset' ? snapshot.area : null;
    return { params, area };
}

export function touchBrowseSession(now = Date.now()): void {
    const current = readBrowseSession(now);
    if (current) saveBrowseSession(current.params, current.area, now);
}

export function clearBrowseSession(): void {
    try {
        sessionStorage.removeItem(STORAGE_KEY);
    } catch { /* ignore */ }
}
