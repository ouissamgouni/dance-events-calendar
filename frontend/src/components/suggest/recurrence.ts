/**
 * Frontend recurrence model for the Suggest Event wizard.
 *
 * The wizard keeps recurrence as structured state and only ever converts *out*
 * of it (to an RRULE string or an explicit date list) at submit time. We never
 * parse an RRULE back into this state, which keeps the UI free of a full RFC
 * 5545 parser.
 */

export type RecurrenceFrequency = 'weekly' | 'monthly' | 'yearly';

/** ISO weekday codes as used by RFC 5545 BYDAY. Index 0 = Monday. */
export const WEEKDAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type WeekdayCode = (typeof WEEKDAY_CODES)[number];

export const WEEKDAY_LABELS: Record<WeekdayCode, string> = {
    MO: 'Mon',
    TU: 'Tue',
    WE: 'Wed',
    TH: 'Thu',
    FR: 'Fri',
    SA: 'Sat',
    SU: 'Sun',
};

/** Matches MAX_OCCURRENCES in backend/services/recurrence.py. */
export const MAX_OCCURRENCES = 52;

export type RecurrenceEnd =
    | { kind: 'never' }
    | { kind: 'on'; date: string } // YYYY-MM-DD
    | { kind: 'after'; count: number };

export interface ManualDate {
    /** Local ISO datetime without timezone, e.g. 2026-06-15T20:00. */
    start: string;
    end: string;
}

export type RecurrenceState =
    | { mode: 'none' }
    | { mode: 'weekly'; interval: number; weekdays: WeekdayCode[]; end: RecurrenceEnd }
    | {
        mode: 'monthly';
        interval: number;
        by: 'day-of-month' | 'day-of-week';
        /** Day of month for `day-of-month`; defaults to the start's day. */
        monthDay: number;
        end: RecurrenceEnd;
    }
    | { mode: 'yearly'; interval: number; month: number; day: number; end: RecurrenceEnd }
    | { mode: 'dates'; dates: ManualDate[] };

export const NO_RECURRENCE: RecurrenceState = { mode: 'none' };

export const MONTH_LABELS = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
] as const;

export function weekdayOf(date: Date): WeekdayCode {
    // Date.getDay() is 0=Sunday; shift so Monday is 0 to match WEEKDAY_CODES.
    return WEEKDAY_CODES[(date.getDay() + 6) % 7];
}

/**
 * Sensible defaults for a newly chosen mode, derived from the event's start so
 * "Weekly" immediately means "weekly on the day the event starts".
 */
export function defaultsFor(
    mode: Exclude<RecurrenceState['mode'], 'none'>,
    start: Date,
): RecurrenceState {
    switch (mode) {
        case 'weekly':
            return { mode, interval: 1, weekdays: [weekdayOf(start)], end: { kind: 'never' } };
        case 'monthly':
            return {
                mode,
                interval: 1,
                by: 'day-of-month',
                monthDay: start.getDate(),
                end: { kind: 'never' },
            };
        case 'yearly':
            return {
                mode,
                interval: 1,
                month: start.getMonth() + 1,
                day: start.getDate(),
                end: { kind: 'never' },
            };
        case 'dates':
            return { mode, dates: [] };
    }
}

function untilPart(end: RecurrenceEnd): string {
    if (end.kind === 'on') {
        // UNTIL must be a UTC timestamp; end of the chosen day is inclusive.
        const until = new Date(`${end.date}T23:59:59Z`);
        return `;UNTIL=${until.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`;
    }
    if (end.kind === 'after') return `;COUNT=${end.count}`;
    return '';
}

/** Ordinal position of `start` within its month, capped at 5 ("last"-ish). */
function nthWeekdayOfMonth(start: Date): number {
    return Math.min(5, Math.floor((start.getDate() - 1) / 7) + 1);
}

const ORDINALS = ['first', 'second', 'third', 'fourth', 'last'] as const;

/** `second Friday` — how the monthly "day of week" option describes itself. */
export function nthWeekdayLabel(start: Date): string {
    return `${ORDINALS[nthWeekdayOfMonth(start) - 1]} ${WEEKDAY_LABELS[weekdayOf(start)]}`;
}

