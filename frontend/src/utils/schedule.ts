import type { EventSchedule, MyPlanEntry, ScheduleChange, ScheduleOverviewItem, ScheduleSession } from '../types';

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

/** Program-day minutes of a session; the end comes from the duration so spans past the day boundary keep their length. */
export function sessionSpan(session: Pick<ScheduleSession, 'start' | 'end'>, timeZone: string, dayStartHour: number): { start: number; end: number } {
    const start = minuteOfProgramDay(session.start, timeZone, dayStartHour);
    const durationMinutes = Math.max(0, (new Date(session.end).getTime() - new Date(session.start).getTime()) / 60_000);
    return { start, end: start + durationMinutes };
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

export function scheduleContributorOptions(schedule: EventSchedule): Array<{ id: number | null; label: string }> {
    if (schedule.contributors?.length) {
        const referencedIds = new Set(schedule.sessions.flatMap((session) => session.contributors?.map((item) => item.contributor_id) ?? []));
        return schedule.contributors
            .filter((contributor) => referencedIds.has(contributor.id))
            .map((contributor) => ({ id: contributor.id, label: contributor.display_name }))
            .sort((left, right) => left.label.localeCompare(right.label));
    }
    return scheduleInstructors(schedule.sessions).map((label) => ({ id: null, label }));
}

export function sessionsForDay<Item extends Pick<ScheduleSession, 'start'>>(
    sessions: Item[],
    day: string,
    timeZone: string,
    dayStartHour: number,
): Item[] {
    return sessions.filter((session) => programDayOf(session.start, timeZone, dayStartHour) === day);
}

export function firstDayWithSessions(
    days: string[],
    sessions: Array<Pick<ScheduleSession, 'start'>>,
    timeZone: string,
    dayStartHour: number,
): string | null {
    return days.find((day) => sessions.some(
        (session) => programDayOf(session.start, timeZone, dayStartHour) === day,
    )) ?? null;
}

export function sessionRoomIds(session: { room_id?: number | null; room_ids?: number[] }): number[] {
    if (session.room_ids?.length) return session.room_ids;
    return session.room_id == null ? [] : [session.room_id];
}

export function sessionRooms<Room extends { id: number }>(rooms: Room[], session: { room_id?: number | null; room_ids?: number[] }): Room[] {
    return sessionRoomIds(session).flatMap((id) => rooms.find((room) => room.id === id) ?? []);
}

/** Groups a session's rooms into runs of adjacent columns, as [start, endExclusive] indexes into `columnRoomIds`. */
export function roomColumnRuns(roomIds: number[], columnRoomIds: number[]): Array<[number, number]> {
    const indexes = [...new Set(roomIds.map((id) => columnRoomIds.indexOf(id)).filter((index) => index >= 0))]
        .sort((left, right) => left - right);
    const runs: Array<[number, number]> = [];
    for (const index of indexes) {
        const last = runs[runs.length - 1];
        if (last && last[1] === index) last[1] = index + 1;
        else runs.push([index, index + 1]);
    }
    return runs;
}

export interface ScheduleFilters {
    instructor: string;
    contributorId?: number | null;
    levelIds: number[];
    activityTypeIds: number[];
}

export function filterScheduleSessions<Session extends Pick<ScheduleSession, 'instructors' | 'contributors' | 'level_id' | 'activity_type_id'>>(
    sessions: Session[],
    filters: ScheduleFilters,
): Session[] {
    const instructor = filters.instructor.trim().toLocaleLowerCase();
    return sessions.filter((session) => (
        (filters.contributorId == null
            ? (!instructor || session.instructors?.toLocaleLowerCase().includes(instructor))
            : session.contributors?.some((item) => item.contributor_id === filters.contributorId))
        && (!filters.levelIds.length || (session.level_id != null && filters.levelIds.includes(session.level_id)))
        && (!filters.activityTypeIds.length || (session.activity_type_id != null && filters.activityTypeIds.includes(session.activity_type_id)))
    ));
}

export function isSessionActive(session: Pick<ScheduleSession, 'start' | 'end'>, now: Date): boolean {
    const timestamp = now.getTime();
    return new Date(session.start).getTime() <= timestamp && timestamp < new Date(session.end).getTime();
}

export function planEntryId(entry: MyPlanEntry): string {
    return entry.kind === 'overview_item' ? entry.overview_item_id : entry.session_id;
}

/** The planned session or overview item; both carry title, time, rooms and activity type. */
export function planEntryItem(entry: MyPlanEntry): ScheduleSession | ScheduleOverviewItem {
    return entry.kind === 'overview_item' ? entry.overview_item : entry.session;
}

export function focusedPlanEntry(
    entries: MyPlanEntry[],
    now: Date,
): { entry: MyPlanEntry; status: 'now' | 'next' } | null {
    const eligible = entries
        .filter((entry) => entry.status === 'active')
        .sort((left, right) => planEntryItem(left).start.localeCompare(planEntryItem(right).start));
    const active = eligible.find((entry) => isSessionActive(planEntryItem(entry), now));
    if (active) return { entry: active, status: 'now' };
    const upcoming = eligible.find((entry) => new Date(planEntryItem(entry).start).getTime() > now.getTime());
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
        const { start, end } = sessionSpan(session, timeZone, dayStartHour);
        return start < hourEnd && end > hourStartMinute;
    });
}

