import { describe, expect, it } from 'vitest'
import { activityLevel, buildYearGrid, takeLastYears } from './passportActivity'

describe('activityLevel', () => {
    it('maps event counts to five fixed buckets', () => {
        expect(activityLevel(0)).toBe(0)
        expect(activityLevel(1)).toBe(1)
        expect(activityLevel(2)).toBe(1)
        expect(activityLevel(3)).toBe(2)
        expect(activityLevel(4)).toBe(2)
        expect(activityLevel(5)).toBe(3)
        expect(activityLevel(7)).toBe(3)
        expect(activityLevel(8)).toBe(4)
        expect(activityLevel(99)).toBe(4)
    })

    it('treats negative counts as empty', () => {
        expect(activityLevel(-1)).toBe(0)
    })
})

describe('buildYearGrid', () => {
    it('returns nothing for no activity', () => {
        expect(buildYearGrid([])).toEqual([])
    })

    it('places counts in the right month cell (Jan = index 0)', () => {
        const rows = buildYearGrid([
            { month: '2026-01', count: 2 },
            { month: '2026-12', count: 5 },
        ])
        expect(rows).toHaveLength(1)
        expect(rows[0].year).toBe(2026)
        expect(rows[0].cells[0]).toBe(2)
        expect(rows[0].cells[11]).toBe(5)
    })

    it('fills gap years between the first and last active year with zero rows', () => {
        const rows = buildYearGrid([
            { month: '2024-06', count: 1 },
            { month: '2026-03', count: 3 },
        ])
        expect(rows.map((r) => r.year)).toEqual([2024, 2025, 2026])
        expect(rows[1].cells.every((c) => c === 0)).toBe(true)
    })

    it('aggregates duplicate months', () => {
        const rows = buildYearGrid([
            { month: '2026-05', count: 2 },
            { month: '2026-05', count: 3 },
        ])
        expect(rows[0].cells[4]).toBe(5)
    })
})

describe('takeLastYears', () => {
    it('keeps only the most recent n rows', () => {
        const rows = buildYearGrid([
            { month: '2023-01', count: 1 },
            { month: '2026-01', count: 1 },
        ])
        const last2 = takeLastYears(rows, 2)
        expect(last2.map((r) => r.year)).toEqual([2025, 2026])
    })

    it('returns all rows when n exceeds the row count', () => {
        const rows = buildYearGrid([{ month: '2026-01', count: 1 }])
        expect(takeLastYears(rows, 2)).toHaveLength(1)
    })
})
