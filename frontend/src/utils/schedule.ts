import type { AdminEventSchedule, EventSchedule, MyPlanEntry, ScheduleChange, ScheduleIssue, ScheduleOverviewItem, ScheduleSession } from '../types';

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

const FIELD_LABELS: Record<string, string> = {
    title: 'title',
    subtitle: 'subtitle',
    start: 'time',
    end: 'time',
    room_id: 'room',
    room_ids: 'room',
    venue_id: 'venue',
    level_id: 'level',
    activity_type_id: 'type',
    contributors: 'instructors',
    instructors: 'instructors',
    description: 'description',
    attendee_note: 'note',
    allow_plan: 'My Plan',
    is_cancelled: 'cancelled',
    url: 'link',
    url_label: 'link',
    opens_detail: 'detail link',
    parent_id: 'parent',
};
// Shown to attendees under "Updated"; time, room, title and cancellation get their own lines.
const DETAIL_FIELDS = new Set(['subtitle', 'level_id', 'activity_type_id', 'contributors', 'instructors', 'description', 'attendee_note', 'url', 'url_label']);

const unique = (values: string[]) => [...new Set(values)];

/** Human names of changed fields, e.g. ["time", "room", "level"]. */
export function changedFieldLabels(fields: string[]): string[] {
    return unique(fields.filter((field) => field !== 'sort_order' && field !== 'external_id').map((field) => FIELD_LABELS[field] ?? field.replaceAll('_', ' ')));
}

const UPDATE_HEADINGS = ['New', 'Moved', 'Renamed', 'Updated', 'Cancelled', 'Back on', 'Removed'] as const;

/**
 * Attendee-facing summary of a publish review, one line per kind of change, e.g.
 * "New: A, B\nMoved: C → Sat 15:00 · Room B\nUpdated: D (level)".
 */
