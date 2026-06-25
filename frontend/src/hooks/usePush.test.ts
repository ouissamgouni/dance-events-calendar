import { describe, expect, it, vi, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { usePush } from './usePush'
import { server } from '../test/server'

// A valid base64url VAPID key ("testkey") so urlBase64ToUint8Array / atob can
// decode it during subscribe.
const VAPID_KEY = 'dGVzdGtleQ'

interface SubStub {
    endpoint: string
    toJSON: () => { keys?: { p256dh?: string; auth?: string } }
    unsubscribe: ReturnType<typeof vi.fn>
}

function makeSub(endpoint = 'https://push.example/abc'): SubStub {
    return {
        endpoint,
        toJSON: () => ({ keys: { p256dh: 'p256', auth: 'authsecret' } }),
        unsubscribe: vi.fn(async () => true),
    }
}

interface SetupOpts {
    supported?: boolean
    permission?: NotificationPermission
    requestPermission?: NotificationPermission
    existing?: SubStub | null
    subscribe?: SubStub
}

interface PostedSubscriptionPayload {
    endpoint: string
    keys: { p256dh: string; auth: string }
    user_agent?: string
}

function setupPush(opts: SetupOpts = {}) {
    const {
        supported = true,
        permission = 'default',
        requestPermission = 'granted',
        existing = null,
        subscribe = makeSub(),
    } = opts

    const pushManager = {
        getSubscription: vi.fn(async () => existing),
        subscribe: vi.fn(async () => subscribe),
    }

    if (supported) {
        Object.defineProperty(navigator, 'serviceWorker', {
            configurable: true,
            value: {
                ready: Promise.resolve({ pushManager }),
            },
        })
        Object.defineProperty(globalThis, 'PushManager', {
            configurable: true,
            value: function PushManager() { },
        })
        const requestPermissionMock = vi.fn(async () => requestPermission)
        Object.defineProperty(globalThis, 'Notification', {
            configurable: true,
            value: { permission, requestPermission: requestPermissionMock },
        })
        return { pushManager, requestPermissionMock }
    }
    return { pushManager, requestPermissionMock: vi.fn() }
}

afterEach(() => {
    for (const key of ['PushManager', 'Notification'] as const) {
        if (key in globalThis) {
            delete globalThis[key]
        }
    }
    if ('serviceWorker' in navigator) {
        delete (navigator as unknown as Record<string, unknown>).serviceWorker
    }
})

describe('usePush', () => {
    it('reports "unsupported" when the browser lacks service workers', async () => {
        // No globals defined → isSupported() is false.
        const { result } = renderHook(() => usePush())
        await waitFor(() => expect(result.current.status).toBe('unsupported'))
    })

    it('reports "denied" when notification permission is blocked', async () => {
        setupPush({ permission: 'denied' })
        const { result } = renderHook(() => usePush())
        await waitFor(() => expect(result.current.status).toBe('denied'))
    })

    it('reports "disabled" when the backend has no VAPID key', async () => {
        setupPush()
        // Default handler returns 404 → fetchVapidPublicKey resolves null.
        const { result } = renderHook(() => usePush())
        await waitFor(() => expect(result.current.status).toBe('disabled'))
    })

    it('reports "off" when supported, enabled, and not yet subscribed', async () => {
        setupPush({ existing: null })
        server.use(
            http.get('*/api/push/vapid-public-key', () =>
                HttpResponse.json({ public_key: VAPID_KEY }),
            ),
        )
        const { result } = renderHook(() => usePush())
        await waitFor(() => expect(result.current.status).toBe('off'))
    })

    it('reports "on" when an existing subscription is present', async () => {
        setupPush({ existing: makeSub() })
        server.use(
            http.get('*/api/push/vapid-public-key', () =>
                HttpResponse.json({ public_key: VAPID_KEY }),
            ),
        )
        const { result } = renderHook(() => usePush())
        await waitFor(() => expect(result.current.status).toBe('on'))
    })

    it('enable() requests permission, subscribes, and POSTs the subscription', async () => {
        const { pushManager, requestPermissionMock } = setupPush({
            existing: null,
            requestPermission: 'granted',
        })
        const posted = { current: null as PostedSubscriptionPayload | null }
        server.use(
            http.get('*/api/push/vapid-public-key', () =>
                HttpResponse.json({ public_key: VAPID_KEY }),
            ),
            http.post('*/api/push/subscribe', async ({ request }) => {
                posted.current = (await request.json()) as PostedSubscriptionPayload
                return new HttpResponse(null, { status: 204 })
            }),
        )

        const { result } = renderHook(() => usePush())
        await waitFor(() => expect(result.current.status).toBe('off'))

        await result.current.enable()

        expect(requestPermissionMock).toHaveBeenCalledTimes(1)
        expect(pushManager.subscribe).toHaveBeenCalledTimes(1)
        await waitFor(() => expect(result.current.status).toBe('on'))
        expect(posted.current?.endpoint).toBe('https://push.example/abc')
        expect(posted.current?.keys).toEqual({ p256dh: 'p256', auth: 'authsecret' })
    })

    it('enable() settles on "denied" when the permission prompt is rejected', async () => {
        setupPush({ existing: null, requestPermission: 'denied' })
        server.use(
            http.get('*/api/push/vapid-public-key', () =>
                HttpResponse.json({ public_key: VAPID_KEY }),
            ),
        )

        const { result } = renderHook(() => usePush())
        await waitFor(() => expect(result.current.status).toBe('off'))

        await result.current.enable()
        await waitFor(() => expect(result.current.status).toBe('denied'))
    })

    it('disable() unsubscribes locally and tells the backend to drop the endpoint', async () => {
        const existing = makeSub()
        setupPush({ existing })
        let unsubscribedEndpoint: string | null = null
        server.use(
            http.get('*/api/push/vapid-public-key', () =>
                HttpResponse.json({ public_key: VAPID_KEY }),
            ),
            http.post('*/api/push/unsubscribe', async ({ request }) => {
                const body = (await request.json()) as { endpoint?: string }
                unsubscribedEndpoint = body.endpoint ?? null
                return new HttpResponse(null, { status: 204 })
            }),
        )

        const { result } = renderHook(() => usePush())
        await waitFor(() => expect(result.current.status).toBe('on'))

        await result.current.disable()

        expect(existing.unsubscribe).toHaveBeenCalledTimes(1)
        expect(unsubscribedEndpoint).toBe(existing.endpoint)
        await waitFor(() => expect(result.current.status).toBe('off'))
    })
})
