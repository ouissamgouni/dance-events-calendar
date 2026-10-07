import type { CalendarEvent } from '../types';
import { toZonedInput, zonedInputToIso } from './schedule';

// Event instants come from the API as UTC ISO strings. Timed events are shown
// and edited in the event's own zone (falling back to the viewer's); all-day
// events are UTC-midnight dates with an exclusive end, so they are read in UTC.

type EventTimes = Pick<CalendarEvent, 'start' | 'end' | 'all_day'> & { timezone?: string | null };

const DAY_MS = 24 * 60 * 60 * 1000;

export function browserTimeZone(): string {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function utcDay(iso: string): string {
    return new Date(iso).toISOString().slice(0, 10);
}

function addDays(day: string, days: number): string {
    return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function dayKey(date: Date, timeZone?: string): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** Zone an event's own dates/times are shown in: UTC for all-day dates, else its zone (viewer's when unknown). */
export function eventDisplayZone(event: EventTimes): string | undefined {
    return event.all_day ? 'UTC' : event.timezone || undefined;
}

export function dayOfMonth(date: Date, timeZone?: string): number {
    return Number(new Intl.DateTimeFormat('en-US', { day: 'numeric', timeZone }).format(date));
}

export function isSameMonth(a: Date, b: Date, timeZone?: string): boolean {
    return dayKey(a, timeZone).slice(0, 7) === dayKey(b, timeZone).slice(0, 7);
}

export interface EventEditFields {
    start: string;
    end: string;
    allDay: boolean;
    /** Zone the timed inputs are in; null = unknown, edited in the viewer's zone. */
    timeZone: string | null;
}

/** Editor values for an event; all-day ends are shown as the inclusive last day. */
export function toEditFields(event: EventTimes): EventEditFields {
    const timeZone = event.timezone || null;
    if (event.all_day) {
        const start = utcDay(event.start);
        const lastDay = addDays(utcDay(event.end), -1);
        return { start, end: lastDay < start ? start : lastDay, allDay: true, timeZone };
    }
    return {
        start: toZonedInput(event.start, timeZone ?? browserTimeZone()),
        end: toZonedInput(event.end, timeZone ?? browserTimeZone()),
        allDay: false,
        timeZone,
    };
}

/** Convert editor values when the "All day" checkbox is toggled. */
export function switchEditMode(fields: EventEditFields, allDay: boolean): EventEditFields {
    if (fields.allDay === allDay) return fields;
    if (allDay) return { ...fields, start: fields.start.slice(0, 10), end: fields.end.slice(0, 10), allDay };
    return { ...fields, start: `${fields.start.slice(0, 10)}T00:00`, end: `${fields.end.slice(0, 10)}T23:59`, allDay };
}

export type EditFieldsResult =
    | { ok: true; changes: { start: string; end: string; all_day: boolean; timezone?: string } }
    | { ok: false; error: string };

/** All-day API bounds from an inclusive `YYYY-MM-DD` range (end is exclusive). */
export function allDayBounds(startDay: string, lastDay: string): { start: string; end: string } {
    return { start: startDay, end: addDays(lastDay < startDay ? startDay : lastDay, 1) };
}

/** Editor values → API payload, or a validation error. */
export function fromEditFields(fields: EventEditFields): EditFieldsResult {
    if (!fields.start || !fields.end) return { ok: false, error: 'Start and end are required.' };
    const zone = fields.timeZone ? { timezone: fields.timeZone } : {};
    if (fields.allDay) {
        if (fields.end < fields.start) return { ok: false, error: 'End must be on or after start.' };
        return { ok: true, changes: { ...allDayBounds(fields.start, fields.end), all_day: true, ...zone } };
    }
    const inputZone = fields.timeZone ?? browserTimeZone();
    const start = zonedInputToIso(fields.start, inputZone);
    const end = zonedInputToIso(fields.end, inputZone);
    if (end <= start) return { ok: false, error: 'End must be after start.' };
    return { ok: true, changes: { start, end, all_day: false, ...zone } };
}

/** `Thu, Oct 1`; all-day dates are read in UTC, timed ones in `timeZone` (viewer's when omitted). */
export function formatEventDate(date: Date, { allDay = false, timeZone }: { allDay?: boolean; timeZone?: string | null } = {}): string {
    return date.toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        timeZone: allDay ? 'UTC' : timeZone || undefined,
    });
}

export function formatEventTime(date: Date, timeZone?: string | null): string {
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone: timeZone || undefined });
}

