import { describe, expect, it } from 'vitest'
import { anonHorizonEnd, splitByHorizon } from './anonHorizon'

describe('anonHorizonEnd', () => {
    it('is off when days is 0', () => {
        expect(anonHorizonEnd(0)).toBeNull()
    })

    it('ends at the last millisecond of the Nth local day', () => {
        const end = anonHorizonEnd(30, new Date(2026, 9, 13, 15, 0))!
        expect(end.getFullYear()).toBe(2026)
        expect(end.getMonth()).toBe(10)
        expect(end.getDate()).toBe(12)
        expect(end.getHours()).toBe(23)
        expect(end.getMinutes()).toBe(59)
    })
})

describe('splitByHorizon', () => {
    const end = new Date(2026, 9, 20, 23, 59, 59, 999)
    const events = [
        { start: new Date(2026, 9, 14, 20).toISOString() },
        { start: new Date(2026, 9, 20, 22).toISOString() },
        { start: new Date(2026, 9, 21, 0, 30).toISOString() },
    ]

    it('keeps events starting on or before the horizon and counts the rest', () => {
        const { visible, lockedCount } = splitByHorizon(events, end)
        expect(visible).toHaveLength(2)
        expect(lockedCount).toBe(1)
    })

    it('passes everything through without a horizon', () => {
        expect(splitByHorizon(events, null)).toEqual({ visible: events, lockedCount: 0 })
    })
})
