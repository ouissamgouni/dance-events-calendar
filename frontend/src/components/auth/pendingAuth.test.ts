import { afterEach, describe, expect, it } from 'vitest'
import { PENDING_AUTH_TTL_MS, clearPendingAuth, readPendingAuth, samePage, savePendingAuth, updatePendingAuth } from './pendingAuth'

describe('pendingAuth', () => {
    afterEach(() => clearPendingAuth())

    it('round-trips the pending action and return context', () => {
        savePendingAuth({ intent: 'save', action: { kind: 'save', eventId: 'e1' }, returnTo: '/browse?tag=salsa#x', scrollTop: 420 }, 1000)
        expect(readPendingAuth(1000)).toEqual({
            intent: 'save',
            action: { kind: 'save', eventId: 'e1' },
            returnTo: '/browse?tag=salsa#x',
            scrollTop: 420,
            createdAt: 1000,
        })
    })

    it('expires stale records', () => {
        savePendingAuth({ intent: 'going', returnTo: '/', scrollTop: 0 }, 0)
        expect(readPendingAuth(PENDING_AUTH_TTL_MS + 1)).toBeNull()
        expect(readPendingAuth(0)).toBeNull()
    })

    it('patches without touching other fields and clears', () => {
        savePendingAuth({ intent: 'save', action: { kind: 'save', eventId: 'e1' }, returnTo: '/a', scrollTop: 5 })
        updatePendingAuth({ action: undefined })
        expect(readPendingAuth()).toMatchObject({ intent: 'save', returnTo: '/a', scrollTop: 5 })
        expect(readPendingAuth()?.action).toBeUndefined()
        clearPendingAuth()
        expect(readPendingAuth()).toBeNull()
    })

    it('compares pages ignoring the hash', () => {
        expect(samePage('/event/1?x=1#messages', '/event/1?x=1')).toBe(true)
        expect(samePage('/event/1?x=1', '/event/1?x=2')).toBe(false)
    })
})
