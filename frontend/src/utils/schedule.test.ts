import { describe, expect, it } from 'vitest';
import { filterScheduleSessions, findPlanConflicts, firstDayWithSessions, focusedPlanEntry, formatDayDateLabel, formatDayLabel, isSessionActive, minuteOfProgramDay, overviewItemOpensSchedule, overviewItemsForDay, programDayOf, programUpdateMessage, roomColumnRuns, scheduleInstructors, sessionRoomIds, sessionSpan, sessionsInOverviewWindow, sessionsOverlap, toZonedInput, zonedInputToIso } from './schedule';
import type { MyPlanEntry, ScheduleChange, ScheduleOverviewItem, ScheduleSession } from '../types';

describe('programUpdateMessage', () => {
    const change = (label: string, operation: ScheduleChange['operation'], fields: string[] = [], after: unknown = 'x'): ScheduleChange => ({
        entity_type: 'session', operation, entity_id: label, label, fields: fields.map((field) => ({ field, before: null, after })),
    });

    it('groups session changes without naming the event', () => {
        expect(programUpdateMessage([
            change('Musicality', 'create'),
            change('Salsa On2', 'update', ['start', 'end', 'room_ids']),
            change('Afro', 'update', ['is_cancelled'], true),
            change('Kizomba', 'remove'),
            { ...change('Main Hall', 'update', ['name']), entity_type: 'room' },
        ])).toBe('New: Musicality. Changed: Salsa On2 (time, room). Cancelled: Afro. Removed: Kizomba.');
    });

    it('stays within the limit and counts what it left out', () => {
        const message = programUpdateMessage(Array.from({ length: 30 }, (_, index) => change(`Workshop number ${index + 1}`, 'create')), 120);
        expect(message.length).toBeLessThanOrEqual(120);
        expect(message).toMatch(/^New: Workshop number 1, .* \+\d+ more\.$/);
    });

    it('falls back when only configuration changed', () => {
        expect(programUpdateMessage([])).toBe('Program details were updated. Review the latest schedule.');
    });
});

const session = (id: string, start: string, end: string): ScheduleSession => ({
    id,
    title: id,
    instructors: null,
    start,
    end,
    room_id: null,
    venue_id: null,
    level_id: null,
    activity_type_id: null,
    attendee_note: null,
    allow_plan: true,
    is_cancelled: false,
});

const overviewItem = (id: string, start: string, end: string, extra: Partial<ScheduleOverviewItem> = {}): ScheduleOverviewItem => ({
    id, parent_id: null, title: id, subtitle: null, description: null, url: null, url_label: null,
    start, end, activity_type_id: null, venue_id: null, room_ids: [], opens_detail: false, is_cancelled: false, sort_order: 0,
    ...extra,
});

describe('overview helpers', () => {
    it('groups moments under their after-midnight parent on the same program day', () => {
        const items = [
            overviewItem('Party', '2026-10-16T20:30:00Z', '2026-10-17T03:00:00Z'),
            overviewItem('Artist hour', '2026-10-17T00:00:00Z', '2026-10-17T01:00:00Z', { parent_id: 'Party' }),
            overviewItem('Shows', '2026-10-16T22:00:00Z', '2026-10-16T22:30:00Z', { parent_id: 'Party' }),
            overviewItem('Workshops', '2026-10-16T09:00:00Z', '2026-10-16T14:00:00Z'),
        ];
        const entries = overviewItemsForDay(items, '2026-10-16', 'Europe/Prague', 6);
        expect(entries.map((entry) => entry.item.id)).toEqual(['Workshops', 'Party']);
        expect(entries[1].moments.map((moment) => moment.id)).toEqual(['Shows', 'Artist hour']);
        expect(overviewItemsForDay(items, '2026-10-17', 'Europe/Prague', 6)).toEqual([]);
    });

    it('counts only active sessions starting inside [start, end)', () => {
        const block = overviewItem('Workshops', '2026-10-16T11:00:00Z', '2026-10-16T15:00:00Z', { opens_detail: true });
        const sessions = [
            session('at-start', '2026-10-16T11:00:00Z', '2026-10-16T12:00:00Z'),
            session('before', '2026-10-16T10:30:00Z', '2026-10-16T11:30:00Z'),
            session('at-end', '2026-10-16T15:00:00Z', '2026-10-16T16:00:00Z'),
            { ...session('cancelled', '2026-10-16T12:00:00Z', '2026-10-16T13:00:00Z'), is_cancelled: true },
        ];
        expect(sessionsInOverviewWindow(sessions, block).map((row) => row.id)).toEqual(['at-start']);
        expect(overviewItemOpensSchedule(block, sessions)).toBe(true);
        expect(overviewItemOpensSchedule({ ...block, opens_detail: false }, sessions)).toBe(false);
        expect(overviewItemOpensSchedule(block, [])).toBe(false);
    });
});