export function sessionsOverlap(left: Pick<ScheduleSession, 'start' | 'end'>, right: Pick<ScheduleSession, 'start' | 'end'>): boolean {
    return new Date(left.start).getTime() < new Date(right.end).getTime()
        && new Date(right.start).getTime() < new Date(left.end).getTime();
}

export function findPlanConflicts(entries: MyPlanEntry[]): Map<string, string[]> {
    const active = entries.filter((entry) => entry.status === 'active');
    const conflicts = new Map<string, string[]>();
    for (let leftIndex = 0; leftIndex < active.length; leftIndex += 1) {
        const left = active[leftIndex];
        const leftId = planEntryId(left);
        const leftItem = planEntryItem(left);
        for (let rightIndex = leftIndex + 1; rightIndex < active.length; rightIndex += 1) {
            const right = active[rightIndex];
            const rightId = planEntryId(right);
            const rightItem = planEntryItem(right);
            if (sessionsOverlap(leftItem, rightItem)) {
                conflicts.set(leftId, [...(conflicts.get(leftId) ?? []), rightItem.title]);
                conflicts.set(rightId, [...(conflicts.get(rightId) ?? []), leftItem.title]);
            }
        }
    }
    return conflicts;
}

export interface OverviewDayEntry {
    item: ScheduleOverviewItem;
    moments: ScheduleOverviewItem[];
}

const byOverviewOrder = (left: ScheduleOverviewItem, right: ScheduleOverviewItem) => (
    new Date(left.start).getTime() - new Date(right.start).getTime()
    || left.sort_order - right.sort_order
    || left.title.localeCompare(right.title)
);

/** Top-level overview items of a program day, each with its moments in time order. */
export function overviewItemsForDay(
    items: ScheduleOverviewItem[] | undefined,
    day: string,
    timeZone: string,
    dayStartHour: number,
): OverviewDayEntry[] {
    const all = items ?? [];
    return sessionsForDay(all.filter((item) => !item.parent_id), day, timeZone, dayStartHour)
        .sort(byOverviewOrder)
        .map((item) => ({
            item,
            moments: all.filter((moment) => moment.parent_id === item.id).sort(byOverviewOrder),
        }));
}

/** Detailed sessions that start inside the item's [start, end) window. */
export function sessionsInOverviewWindow<Session extends Pick<ScheduleSession, 'start' | 'is_cancelled'>>(
    sessions: Session[],
    item: Pick<ScheduleOverviewItem, 'start' | 'end'>,
): Session[] {
    const start = new Date(item.start).getTime();
    const end = new Date(item.end).getTime();
    return sessions.filter((session) => {
        const value = new Date(session.start).getTime();
        return !session.is_cancelled && value >= start && value < end;
    });
}

export function overviewItemOpensSchedule(item: ScheduleOverviewItem, sessions: ScheduleSession[]): boolean {
    return item.opens_detail && !item.parent_id && sessionsInOverviewWindow(sessions, item).length > 0;
}

export function overviewItemHasDetails(item: ScheduleOverviewItem): boolean {
    return Boolean(item.description?.trim() || item.url);
}

const TIME_FIELDS = new Set(['start', 'end']);
const PLACE_FIELDS = new Set(['room_id', 'room_ids', 'venue_id']);

/** Attendee-facing summary of a publish review, e.g. "New: A, B. Changed: C (time)." */
export function programUpdateMessage(changes: ScheduleChange[], maxLength = 255): string {
    const groups: Array<[string, string[]]> = [['New', []], ['Changed', []], ['Cancelled', []], ['Removed', []]];
    const [added, changed, cancelled, removed] = groups.map(([, items]) => items);
    for (const change of changes) {
        if (change.entity_type !== 'session' && change.entity_type !== 'overview_item') continue;
        if (change.operation === 'create') added.push(change.label);
        else if (change.operation === 'remove') removed.push(change.label);
        else if (change.fields.some((field) => field.field === 'is_cancelled' && field.after === true)) cancelled.push(change.label);
        else {
            const fields = change.fields.map((field) => field.field);
            const aspects = [
                fields.some((field) => TIME_FIELDS.has(field)) ? 'time' : null,
                fields.some((field) => PLACE_FIELDS.has(field)) ? 'room' : null,
                fields.some((field) => !TIME_FIELDS.has(field) && !PLACE_FIELDS.has(field)) ? 'details' : null,
            ].filter(Boolean);
            changed.push(aspects.length ? `${change.label} (${aspects.join(', ')})` : change.label);
        }
    }
    const items = groups.flatMap(([heading, list]) => list.map((text) => ({ heading, text })));
    if (!items.length) return 'Program details were updated. Review the latest schedule.';
    const render = (count: number) => {
        const parts: string[] = [];
        for (const [heading] of groups) {
            const shown = items.slice(0, count).filter((item) => item.heading === heading).map((item) => item.text);
            if (shown.length) parts.push(`${heading}: ${shown.join(', ')}.`);
        }
        if (count < items.length) parts.push(`+${items.length - count} more.`);
        return parts.join(' ');
    };
    for (let count = items.length; count > 0; count -= 1) {
        const text = render(count);
        if (text.length <= maxLength) return text;
    }
    return `${items.length} program changes. Review the latest schedule.`;
}
