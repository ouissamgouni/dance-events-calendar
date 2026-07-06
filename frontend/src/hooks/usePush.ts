import { useCallback, useEffect, useState } from 'react';
import { fetchVapidPublicKey, subscribePush, unsubscribePush } from '../api';

/**
 * Web-push enrolment hook.
 *
 * Wraps the browser PushManager + Notification permission dance behind a tiny
 * state machine the settings UI can drive:
 *
 *   status:
 *     'unsupported' — no SW/PushManager/Notification (iOS < 16.4, some webviews)
 *     'disabled'    — backend has web-push turned off (no VAPID key)
 *     'denied'      — the user blocked notifications at the OS/browser level
 *     'off'         — supported + permitted-or-default, not currently subscribed
 *     'on'          — an active push subscription is registered with the server
 *
 * ``enable`` requests permission (if needed), subscribes via VAPID, and POSTs
 * the subscription to the backend. ``disable`` unsubscribes locally and tells
 * the backend to drop the endpoint. Both are no-ops in terminal states.
 */
export type PushStatus = 'unsupported' | 'disabled' | 'denied' | 'off' | 'on';

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
    const padding = '='.repeat((4 - (base64.length % 4)) % 4);
    const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(normalized);
    const out = new Uint8Array(new ArrayBuffer(raw.length));
    for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
    return out;
}

const isSupported = (): boolean =>
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window;

// Subscribe via VAPID (reusing any existing subscription) and register the
// endpoint with the backend. Shared by silent auto-enable and the explicit
// ``enable`` action.
async function subscribeAndRegister(
    reg: ServiceWorkerRegistration,
    key: string,
): Promise<void> {
    console.log("Starting subscribe...");

    let sub = await reg.pushManager.getSubscription();
    console.log("Existing subscription:", sub);

    if (!sub) {
        console.log("Creating new subscription...");
        sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(key),
        });
        console.log("Created subscription:", sub);
    }

    const json = sub.toJSON();
    console.log("Sending subscription to backend...");

    await subscribePush({
        endpoint: sub.endpoint,
        keys: {
            p256dh: json.keys?.p256dh ?? '',
            auth: json.keys?.auth ?? '',
        },
        user_agent: navigator.userAgent,
    });

    console.log("Backend registration complete.");
}

/*
const resubscribe = useCallback(async () => {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return;

    const key = await fetchVapidPublicKey();
    if (!key) {
        console.error('No VAPID public key available');
        return;
    }

    const reg = await navigator.serviceWorker.ready;

    const existing = await reg.pushManager.getSubscription();
    if (existing) return;

    await subscribeAndRegister(reg, key);
}, []);*/

export function usePush(userId?: string | null) {
    const [status, setStatus] = useState<PushStatus>('off');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Resolve the initial status: feature support → backend enablement →
    // browser permission → existing subscription. When permission is already
    // granted but no subscription exists yet, silently subscribe so push is
    // on-by-default for users who have allowed notifications — no prompt is
    // shown because the permission grant already happened.
    //
    // ``userId`` (the signed-in user id, or ``undefined``/``null`` while
    // anonymous) is a dependency purely to re-run this effect across a
    // login/logout transition in the same tab. The backend binds a push
    // subscription's owner from the request's auth cookie at POST-time
    // (see backend/api/routes/push.py), not from anything the client sends —
    // so an existing browser-level subscription created while anonymous
    // stays bound to `user_id = NULL` forever unless it is re-POSTed after
    // sign-in. Re-running this effect on ``userId`` change re-registers the
    // existing subscription, rebinding it to the now-known account without
    // requiring the user to manually disable/re-enable notifications.
    useEffect(() => {
        let cancelled = false;

        (async () => {
            if (!isSupported()) {
                if (!cancelled) setStatus('unsupported');
                return;
            }

            if (Notification.permission === 'denied') {
                if (!cancelled) setStatus('denied');
                return;
            }

            const key = await fetchVapidPublicKey();
            if (cancelled) return;

            if (!key) {
                setStatus('disabled');
                return;
            }

            const reg = await navigator.serviceWorker.ready;
            const existing = await reg.pushManager.getSubscription();

            // ✅ CASE 1: already subscribed. Re-register (not just locally
            // detect) so a sign-in transition rebinds this endpoint's
            // `user_id` server-side — see the comment on the hook above.
            if (existing) {
                try {
                    await subscribeAndRegister(reg, key);
                    if (!cancelled) setStatus('on');
                } catch (e) {
                    console.error('Re-register failed', e);
                    if (!cancelled) setStatus('on');
                }
                return;
            }

            // ✅ CASE 2: permission already granted → auto recover subscription
            if (Notification.permission === 'granted') {
                try {
                    await subscribeAndRegister(reg, key);
                    if (!cancelled) setStatus('on');
                } catch (e) {
                    console.error('Auto-subscribe failed', e);
                    if (!cancelled) setStatus('off');
                }
                return;
            }

            if (!cancelled) setStatus('off');
        })();

        return () => {
            cancelled = true;
        };
    }, [userId]);

    const enable = useCallback(async () => {
        console.log("enable() called");
        if (busy || !isSupported()) return;
        setBusy(true);
        setError(null);
        try {
            const permission = await Notification.requestPermission();
            if (permission !== 'granted') {
                setStatus(permission === 'denied' ? 'denied' : 'off');
                return;
            }
            const key = await fetchVapidPublicKey();
            if (!key) {
                setStatus('disabled');
                return;
            }
            const reg = await navigator.serviceWorker.ready;
            await subscribeAndRegister(reg, key);
            setStatus('on');
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to enable notifications');
        } finally {
            setBusy(false);
        }
    }, [busy]);

    const disable = useCallback(async () => {
        if (busy || !isSupported()) return;
        setBusy(true);
        setError(null);
        try {
            const reg = await navigator.serviceWorker.ready;
            const sub = await reg.pushManager.getSubscription();
            if (sub) {
                await unsubscribePush(sub.endpoint);
                await sub.unsubscribe();
            }
            setStatus('off');
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to disable notifications');
        } finally {
            setBusy(false);
        }
    }, [busy]);

    return { status, busy, error, enable, disable };
}
