/**
 * Local date/time helpers for the Suggest Event wizard.
 *
 * Every value the wizard stores is a *local* wall-clock string in the shape a
 * native input produces — `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm` — never a UTC ISO
 * string. Parsing is done by hand because `new Date('2026-04-12')` is treated
 * as UTC by the spec and would shift the day in western timezones.
 */

const DATE_FMT = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
});

export function parseLocal(value: string): Date | null {
    if (!value) return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(value);
    if (!match) return null;
    const [, y, m, d, hh, mm] = match;
    const date = new Date(Number(y), Number(m) - 1, Number(d), Number(hh ?? 0), Number(mm ?? 0));
    return Number.isNaN(date.getTime()) ? null : date;
}

/** Format a Date as a `datetime-local` input value in the local timezone. */
export function toLocalInput(date: Date): string {
    return `${toDateInput(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function toDateInput(date: Date): string {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function pad(n: number): string {
    return String(n).padStart(2, '0');
}

/** `2026-04-12T20:00` → `2026-04-12`. */
export function datePart(value: string): string {
    return value.slice(0, 10);
}

/** `2026-04-12T20:00` → `20:00`, or '' when the value carries no time. */
export function timePart(value: string): string {
    return value.length >= 16 ? value.slice(11, 16) : '';
}

export function combine(date: string, time: string): string {
    if (!date) return '';
    return time ? `${date}T${time}` : date;
}

export function addMinutes(value: string, minutes: number): string {
    const date = parseLocal(value);
    if (!date) return value;
    date.setMinutes(date.getMinutes() + minutes);
    return value.length >= 16 ? toLocalInput(date) : toDateInput(date);
}

/** Minutes between two wizard values, or null when either is unparseable. */
export function minutesBetween(from: string, to: string): number | null {
    const a = parseLocal(from);
    const b = parseLocal(to);
    if (!a || !b) return null;
    return Math.round((b.getTime() - a.getTime()) / 60000);
}

/** `Fri, 12 Apr 2026` */
export function formatDate(value: string | Date): string {
    const date = typeof value === 'string' ? parseLocal(value) : value;
    return date ? DATE_FMT.format(date).replace(/,\s*$/, '') : '';
}

/** `20:00` */
export function formatTime(value: string | Date): string {
    const date = typeof value === 'string' ? parseLocal(value) : value;
    if (!date) return '';
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** `Fri, 12 Apr 2026, 20:00` — or just the date when all-day. */
export function formatDateTime(value: string, allDay: boolean): string {
    const date = parseLocal(value);
    if (!date) return '';
    return allDay || value.length < 16 ? formatDate(date) : `${formatDate(date)}, ${formatTime(date)}`;
}
