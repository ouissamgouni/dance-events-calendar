/**
 * Service-worker registration.
 *
 * Registered from {@link main} after the window `load` event so SW setup never
 * competes with first paint. The SW (public/sw.js) powers PWA installability,
 * an offline app-shell fallback, and web-push delivery.
 *
 * No-ops when the browser lacks Service Worker support (older browsers, some
 * in-app webviews) so callers can invoke it unconditionally.
 */
export function registerServiceWorker(): void {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
        return;
    }
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(() => {
            // Registration failures are non-fatal — the app still works as a
            // normal SPA, just without offline support or push.
        });
    });
}
