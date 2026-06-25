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

export function usePush() {
    const [status, setStatus] = useState<PushStatus>('off');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Resolve the initial status: feature support → backend enablement →
    // browser permission → existing subscription.
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
            try {
                const reg = await navigator.serviceWorker.ready;
                const existing = await reg.pushManager.getSubscription();
                if (!cancelled) setStatus(existing ? 'on' : 'off');
            } catch {
                if (!cancelled) setStatus('off');
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const enable = useCallback(async () => {
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
            const sub =
                (await reg.pushManager.getSubscription()) ||
                (await reg.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: urlBase64ToUint8Array(key),
                }));
            const json = sub.toJSON();
            await subscribePush({
                endpoint: sub.endpoint,
                keys: {
                    p256dh: json.keys?.p256dh ?? '',
                    auth: json.keys?.auth ?? '',
                },
                user_agent: navigator.userAgent,
            });
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
