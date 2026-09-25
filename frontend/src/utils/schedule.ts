import type { MyPlanEntry, ScheduleSession } from '../types';

interface LocalParts {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
}

const partsFormatter = (timeZone: string) => new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
});

export function localParts(value: string | Date, timeZone: string): LocalParts {
    const values = Object.fromEntries(
        partsFormatter(timeZone)
            .formatToParts(typeof value === 'string' ? new Date(value) : value)
            .filter((part) => part.type !== 'literal')
            .map((part) => [part.type, Number(part.value)]),
    );
    return {
        year: values.year,
        month: values.month,
        day: values.day,
        hour: values.hour,
        minute: values.minute,
    };
}

export function programDayOf(value: string | Date, timeZone: string, dayStartHour: number): string {
    const parts = localParts(value, timeZone);
    const wallClock = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute));
    wallClock.setUTCHours(wallClock.getUTCHours() - dayStartHour);
    return wallClock.toISOString().slice(0, 10);
}

export function minuteOfProgramDay(
    value: string | Date,
    timeZone: string,
    dayStartHour: number,
): number {
    const parts = localParts(value, timeZone);
    let minute = parts.hour * 60 + parts.minute - dayStartHour * 60;
    if (minute < 0) minute += 24 * 60;
    return minute;
}

export function formatTime(value: string | Date, timeZone: string): string {
    return new Intl.DateTimeFormat(undefined, {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).format(typeof value === 'string' ? new Date(value) : value);
}

export function formatTimeRange(session: Pick<ScheduleSession, 'start' | 'end'>, timeZone: string): string {
    return `${formatTime(session.start, timeZone)}–${formatTime(session.end, timeZone)}`;
}

export function toZonedInput(value: string, timeZone: string): string {
    const parts = localParts(value, timeZone);
    return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}T${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

export function zonedInputToIso(value: string, timeZone: string): string {
    const [datePart, timePart] = value.split('T');
    const [year, month, day] = datePart.split('-').map(Number);
    const [hour, minute] = timePart.split(':').map(Number);
    const desired = Date.UTC(year, month - 1, day, hour, minute);
    let guess = desired;
    for (let iteration = 0; iteration < 2; iteration += 1) {
        const actual = localParts(new Date(guess), timeZone);
        const actualWallClock = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
        guess += desired - actualWallClock;
    }
    return new Date(guess).toISOString();
}

export function formatDayLabel(day: string, long = false): string {
    const date = new Date(`${day}T12:00:00Z`);
    return new Intl.DateTimeFormat(undefined, long
        ? { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }
        : { timeZone: 'UTC', weekday: 'short', day: 'numeric' }).format(date);
}

export function formatDayDateLabel(day: string): string {
    return new Intl.DateTimeFormat(undefined, {
        timeZone: 'UTC',
        weekday: 'short',
        day: 'numeric',
        month: 'short',
    }).format(new Date(`${day}T12:00:00Z`));
}

export function scheduleInstructors(sessions: ScheduleSession[]): string[] {
    return [...new Set(sessions.map((session) => session.instructors?.trim()).filter((value): value is string => Boolean(value)))]
        .sort((left, right) => left.localeCompare(right));
}

export function sessionsForDay(
    sessions: ScheduleSession[],
    day: string,
    timeZone: string,
    dayStartHour: number,
): ScheduleSession[] {
    return sessions.filter((session) => programDayOf(session.start, timeZone, dayStartHour) === day);
}

export function firstDayWithSessions(
    days: string[],
    sessions: ScheduleSession[],
    timeZone: string,
    dayStartHour: number,
): string | null {
    return days.find((day) => sessions.some(
        (session) => programDayOf(session.start, timeZone, dayStartHour) === day,
    )) ?? null;
}

export interface ScheduleFilters {
    instructor: string;
    levelIds: number[];
    activityTypeIds: number[];
}

export function filterScheduleSessions(
    sessions: ScheduleSession[],
    filters: ScheduleFilters,
): ScheduleSession[] {
    const instructor = filters.instructor.trim().toLocaleLowerCase();
    return sessions.filter((session) => (
        (!instructor || session.instructors?.toLocaleLowerCase().includes(instructor))
        && (!filters.levelIds.length || (session.level_id != null && filters.levelIds.includes(session.level_id)))
        && (!filters.activityTypeIds.length || (session.activity_type_id != null && filters.activityTypeIds.includes(session.activity_type_id)))
    ));
}

export function isSessionActive(session: ScheduleSession, now: Date): boolean {
    const timestamp = now.getTime();
    return new Date(session.start).getTime() <= timestamp && timestamp < new Date(session.end).getTime();
}

export function focusedPlanEntry(
    entries: MyPlanEntry[],
    now: Date,
): { entry: MyPlanEntry; status: 'now' | 'next' } | null {
    const eligible = entries
        .filter((entry) => entry.status === 'active')
        .sort((left, right) => left.session.start.localeCompare(right.session.start));
    const active = eligible.find((entry) => isSessionActive(entry.session, now));
    if (active) return { entry: active, status: 'now' };
    const upcoming = eligible.find((entry) => new Date(entry.session.start).getTime() > now.getTime());
    return upcoming ? { entry: upcoming, status: 'next' } : null;
}

export function sessionsAtHour(
    sessions: ScheduleSession[],
    hourStartMinute: number,
    timeZone: string,
    dayStartHour: number,
): ScheduleSession[] {
    const hourEnd = hourStartMinute + 60;
    return sessions.filter((session) => {
        const start = minuteOfProgramDay(session.start, timeZone, dayStartHour);
        let end = minuteOfProgramDay(session.end, timeZone, dayStartHour);
        if (end <= start) end += 24 * 60;
        return start < hourEnd && end > hourStartMinute;
    });
}

export function sessionsOverlap(left: ScheduleSession, right: ScheduleSession): boolean {
    return new Date(left.start).getTime() < new Date(right.end).getTime()
        && new Date(right.start).getTime() < new Date(left.end).getTime();
}

export function findPlanConflicts(entries: MyPlanEntry[]): Map<string, string[]> {
    const active = entries.filter((entry) => entry.status === 'active');
    const conflicts = new Map<string, string[]>();
    for (let leftIndex = 0; leftIndex < active.length; leftIndex += 1) {
        const left = active[leftIndex];
        for (let rightIndex = leftIndex + 1; rightIndex < active.length; rightIndex += 1) {
            const right = active[rightIndex];
            if (sessionsOverlap(left.session, right.session)) {
                conflicts.set(left.session_id, [...(conflicts.get(left.session_id) ?? []), right.session.title]);
                conflicts.set(right.session_id, [...(conflicts.get(right.session_id) ?? []), left.session.title]);
            }
        }
    }
    return conflicts;
}
