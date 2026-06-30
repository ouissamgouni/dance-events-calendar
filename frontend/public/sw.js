/*
 * Movida service worker.
 *
 * Two jobs:
 *   1. PWA installability + a lightweight offline app-shell fallback so the
 *      installed app opens even with no network. We deliberately do NOT
 *      precache hashed build assets here (that needs build-time injection);
 *      installability only requires a registered SW with a fetch handler plus
 *      a manifest carrying 192/512 maskable icons.
 *   2. Web-push delivery (reminders + friend/event activity) via the `push`
 *      and `notificationclick` handlers below. The backend signs payloads
 *      with VAPID; see backend/services/push_service.py.
 *
 * Versioned cache name — bump SHELL_CACHE to invalidate the app-shell entry
 * on breaking changes.
 */
const SHELL_CACHE = 'movida-shell-v1';
const APP_SHELL = '/';

self.addEventListener('install', (event) => {
    // Warm the navigation fallback so the first offline load still renders.
    event.waitUntil(
        caches
            .open(SHELL_CACHE)
            .then((cache) => cache.add(APP_SHELL))
            .catch(() => undefined),
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        (async () => {
            const keys = await caches.keys();
            await Promise.all(
                keys
                    .filter((k) => k.startsWith('movida-shell-') && k !== SHELL_CACHE)
                    .map((k) => caches.delete(k)),
            );
            await self.clients.claim();
        })(),
    );
});

self.addEventListener('fetch', (event) => {
    const { request } = event;
    // Only handle top-level navigations; let everything else hit the network
    // normally (API calls, hashed assets, cross-origin Google/CDN requests).
    if (request.mode !== 'navigate') return;
    event.respondWith(
        fetch(request).catch(async () => {
            const cache = await caches.open(SHELL_CACHE);
            const cached = await cache.match(APP_SHELL);
            return cached || Response.error();
        }),
    );
});

// ── Web push ───────────────────────────────────────────────────────────────
// Payload shape (JSON, sent by push_service.send_push):
//   { title, body, url, tag }
self.addEventListener('push', (event) => {
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
        badge: '/icons/icon-192.png',
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
