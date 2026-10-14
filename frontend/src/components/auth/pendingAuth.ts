import type { SignInIntent } from './signInIntent';

export interface PendingAuthAction {
    kind: 'save' | 'going';
    eventId: string;
    eventTitle?: string;
    isPast?: boolean;
}

export interface PendingAuth {
    intent: SignInIntent;
    action?: PendingAuthAction;
    /** pathname + search + hash of the page the guest was on. */
    returnTo: string;
    scrollTop: number;
    createdAt: number;
}

const KEY = 'movida.pendingAuth.v1';
export const PENDING_AUTH_TTL_MS = 30 * 60 * 1000;

export function savePendingAuth(pending: Omit<PendingAuth, 'createdAt'>, now = Date.now()): void {
    try {
        sessionStorage.setItem(KEY, JSON.stringify({ ...pending, createdAt: now }));
    } catch { /* storage disabled — resume is best-effort */ }
}

export function readPendingAuth(now = Date.now()): PendingAuth | null {
    try {
        const raw = sessionStorage.getItem(KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as PendingAuth;
        if (typeof parsed?.returnTo !== 'string' || typeof parsed.createdAt !== 'number') return null;
        if (now - parsed.createdAt > PENDING_AUTH_TTL_MS) {
            sessionStorage.removeItem(KEY);
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

export function updatePendingAuth(patch: Partial<Omit<PendingAuth, 'createdAt'>>): void {
    const current = readPendingAuth();
    if (!current) return;
    try {
        sessionStorage.setItem(KEY, JSON.stringify({ ...current, ...patch }));
    } catch { /* ignore */ }
}

export function clearPendingAuth(): void {
    try {
        sessionStorage.removeItem(KEY);
    } catch { /* ignore */ }
}

/** The app's only scroll container is <main> (see index.css #root). */
export function currentScrollTop(): number {
    return document.querySelector('main')?.scrollTop ?? 0;
}

/** Path + query only: overlays may rewrite the hash (#messages etc.). */
export function samePage(a: string, b: string): boolean {
    return a.split('#')[0] === b.split('#')[0];
}
