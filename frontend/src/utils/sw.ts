/**
 * Service-worker registration.
 *
 * Registered from {@link main} after the window `load` event so SW setup never
 * competes with first paint. The SW (public/sw.js) powers PWA installability
 * and web-push delivery. It deliberately does not cache the navigation HTML,
 * which embeds per-deploy hashed asset URLs and would break on the next release.
 *
 * No-ops when the browser lacks Service Worker support (older browsers, some
 * in-app webviews) so callers can invoke it unconditionally.
 */
export function registerServiceWorker(): void {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
        return;
    }

    // When a new worker takes control, the app it was serving may be stale
    // (old hashed assets). Reload once so the page re-fetches fresh HTML.
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloaded) return;
        reloaded = true;
        window.location.reload();
    });

    window.addEventListener('load', () => {
        navigator.serviceWorker
            // `updateViaCache: 'none'` stops the browser from serving sw.js
            // from the HTTP cache during update checks, so a new worker (and
            // its recovery logic) is picked up on the very next visit instead
            // of waiting out the old worker's Cache-Control max-age.
            .register('/sw.js', { updateViaCache: 'none' })
            .then((registration) => {
                // Force an immediate update check on load, and again whenever
                // the app returns to the foreground (typical PWA relaunch).
                registration.update().catch(() => undefined);
                document.addEventListener('visibilitychange', () => {
                    if (document.visibilityState === 'visible') {
                        registration.update().catch(() => undefined);
                    }
                });
            })
            .catch(() => {
                // Registration failures are non-fatal — the app still works as
                // a normal SPA, just without push notifications.
            });
    });
}
