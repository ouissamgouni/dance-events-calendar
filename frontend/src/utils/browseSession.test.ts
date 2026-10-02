import { beforeEach, describe, expect, it } from 'vitest'
import {
    BROWSE_SESSION_IDLE_MS,
    clearBrowseSession,
    hasBrowseFilterParams,
    readBrowseSession,
    saveBrowseSession,
    touchBrowseSession,
} from './browseSession'

const NOW = new Date(2026, 9, 2, 12, 0, 0).getTime()

describe('browseSession', () => {
    beforeEach(() => sessionStorage.clear())

    it('round-trips only whitelisted filter params and the area override', () => {
        saveBrowseSession(
            new URLSearchParams('start_date=2026-10-02&tag_ids=3,4&interest_user_handle=a&interest_user_handle=b&view=map&sheet=1'),
            { kind: 'show-all' },
            NOW,
        )
        const restored = readBrowseSession(NOW + 1000)
        expect(restored?.params.toString()).toBe('start_date=2026-10-02&tag_ids=3%2C4&interest_user_handle=a&interest_user_handle=b')
        expect(restored?.area).toEqual({ kind: 'show-all' })
    })

    it('expires after the idle window', () => {
        saveBrowseSession(new URLSearchParams('tag_ids=3'), null, NOW)
        expect(readBrowseSession(NOW + BROWSE_SESSION_IDLE_MS + 1)).toBeNull()
        expect(sessionStorage.length).toBe(0)
    })

    it('touch slides the idle window', () => {
        saveBrowseSession(new URLSearchParams('tag_ids=3'), null, NOW)
        touchBrowseSession(NOW + BROWSE_SESSION_IDLE_MS - 1)
        expect(readBrowseSession(NOW + BROWSE_SESSION_IDLE_MS + 1)?.params.get('tag_ids')).toBe('3')
    })

    it('drops a fully past date range, and a past start date alone', () => {
        saveBrowseSession(new URLSearchParams('start_date=2026-09-01&end_date=2026-09-30&tag_ids=3'), null, NOW)
        expect(readBrowseSession(NOW)?.params.toString()).toBe('tag_ids=3')

        saveBrowseSession(new URLSearchParams('start_date=2026-09-01&end_date=2026-10-31'), null, NOW)
        expect(readBrowseSession(NOW)?.params.toString()).toBe('end_date=2026-10-31')
    })

    it('ignores corrupt or unknown snapshots', () => {
        sessionStorage.setItem('movida:browse-filters', '{not json')
        expect(readBrowseSession(NOW)).toBeNull()
        sessionStorage.setItem('movida:browse-filters', JSON.stringify({ v: 2, search: '', savedAt: NOW }))
        expect(readBrowseSession(NOW)).toBeNull()
    })

    it('clear removes the snapshot', () => {
        saveBrowseSession(new URLSearchParams('tag_ids=3'), null, NOW)
        clearBrowseSession()
        expect(readBrowseSession(NOW)).toBeNull()
    })

    it('detects filter params', () => {
        expect(hasBrowseFilterParams(new URLSearchParams('sheet=1&view=map'))).toBe(false)
        expect(hasBrowseFilterParams(new URLSearchParams('tag_ids='))).toBe(true)
    })
})
