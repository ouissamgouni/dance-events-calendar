/*
 * Movida service worker.
 *
 * Job: web-push delivery (reminders + friend/event activity) via the `push`
 * and `notificationclick` handlers below. The backend signs payloads with
 * VAPID; see backend/services/push_service.py.
 *
 * We deliberately do NOT cache the navigation HTML shell. The built index.html
 * embeds hashed asset URLs (/assets/index-<hash>.js) that rotate on every
 * deploy; serving a cached shell would point the app at assets that no longer
 * exist → a blank/unstyled PWA. The SPA is always fetched fresh from the edge.
 */

self.addEventListener('install', () => {
    // Take over as soon as the new worker is installed so cache-purging in
    // `activate` (below) runs promptly for users on a stale worker.
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        (async () => {
            // Purge any legacy app-shell caches left by older SW versions.
            const keys = await caches.keys();
            await Promise.all(
                keys
                    .filter((k) => k.startsWith('movida-shell-'))
                    .map((k) => caches.delete(k)),
            );
            await self.clients.claim();
        })(),
    );
});

// ── Web push ───────────────────────────────────────────────────────────────
// Payload shape (JSON, sent by push_service.send_push):
//   { title, body, url, tag }
self.addEventListener('push', (event) => {
    console.log('Push event fired', event);
    let data = {};

    try {
        data = event.data ? event.data.json() : {};
    } catch (e) {
        data = { body: '⚠️ Invalid push payload' };
    }

    const title = data.title || '🚀 PUSH RECEIVED';

    const options = {
        body: data.body || 'Service worker push event fired successfully',
        icon: '/icons/icon-192.png',
        badge: '/icons/badge-72.png',
        tag: 'debug-push',
        data: {
            url: data.url || '/',
            debug: true,
            raw: data,
        },
    };

    event.waitUntil(
        self.registration.showNotification(title, options)
    );
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const targetUrl = (event.notification.data && event.notification.data.url) || '/';
    event.waitUntil(
        (async () => {
            const all = await self.clients.matchAll({
                type: 'window',
                includeUncontrolled: true,
            });
            // Focus an existing tab when one is already open, else open new.
            for (const client of all) {
                if ('focus' in client) {
                    client.focus();
                    if ('navigate' in client) {
                        try {
                            await client.navigate(targetUrl);
                        } catch {
                            /* cross-origin / detached — ignore */
                        }
                    }
                    return;
                }
            }
            if (self.clients.openWindow) await self.clients.openWindow(targetUrl);
        })(),
    );
});
