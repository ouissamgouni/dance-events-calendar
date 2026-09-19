import { describe, expect, it } from 'vitest'
import { activityLevel, buildYearGrid, rollingTwelveMonths, takeLastYears } from './passportActivity'

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

describe('rollingTwelveMonths', () => {
    it('returns the current month and previous eleven with missing months filled', () => {
        const months = rollingTwelveMonths(
            [
                { month: '2025-09', count: 2 },
                { month: '2026-08', count: 3 },
            ],
            new Date(2026, 7, 25),
        )

        expect(months).toHaveLength(12)
        expect(months[0]).toEqual({ month: '2025-09', initial: 'S', count: 2 })
        expect(months[1]).toEqual({ month: '2025-10', initial: 'O', count: 0 })
        expect(months[11]).toEqual({ month: '2026-08', initial: 'A', count: 3 })
    })

    it('crosses calendar years and ignores activity outside the window', () => {
        const months = rollingTwelveMonths(
            [
                { month: '2024-12', count: 9 },
                { month: '2025-02', count: 1 },
                { month: '2026-01', count: 4 },
            ],
            new Date(2026, 0, 10),
        )

        expect(months.map((month) => month.month)).toEqual([
            '2025-02', '2025-03', '2025-04', '2025-05', '2025-06', '2025-07',
            '2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01',
        ])
        expect(months[0].count).toBe(1)
        expect(months[11].count).toBe(4)
    })
})