export function programUpdateMessage(changes: ScheduleChange[], timeZone = 'UTC', maxLength = 255): string {
    const entries: Array<{ heading: typeof UPDATE_HEADINGS[number]; text: string }> = [];
    const when = new Intl.DateTimeFormat(undefined, { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    for (const change of changes) {
        if (change.entity_type !== 'session' && change.entity_type !== 'overview_item') continue;
        if (change.operation === 'create') { entries.push({ heading: 'New', text: change.label }); continue; }
        if (change.operation === 'remove') { entries.push({ heading: 'Removed', text: change.label }); continue; }
        const field = (name: string) => change.fields.find((row) => row.field === name);
        const cancelled = field('is_cancelled');
        if (cancelled?.after === true) { entries.push({ heading: 'Cancelled', text: change.label }); continue; }
        if (cancelled?.after === false) entries.push({ heading: 'Back on', text: change.label });
        const title = field('title');
        if (title) entries.push({ heading: 'Renamed', text: `${String(title.before)} → ${change.label}` });
        const start = field('start')?.after;
        const end = field('end')?.after;
        const validDate = (value: unknown) => typeof value === 'string' && !Number.isNaN(Date.parse(value));
        const time = validDate(start) ? when.format(new Date(start as string)) : validDate(end) ? `ends ${formatTime(end as string, timeZone)}` : (field('start') || field('end')) ? 'new time' : null;
        const rooms = field('room_ids');
        const place = rooms?.after ? String(rooms.after) : (rooms || field('room_id') || field('venue_id')) ? 'new location' : null;
        if (time || place) entries.push({ heading: 'Moved', text: `${change.label} → ${[time, place].filter(Boolean).join(' · ')}` });
        const details = changedFieldLabels(change.fields.map((row) => row.field).filter((name) => DETAIL_FIELDS.has(name)));
        if (details.length) entries.push({ heading: 'Updated', text: `${change.label} (${details.join(', ')})` });
    }
    if (!entries.length) return 'Program details were updated. Review the latest schedule.';
    const render = (count: number) => {
        const lines: string[] = [];
        for (const heading of UPDATE_HEADINGS) {
            const shown = entries.slice(0, count).filter((entry) => entry.heading === heading).map((entry) => entry.text);
            if (shown.length) lines.push(`${heading}: ${shown.join(', ')}`);
        }
        if (count < entries.length) lines.push(`+${entries.length - count} more`);
        return lines.join('\n');
    };
    for (let count = entries.length; count > 0; count -= 1) {
        const text = render(count);
        if (text.length <= maxLength) return text;
    }
    return `${entries.length} program changes. Review the latest schedule.`;
}

export interface DraftStatus {
    status: 'new' | 'edited';
    fields: string[];
}

/** Unpublished state of each session and overview item; empty before the first publish. */
export function draftStatuses(schedule: Pick<AdminEventSchedule, 'version' | 'diff'>): Map<string, DraftStatus> {
    const statuses = new Map<string, DraftStatus>();
    if (schedule.version == null) return statuses;
    for (const id of schedule.diff.added_session_ids) statuses.set(id, { status: 'new', fields: [] });
    for (const [id, fields] of Object.entries(schedule.diff.changed_sessions)) {
        const labels = changedFieldLabels(fields);
        if (labels.length) statuses.set(id, { status: 'edited', fields: labels });
    }
    for (const change of schedule.diff.changes ?? []) {
        if (change.entity_type !== 'overview_item' || change.operation === 'remove') continue;
        const labels = changedFieldLabels(change.fields.map((row) => row.field));
        if (change.operation === 'create') statuses.set(change.entity_id, { status: 'new', fields: [] });
        else if (labels.length) statuses.set(change.entity_id, { status: 'edited', fields: labels });
    }
    return statuses;
}

/** Issues keyed by every session and overview item they mention. */
export function issuesByItem(issues: ScheduleIssue[]): Map<string, ScheduleIssue[]> {
    const map = new Map<string, ScheduleIssue[]>();
    for (const issue of issues) {
        for (const id of [...issue.session_ids, ...(issue.overview_item_ids ?? [])]) map.set(id, [...(map.get(id) ?? []), issue]);
    }
    return map;
}

export interface OverlapLane {
    lane: number;
    lanes: number;
}

/**
 * Side-by-side lanes for sessions that overlap in time and share a grid column, so each stays visible.
 * Sessions without a room in `columnRoomIds` span every column.
 */
export function overlapLanes(sessions: ScheduleSession[], columnRoomIds: number[]): Map<string, OverlapLane> {
    const columnsOf = (session: ScheduleSession) => {
        const ids = sessionRoomIds(session).filter((id) => columnRoomIds.includes(id));
        return ids.length ? ids : columnRoomIds;
    };
    const sorted = [...sessions].sort((left, right) => left.start.localeCompare(right.start) || right.end.localeCompare(left.end));
    const columns = new Map(sorted.map((session) => [session.id, new Set(columnsOf(session))]));
    const clash = (left: ScheduleSession, right: ScheduleSession) => sessionsOverlap(left, right)
        && [...(columns.get(left.id) ?? [])].some((id) => columns.get(right.id)?.has(id));
    const parent = new Map(sorted.map((session) => [session.id, session.id]));
    const root = (id: string): string => {
        const next = parent.get(id) ?? id;
        return next === id ? id : root(next);
    };
    for (let left = 0; left < sorted.length; left += 1) {
        for (let right = left + 1; right < sorted.length; right += 1) {
            if (clash(sorted[left], sorted[right])) parent.set(root(sorted[right].id), root(sorted[left].id));
        }
    }
    const laneOf = new Map<string, number>();
    const clusterLanes = new Map<string, number>();
    for (const session of sorted) {
        const placed = sorted.filter((other) => laneOf.has(other.id) && clash(other, session));
        let lane = 0;
        while (placed.some((other) => laneOf.get(other.id) === lane)) lane += 1;
        laneOf.set(session.id, lane);
        const cluster = root(session.id);
        clusterLanes.set(cluster, Math.max(clusterLanes.get(cluster) ?? 0, lane + 1));
    }
    return new Map(sorted.map((session) => [session.id, { lane: laneOf.get(session.id) ?? 0, lanes: clusterLanes.get(root(session.id)) ?? 1 }]));
}
