import { useEffect, useSyncExternalStore } from 'react';

const SHOWN_KEY = 'movida:home-overlays-shown';

let openCount = 0;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** True while a Home prompt sheet (review / people) is open; banners stay hidden meanwhile. */
export function useHomeOverlayOpen(): boolean {
    return useSyncExternalStore(subscribe, () => openCount > 0, () => false);
}

/** Registers the calling component's sheet as open while ``open`` is true. */
export function useRegisterHomeOverlay(open: boolean): void {
    useEffect(() => {
        if (!open) return;
        openCount += 1;
        listeners.forEach((l) => l());
        return () => {
            openCount -= 1;
            listeners.forEach((l) => l());
        };
    }, [open]);
}

function read(userId: string): number {
    try {
        const raw = window.sessionStorage.getItem(SHOWN_KEY);
        const parsed = raw ? (JSON.parse(raw) as { u?: string; n?: number }) : null;
        return parsed?.u === userId ? parsed.n ?? 0 : 0;
    } catch {
        return 0;
    }
}

/** Interruptive Home sheets already shown to ``userId`` in this browser session. */
export function homeOverlaysShown(userId: string): number {
    return read(userId);
}

export function markHomeOverlayShown(userId: string): void {
    try {
        window.sessionStorage.setItem(SHOWN_KEY, JSON.stringify({ u: userId, n: read(userId) + 1 }));
    } catch { /* private mode: server-side caps still apply */ }
}

export function clearHomeOverlays(): void {
    try {
        window.sessionStorage.removeItem(SHOWN_KEY);
    } catch { /* ignore */ }
}
