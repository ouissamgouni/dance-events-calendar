import { describe, expect, it } from 'vitest';
import {
    eventDurationLabel,
    formatCompactDateRange,
    formatEventWhen,
    fromEditFields,
    switchEditMode,
    toEditFields,
    viewerTimeHint,
} from './eventDates';

const timed = { start: '2026-10-01T20:00:00Z', end: '2026-10-01T23:30:00Z', all_day: false };
const allDay = { start: '2026-10-05T00:00:00Z', end: '2026-10-08T00:00:00Z', all_day: true };

describe('eventDates', () => {
    it('formats compact date ranges without repeating shared parts', () => {
        const utc = { timezone: 'UTC', all_day: false };
        expect(formatCompactDateRange({ ...utc, start: '2026-10-01T20:00:00Z', end: '2026-10-01T23:00:00Z' })).toBe('1 Oct 2026');
        expect(formatCompactDateRange(allDay)).toBe('5–7 Oct 2026');
        expect(formatCompactDateRange({ ...utc, start: '2026-10-30T20:00:00Z', end: '2026-11-02T02:00:00Z' })).toBe('30 Oct – 2 Nov 2026');
        expect(formatCompactDateRange({ ...utc, start: '2026-12-30T20:00:00Z', end: '2027-01-02T02:00:00Z' })).toBe('30 Dec 2026 – 2 Jan 2027');
    });
    it('round-trips a timed event through the editor unchanged', () => {
        expect(fromEditFields(toEditFields(timed))).toEqual({
            ok: true,
            changes: { start: '2026-10-01T20:00:00.000Z', end: '2026-10-01T23:30:00.000Z', all_day: false },
        });
    });

    it('edits in the event zone and keeps it', () => {
        const fields = toEditFields({ ...timed, timezone: 'Europe/Lisbon' });
        expect(fields).toMatchObject({ start: '2026-10-01T21:00', end: '2026-10-02T00:30', timeZone: 'Europe/Lisbon' });
        expect(fromEditFields({ ...fields, timeZone: 'Europe/Paris' })).toEqual({
            ok: true,
            changes: { start: '2026-10-01T19:00:00.000Z', end: '2026-10-01T22:30:00.000Z', all_day: false, timezone: 'Europe/Paris' },
        });
    });

    it('edits all-day events with an inclusive last day and saves an exclusive end', () => {
        const fields = toEditFields(allDay);
        expect(fields).toEqual({ start: '2026-10-05', end: '2026-10-07', allDay: true, timeZone: null });
        expect(fromEditFields(fields)).toEqual({
            ok: true,
            changes: { start: '2026-10-05', end: '2026-10-08', all_day: true },
        });
    });

    it('rejects an end before the start', () => {
        expect(fromEditFields({ start: '2026-10-02T10:00', end: '2026-10-02T09:00', allDay: false, timeZone: null }).ok).toBe(false);
        expect(fromEditFields({ start: '2026-10-05', end: '2026-10-04', allDay: true, timeZone: null }).ok).toBe(false);
    });

    it('keeps the dates when toggling all-day', () => {
        const toAllDay = switchEditMode({ start: '2026-10-01T20:00', end: '2026-10-02T02:00', allDay: false, timeZone: null }, true);
        expect(toAllDay).toEqual({ start: '2026-10-01', end: '2026-10-02', allDay: true, timeZone: null });
        expect(switchEditMode(toAllDay, false)).toMatchObject({ start: '2026-10-01T00:00', end: '2026-10-02T23:59' });
    });

    it('labels durations', () => {
        expect(eventDurationLabel(timed)).toBe('3h 30m');
        expect(eventDurationLabel({ ...timed, end: '2026-10-03T00:00:00Z' })).toBe('1d 4h');
        expect(eventDurationLabel(allDay)).toBe('3 days');
        expect(eventDurationLabel({ ...allDay, end: '2026-10-06T00:00:00Z' })).toBe('1 day');
    });

    it('shows the last day of a multi-day all-day event', () => {
        const text = formatEventWhen(allDay);
        expect(text).toContain('–');
        expect(text).toMatch(/7/);
        expect(text).not.toMatch(/8/);
    });

    it('formats in the event zone and hints the viewer time only when it differs', () => {
        const tokyo = { ...timed, timezone: 'Asia/Tokyo' };
        expect(formatEventWhen(tokyo)).toMatch(/Oct 2/);
        const mine = new Date(timed.start).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
        const theirs = new Date(timed.start).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Tokyo' });
        expect(viewerTimeHint(tokyo)).toEqual(mine === theirs ? '' : expect.stringContaining(`${mine} your time`));
        expect(viewerTimeHint(timed)).toBe('');
    });
});
