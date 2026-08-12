/**
 * Shared helpers for the Dance Passport activity heatmap (Year × Month grid,
 * the yearly card's month strip and the all-time card matrix).
 *
 * Event counts map to five fixed intensity levels rather than per-user
 * quantiles: dance events are far rarer than e.g. commits, so absolute
 * thresholds read consistently across casual and prolific dancers.
 */
import type { MonthlyActivity } from '../types';

/** Single-letter month headers (Jan..Dec). Duplicated initials are expected. */
export const MONTH_INITIALS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'] as const;

export const MONTH_SHORT = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/** Intensity bucket (0 = none) for an attended-event count in a month. */
export function activityLevel(count: number): 0 | 1 | 2 | 3 | 4 {
    if (count <= 0) return 0;
    if (count <= 2) return 1;
    if (count <= 4) return 2;
    if (count <= 7) return 3;
    return 4;
}

// Full literal Tailwind classes per level (never interpolate suffixes — the JIT
// scanner only picks up complete class strings). Light ramp sits on the app's
// white/slate surfaces; the dark ramp sits on the slate-900 share card.
export const LEVEL_RAMP_LIGHT: Record<0 | 1 | 2 | 3 | 4, string> = {
    0: 'bg-slate-100',
    1: 'bg-emerald-200',
    2: 'bg-emerald-400',
    3: 'bg-emerald-500',
    4: 'bg-emerald-700',
};

export const LEVEL_RAMP_DARK: Record<0 | 1 | 2 | 3 | 4, string> = {
    0: 'bg-white/5',
    1: 'bg-emerald-900',
    2: 'bg-emerald-700',
    3: 'bg-emerald-500',
    4: 'bg-emerald-300',
};

export interface YearRow {
    year: number;
    /** 12 counts, index 0 = January. */
    cells: number[];
}

/**
 * Turn a flat `MonthlyActivity[]` ("YYYY-MM" + count) into contiguous year rows
 * (Jan..Dec), oldest first. Years with no activity between the first and last
 * active year are still emitted (as all-zero rows) so the matrix reads as an
 * unbroken run of years.
 */
export function buildYearGrid(months: MonthlyActivity[]): YearRow[] {
    if (months.length === 0) return [];
    const counts = new Map<number, number[]>();
    let minYear = Infinity;
    let maxYear = -Infinity;
    for (const m of months) {
        const [yStr, moStr] = m.month.split('-');
        const year = Number(yStr);
        const monthIdx = Number(moStr) - 1;
        if (!Number.isFinite(year) || monthIdx < 0 || monthIdx > 11) continue;
        if (!counts.has(year)) counts.set(year, new Array(12).fill(0));
        counts.get(year)![monthIdx] += m.count;
        minYear = Math.min(minYear, year);
        maxYear = Math.max(maxYear, year);
    }
    if (!Number.isFinite(minYear)) return [];
    const rows: YearRow[] = [];
    for (let year = maxYear; year >= minYear; year -= 1) {
        rows.push({ year, cells: counts.get(year) ?? new Array(12).fill(0) });
    }
    return rows;
}

/** Keep only the most recent `n` year rows (used by the space-limited card). */
export function takeLastYears(rows: YearRow[], n: number): YearRow[] {
    return n >= rows.length ? rows : rows.slice(rows.length - n);
}