/** True when the manual date list contains the same start twice. */
export function hasDuplicateDates(dates: ManualDate[]): boolean {
    const starts = dates.map((d) => d.start).filter(Boolean);
    return new Set(starts).size !== starts.length;
}

/**
 * Convert to an RFC 5545 RRULE string, or null for modes the backend stores as
 * explicit dates (or no recurrence at all).
 */
export function toRRule(state: RecurrenceState, start: Date): string | null {
    switch (state.mode) {
        case 'none':
        case 'dates':
            return null;
        case 'weekly': {
            const days = state.weekdays.length ? state.weekdays : [weekdayOf(start)];
            return `RRULE:FREQ=WEEKLY;INTERVAL=${state.interval};BYDAY=${days.join(',')}${untilPart(state.end)}`;
        }
        case 'monthly': {
            const by =
                state.by === 'day-of-week'
                    ? `;BYDAY=${nthWeekdayOfMonth(start)}${weekdayOf(start)}`
                    : `;BYMONTHDAY=${state.monthDay}`;
            return `RRULE:FREQ=MONTHLY;INTERVAL=${state.interval}${by}${untilPart(state.end)}`;
        }
        case 'yearly':
            return `RRULE:FREQ=YEARLY;INTERVAL=${state.interval};BYMONTH=${state.month};BYMONTHDAY=${state.day}${untilPart(state.end)}`;
    }
}

/** Explicit occurrence list for the "choose dates" mode, otherwise null. */
export function toOccurrenceDates(state: RecurrenceState): ManualDate[] | null {
    if (state.mode !== 'dates' || state.dates.length === 0) return null;
    return state.dates;
}

function endSummary(end: RecurrenceEnd): string {
    if (end.kind === 'after') return `, ${end.count} times`;
    if (end.kind === 'on') return `, until ${end.date}`;
    return ', no end date';
}

function every(interval: number, unit: string): string {
    return interval === 1 ? `Every ${unit}` : `Every ${interval} ${unit}s`;
}

/** Human-readable one-liner shown on the collapsed "Repeat" row. */
export function summarize(state: RecurrenceState, start: Date): string {
    switch (state.mode) {
        case 'none':
            return 'Does not repeat';
        case 'weekly': {
            const days = (state.weekdays.length ? state.weekdays : [weekdayOf(start)])
                .map((d) => WEEKDAY_LABELS[d])
                .join(', ');
            return `${every(state.interval, 'week')} on ${days}${endSummary(state.end)}`;
        }
        case 'monthly': {
            const on =
                state.by === 'day-of-week'
                    ? ` on the ${nthWeekdayLabel(start)}`
                    : ` on day ${state.monthDay}`;
            return `${every(state.interval, 'month')}${on}${endSummary(state.end)}`;
        }
        case 'yearly':
            return `${every(state.interval, 'year')} on ${state.day} ${MONTH_LABELS[state.month - 1]}${endSummary(state.end)}`;
        case 'dates':
            if (state.dates.length === 0) return 'Does not repeat';
            return `${state.dates.length} selected date${state.dates.length === 1 ? '' : 's'}`;
    }
}

/**
 * Short label for the `Repeat` row on step 1 — the full sentence is too long
 * for a single-line row on a 320px screen, so the detail lives in the editor.
 */
export function rowSummary(state: RecurrenceState): string {
    switch (state.mode) {
        case 'none':
            return 'Does not repeat';
        case 'weekly':
            return state.interval === 1 ? 'Weekly' : `Every ${state.interval} weeks`;
        case 'monthly':
            return state.interval === 1 ? 'Monthly' : `Every ${state.interval} months`;
        case 'yearly':
            return state.interval === 1 ? 'Yearly' : `Every ${state.interval} years`;
        case 'dates':
            return state.dates.length === 0
                ? 'Choose dates'
                : `${state.dates.length} date${state.dates.length === 1 ? '' : 's'}`;
    }
}
