import { describe, expect, it } from 'vitest'
import { mailAppFor, resolveSignInIntent, signInPath } from './signInIntent'

describe('resolveSignInIntent', () => {
    it('uses a known intent param', () => {
        expect(resolveSignInIntent('save', '/event/1')).toBe('save')
    })

    it('ignores unknown intent params and falls back to the next path', () => {
        expect(resolveSignInIntent('bogus', '/event/1#community')).toBe('review')
    })

    it('derives intent from the next path', () => {
        expect(resolveSignInIntent(null, '/event/1#messages')).toBe('message')
        expect(resolveSignInIntent(null, '/event/1?tab=discussion')).toBe('message')
        expect(resolveSignInIntent(null, '/event/1#people')).toBe('people')
        expect(resolveSignInIntent(null, '/tribe/calendars')).toBe('calendar')
        expect(resolveSignInIntent(null, '/')).toBe('generic')
        expect(resolveSignInIntent(null, null)).toBe('generic')
    })
})

describe('signInPath', () => {
    it('omits the intent param for generic', () => {
        expect(signInPath('/a?b=1')).toBe('/login?next=%2Fa%3Fb%3D1')
        expect(signInPath('/a', 'save')).toBe('/login?next=%2Fa&intent=save')
    })
})

describe('mailAppFor', () => {
    it('maps known providers and ignores others', () => {
        expect(mailAppFor('A@Gmail.com')?.label).toBe('Open Gmail')
        expect(mailAppFor('x@hotmail.com')?.label).toBe('Open Outlook')
        expect(mailAppFor('x@example.com')).toBeNull()
    })
})