/** Last day an all-day event covers (its end is exclusive). */
export function allDayLastDay(event: EventTimes): Date {
    const start = new Date(event.start);
    const last = new Date(new Date(event.end).getTime() - 1);
    return last < start ? start : last;
}

export function isSameEventDay(event: EventTimes): boolean {
    if (event.all_day) return utcDay(event.start) === utcDay(allDayLastDay(event).toISOString());
    const timeZone = event.timezone || undefined;
    return dayKey(new Date(event.start), timeZone) === dayKey(new Date(event.end), timeZone);
}

/** `12–14 Oct 2026`: start and last day, without repeating a shared month or year. */
export function formatCompactDateRange(event: EventTimes): string {
    const zone = eventDisplayZone(event);
    const start = new Date(event.start);
    const last = event.all_day ? allDayLastDay(event) : new Date(event.end);
    const [sy, sm, sd] = dayKey(start, zone).split('-');
    const [ey, em, ed] = dayKey(last, zone).split('-');
    const month = (d: Date) => d.toLocaleDateString('en-GB', { month: 'short', timeZone: zone });
    const startDay = `${Number(sd)} ${month(start)}`;
    const lastDay = `${Number(ed)} ${month(last)}`;
    if (sy !== ey) return `${startDay} ${sy} – ${lastDay} ${ey}`;
    if (sm !== em) return `${startDay} – ${lastDay} ${sy}`;
    if (sd !== ed) return `${Number(sd)}–${Number(ed)} ${month(start)} ${sy}`;
    return `${startDay} ${sy}`;
}

/** One-line summary in the event's zone; multi-day events always include the end date. */
export function formatEventWhen(event: EventTimes): string {
    const start = new Date(event.start);
    const end = new Date(event.end);
    const sameDay = isSameEventDay(event);
    if (event.all_day) {
        return sameDay
            ? formatEventDate(start, { allDay: true })
            : `${formatEventDate(start, { allDay: true })} – ${formatEventDate(allDayLastDay(event), { allDay: true })}`;
    }
    const tz = event.timezone;
    return sameDay
        ? `${formatEventDate(start, { timeZone: tz })} · ${formatEventTime(start, tz)} – ${formatEventTime(end, tz)}`
        : `${formatEventDate(start, { timeZone: tz })} · ${formatEventTime(start, tz)} – ${formatEventDate(end, { timeZone: tz })}, ${formatEventTime(end, tz)}`;
}

/** `21:00 your time` when the viewer's clock differs from the event's; '' otherwise. */
export function viewerTimeHint(event: EventTimes): string {
    if (event.all_day || !event.timezone) return '';
    const start = new Date(event.start);
    const theirs = formatEventTime(start, event.timezone);
    const mine = formatEventTime(start);
    if (theirs === mine) return '';
    return dayKey(start, event.timezone) === dayKey(start)
        ? `${mine} your time`
        : `${formatEventDate(start)}, ${mine} your time`;
}

/** Compact duration such as `3h`, `2h 30m`, `1d 4h` or `3 days`; '' when invalid. */
export function eventDurationLabel(event: EventTimes): string {
    if (event.all_day) {
        const first = Date.parse(`${utcDay(event.start)}T00:00:00Z`);
        const last = Date.parse(`${utcDay(allDayLastDay(event).toISOString())}T00:00:00Z`);
        const days = Math.round((last - first) / DAY_MS) + 1;
        return `${days} day${days === 1 ? '' : 's'}`;
    }
    const minutes = Math.round((Date.parse(event.end) - Date.parse(event.start)) / 60000);
    if (minutes <= 0) return '';
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const mins = minutes % 60;
    const parts = [days ? `${days}d` : '', hours ? `${hours}h` : '', mins ? `${mins}m` : ''].filter(Boolean);
    return parts.join(' ');
}

/** `Lisbon time (GMT+1)` for an IANA zone, using its offset at `at`. */
export function timeZoneLabel(timeZone: string, at: Date = new Date()): string {
    const city = (timeZone.split('/').pop() ?? timeZone).replace(/_/g, ' ');
    let offset = '';
    try {
        offset = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' })
            .formatToParts(at)
            .find((part) => part.type === 'timeZoneName')?.value ?? '';
    } catch {
        return timeZone;
    }
    return offset ? `${city} time (${offset})` : `${city} time`;
}

export function supportedTimeZones(): string[] {
    const intl = Intl as typeof Intl & { supportedValuesOf?: (key: 'timeZone') => string[] };
    return intl.supportedValuesOf?.('timeZone') ?? [browserTimeZone()];
}