describe('schedule room helpers', () => {
    it('falls back to room_id for sessions published before multi-room support', () => {
        expect(sessionRoomIds({ room_id: 4 })).toEqual([4]);
        expect(sessionRoomIds({ room_id: null })).toEqual([]);
        expect(sessionRoomIds({ room_id: 1, room_ids: [1, 2] })).toEqual([1, 2]);
    });

    it('groups rooms into runs of adjacent columns', () => {
        expect(roomColumnRuns([2, 1], [1, 2, 3])).toEqual([[0, 2]]);
        expect(roomColumnRuns([1, 3], [1, 2, 3])).toEqual([[0, 1], [2, 3]]);
        expect(roomColumnRuns([9], [1, 2])).toEqual([]);
    });
});

describe('schedule time helpers', () => {
    it('keeps early-morning sessions on the previous program day', () => {
        expect(programDayOf('2026-10-17T00:30:00Z', 'Europe/Prague', 6)).toBe('2026-10-16');
        expect(minuteOfProgramDay('2026-10-17T00:30:00Z', 'Europe/Prague', 6)).toBe(20 * 60 + 30);
    });

    it('keeps the duration of sessions that end after midnight', () => {
        // 22:00 to 00:00 Prague time: 2h long, ending on the next wall-clock day.
        expect(sessionSpan(session('late', '2026-10-16T20:00:00Z', '2026-10-16T22:00:00Z'), 'Europe/Prague', 6)).toEqual({ start: 16 * 60, end: 18 * 60 });
        // Same-day session keeps its own end.
        expect(sessionSpan(session('day', '2026-10-16T10:00:00Z', '2026-10-16T12:00:00Z'), 'Europe/Prague', 6)).toEqual({ start: 6 * 60, end: 8 * 60 });
    });

    it('reports overlaps without treating touching sessions as conflicts', () => {
        const entries: MyPlanEntry[] = [
            { session_id: 'a', status: 'active', session: session('A', '2026-10-16T12:00:00Z', '2026-10-16T13:00:00Z') },
            { session_id: 'b', status: 'active', session: session('B', '2026-10-16T12:30:00Z', '2026-10-16T13:30:00Z') },
            { session_id: 'c', status: 'active', session: session('C', '2026-10-16T13:30:00Z', '2026-10-16T14:30:00Z') },
        ];
        expect(findPlanConflicts(entries).get('a')).toEqual(['B']);
        expect(findPlanConflicts(entries).has('c')).toBe(false);
    });

    it('reports conflicts between planned sessions and overview items', () => {
        const bootcamp: ScheduleOverviewItem = {
            id: 'bootcamp', parent_id: null, title: 'Bootcamp part 1', subtitle: null, description: null, url: null, url_label: null,
            start: '2026-10-16T12:30:00Z', end: '2026-10-16T14:00:00Z', activity_type_id: null, venue_id: null, room_ids: [],
            opens_detail: false, allow_plan: true, is_cancelled: false, sort_order: 0,
        };
        const entries: MyPlanEntry[] = [
            { session_id: 'a', status: 'active', session: session('A', '2026-10-16T12:00:00Z', '2026-10-16T13:00:00Z') },
            { kind: 'overview_item', overview_item_id: 'bootcamp', status: 'active', overview_item: bootcamp },
        ];
        expect(findPlanConflicts(entries).get('bootcamp')).toEqual(['A']);
        expect(findPlanConflicts(entries).get('a')).toEqual(['Bootcamp part 1']);
        expect(focusedPlanEntry(entries, new Date('2026-10-16T13:30:00Z'))?.entry).toBe(entries[1]);
    });

    it('does not treat equivalent mixed-precision boundaries as overlapping', () => {
        const first = session('Crazy Partnerwork', '2026-10-17T12:00:00Z', '2026-10-17T13:00:00Z');
        const second = session('Latin Salsa Fusion', '2026-10-17T13:00:00.000Z', '2026-10-17T14:00:00.000Z');

        expect(sessionsOverlap(first, second)).toBe(false);
    });

    it('round-trips an event-local wall clock through UTC', () => {
        const iso = zonedInputToIso('2026-10-16T14:00', 'Europe/Prague');
        expect(iso).toBe('2026-10-16T12:00:00.000Z');
        expect(toZonedInput(iso, 'Europe/Prague')).toBe('2026-10-16T14:00');
    });

    it('formats a program-day key without shifting its calendar date', () => {
        expect(formatDayLabel('2026-10-16')).toContain('16');
        expect(formatDayDateLabel('2026-10-16')).toMatch(/Fri.*16|16.*Fri/);
    });

    it('finds the first configured day containing sessions', () => {
        expect(firstDayWithSessions(
            ['2026-10-15', '2026-10-16'],
            [session('Friday', '2026-10-16T12:00:00Z', '2026-10-16T13:00:00Z')],
            'Europe/Prague',
            6,
        )).toBe('2026-10-16');
    });

    it('filters by instructor, level and activity type', () => {
        const alexis = { ...session('Alexis', '2026-10-16T12:00:00Z', '2026-10-16T13:00:00Z'), instructors: 'Alexis Ruiz', level_id: 2, activity_type_id: 4 };
        const maya = { ...session('Maya', '2026-10-16T13:00:00Z', '2026-10-16T14:00:00Z'), instructors: 'Maya', level_id: 1, activity_type_id: 4 };
        expect(filterScheduleSessions([alexis, maya], { instructor: 'ruiz', levelIds: [2], activityTypeIds: [4] })).toEqual([alexis]);
        expect(scheduleInstructors([alexis, maya, { ...alexis, id: 'duplicate' }])).toEqual(['Alexis Ruiz', 'Maya']);
    });

    it('filters structured contributors by exact id', () => {
        const alex = { ...session('Alex', '2026-10-16T12:00:00Z', '2026-10-16T13:00:00Z'), instructors: 'Alex', contributors: [{ contributor_id: 1, role: 'instructor' as const, position: 0 }] };
        const alexis = { ...session('Alexis', '2026-10-16T13:00:00Z', '2026-10-16T14:00:00Z'), instructors: 'Alexis', contributors: [{ contributor_id: 2, role: 'instructor' as const, position: 0 }] };

        expect(filterScheduleSessions([alex, alexis], { instructor: 'Alex', contributorId: 1, levelIds: [], activityTypeIds: [] })).toEqual([alex]);
    });

    it('treats the end timestamp as no longer active', () => {
        const row = session('Now', '2026-10-16T12:00:00Z', '2026-10-16T13:00:00Z');
        expect(isSessionActive(row, new Date('2026-10-16T12:30:00Z'))).toBe(true);
        expect(isSessionActive(row, new Date('2026-10-16T13:00:00Z'))).toBe(false);
    });

    it('focuses an active planned session before the next upcoming session', () => {
        const entries: MyPlanEntry[] = [
            { session_id: 'active', status: 'active', session: session('Active', '2026-10-16T12:00:00Z', '2026-10-16T13:00:00Z') },
            { session_id: 'next', status: 'active', session: session('Next', '2026-10-16T14:00:00Z', '2026-10-16T15:00:00Z') },
        ];
        expect(focusedPlanEntry(entries, new Date('2026-10-16T12:30:00Z'))).toEqual({ entry: entries[0], status: 'now' });
        expect(focusedPlanEntry(entries, new Date('2026-10-16T13:30:00Z'))).toEqual({ entry: entries[1], status: 'next' });
        expect(focusedPlanEntry(entries, new Date('2026-10-16T16:00:00Z'))).toBeNull();
    });
});
