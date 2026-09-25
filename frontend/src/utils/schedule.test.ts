import { describe, expect, it } from 'vitest';
import { filterScheduleSessions, findPlanConflicts, firstDayWithSessions, focusedPlanEntry, formatDayLabel, isSessionActive, minuteOfProgramDay, programDayOf, toZonedInput, zonedInputToIso } from './schedule';
import type { MyPlanEntry, ScheduleSession } from '../types';

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

describe('schedule time helpers', () => {
    it('keeps early-morning sessions on the previous program day', () => {
        expect(programDayOf('2026-10-17T00:30:00Z', 'Europe/Prague', 6)).toBe('2026-10-16');
        expect(minuteOfProgramDay('2026-10-17T00:30:00Z', 'Europe/Prague', 6)).toBe(20 * 60 + 30);
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

    it('round-trips an event-local wall clock through UTC', () => {
        const iso = zonedInputToIso('2026-10-16T14:00', 'Europe/Prague');
        expect(iso).toBe('2026-10-16T12:00:00.000Z');
        expect(toZonedInput(iso, 'Europe/Prague')).toBe('2026-10-16T14:00');
    });

    it('formats a program-day key without shifting its calendar date', () => {
        expect(formatDayLabel('2026-10-16')).toContain('16');
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
