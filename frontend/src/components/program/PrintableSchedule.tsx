import type { ProgramExport, ProgramExportSession, ScheduleRoom } from '../../types';
import { formatDayLabel, minuteOfProgramDay } from '../../utils/schedule';
import { roomColor } from './RoomPill';

interface Props {
    program: ProgramExport;
    days: string[];
    sessions: ProgramExportSession[];
    eyebrow?: string;
}

const SLOT_MINUTES = 15;

interface TimeRange {
    start: number;
    end: number;
}

interface DayGroup {
    day: string;
    sessions: ProgramExportSession[];
    columns: Array<ScheduleRoom | null>;
}

export default function PrintableSchedule({ program, days, sessions, eyebrow = 'Published program' }: Props) {
    const dayGroups = buildDayGroups(days, sessions, program);
    const range = scheduleRange(sessions, program);

    return (
        <div className="program-calendar-pages">
            <PrintableSheet program={program} groups={dayGroups} range={range} eyebrow={eyebrow} />
        </div>
    );
}

function PrintableSheet({ program, groups, range, eyebrow }: { program: ProgramExport; groups: DayGroup[]; range: TimeRange; eyebrow: string }) {
    const visibleGroups = groups.map((group) => ({
        ...group,
        sessions: group.sessions.filter((session) => {
            const start = minuteOfProgramDay(session.start, program.timezone, program.day_start_hour);
            return start < range.end && sessionEndMinute(session, program) > range.start;
        }),
    }));
    const columns = visibleGroups.flatMap((group) => group.columns.map((room) => ({ day: group.day, room })));
    const visibleSessions = visibleGroups.flatMap((group) => group.sessions);
    const rowCount = Math.ceil((range.end - range.start) / SLOT_MINUTES);
    const dayLabel = groups.length === 1
        ? formatDayLabel(groups[0].day, true)
        : `${formatDayLabel(groups[0].day)} – ${formatDayLabel(groups[groups.length - 1].day)}`;

    return (
        <section
            className="program-calendar-sheet overflow-hidden border border-card-line bg-surface text-ink shadow-sm"
            style={{
                minWidth: `${Math.max(1180, 52 + columns.length * 132)}px`,
                minHeight: `${Math.max(680, 110 + rowCount * 12)}px`,
            }}
            data-testid="program-calendar-sheet"
        >
            <header className="program-calendar-sheet-header flex items-end justify-between gap-6 border-b border-line px-7 py-5">
                <div className="min-w-0">
                    <p className="text-xs font-bold uppercase text-action">{eyebrow}</p>
                    <h2 className="truncate text-2xl font-bold">{program.event_title}</h2>
                </div>
                <div className="shrink-0 text-right">
                    <p className="text-lg font-bold">{dayLabel}</p>
                    <p className="text-xs text-ink-soft">{formatMinute(range.start, program.day_start_hour)}–{formatMinute(range.end, program.day_start_hour)}</p>
                    <p className="text-[10px] text-muted">{program.timezone} · {program.version > 0 ? `Version ${program.version}` : 'Draft'}</p>
                </div>
            </header>

            {visibleSessions.length ? (
                <div
                    className="program-calendar-grid grid min-h-0 flex-1"
                    style={{
                        gridTemplateColumns: `52px repeat(${columns.length}, minmax(0, 1fr))`,
                        gridTemplateRows: `34px 30px repeat(${rowCount}, minmax(12px, auto))`,
                    }}
                >
                    <div className="border-b border-r border-line bg-canvas" style={{ gridColumn: 1, gridRow: '1 / span 2' }} />
                    {groups.map((group) => {
                        const firstColumn = columns.findIndex((column) => column.day === group.day) + 2;
                        return (
                            <div
                                key={group.day}
                                className="flex min-w-0 items-center justify-center border-b border-r border-line bg-canvas px-2 text-center text-xs font-bold"
                                style={{ gridColumn: `${firstColumn} / span ${group.columns.length}`, gridRow: 1 }}
                                data-testid={`program-calendar-${group.day}`}
                            >
                                <span className="truncate">{formatDayLabel(group.day, true)}</span>
                            </div>
                        );
                    })}
                    {columns.map(({ day, room }, index) => {
                        const color = roomColor(room?.color ?? 'slate');
                        return <div key={`${day}-${room?.id ?? 'event-wide'}`} className={`flex min-w-0 items-center justify-center border-b border-r border-line px-2 text-center text-[10px] font-bold ${color.header}`} style={{ gridColumn: index + 2, gridRow: 2 }}><span className="truncate">{room?.name ?? 'Event-wide'}</span></div>;
                    })}

                    {groups.slice(1).map((group) => {
                        const firstColumn = columns.findIndex((column) => column.day === group.day) + 2;
                        return <div key={`separator-${group.day}`} className="pointer-events-none z-20 border-l-2 border-line" style={{ gridColumn: firstColumn, gridRow: '1 / -1' }} data-testid={`program-calendar-day-separator-${group.day}`} />;
                    })}

                    {Array.from({ length: Math.ceil((range.end - range.start) / 60) }, (_, index) => range.start + index * 60).map((minute) => {
                        const row = Math.floor((minute - range.start) / SLOT_MINUTES) + 3;
                        const hour = (program.day_start_hour + Math.floor(minute / 60)) % 24;
                        return <div key={minute} className="contents">
                            <div className="border-r border-t border-line bg-surface pr-2 pt-1 text-right text-[10px] font-semibold text-ink-soft" style={{ gridColumn: 1, gridRow: row }}>{String(hour).padStart(2, '0')}:00</div>
                            <div className="border-t border-line" style={{ gridColumn: `2 / ${columns.length + 2}`, gridRow: row }} />
                        </div>;
                    })}

                    {visibleSessions.map((session) => {
                        const room = program.rooms.find((item) => item.id === session.room_id);
                        const level = program.levels.find((item) => item.id === session.level_id);
                        const fullLevelLabel = session.level || level?.label;
                        const compactLevelLabel = level?.notation || fullLevelLabel;
                        const contributorNames = session.contributors
                            .map((assignment) => program.contributors.find((contributor) => contributor.id === assignment.contributor_id)?.display_name)
                            .filter((name): name is string => Boolean(name))
                            .join(', ') || session.instructors;
                        const roomIndex = columns.findIndex((column) => column.day === session.program_day && (column.room?.id ?? null) === session.room_id);
                        const color = roomColor(room?.color ?? 'slate');
                        const sessionStart = Math.max(range.start, minuteOfProgramDay(session.start, program.timezone, program.day_start_hour));
                        const sessionEnd = Math.min(range.end, sessionEndMinute(session, program));
                        const firstRow = Math.floor((sessionStart - range.start) / SLOT_MINUTES) + 3;
                        const span = Math.max(1, Math.ceil((sessionEnd - sessionStart) / SLOT_MINUTES));
                        return (
                            <article
                                key={session.id}
                                className={`program-calendar-session z-10 m-0.5 min-w-0 border px-1.5 py-1 ${color.cell} ${session.is_cancelled ? 'opacity-60' : ''}`}
                                style={{ gridColumn: roomIndex + 2, gridRow: `${firstRow} / span ${span}` }}
                                data-room={room?.name ?? 'Event-wide'}
                            >
                                <div className="flex min-w-0 items-start gap-1">
                                    <p className={`min-w-0 flex-1 whitespace-normal text-[10px] font-bold leading-3 ${session.is_cancelled ? 'line-through' : ''}`}>{session.title}</p>
                                    {fullLevelLabel ? <span className="program-calendar-level-full shrink-0 text-[8px] font-semibold leading-3 text-action">{fullLevelLabel}</span> : null}
                                    {compactLevelLabel ? <span className="program-calendar-level-compact shrink-0 text-[8px] font-semibold leading-3 text-action">{compactLevelLabel}</span> : null}
                                </div>
                                {contributorNames ? <p className="program-calendar-contributors mt-0.5 whitespace-normal break-words text-[9px] leading-3 text-ink-soft">{contributorNames}</p> : null}
                                {session.is_cancelled ? <p className="text-[8px] font-bold uppercase text-danger">Cancelled</p> : null}
                            </article>
                        );
                    })}
                </div>
            ) : (
                <div className="flex flex-1 items-center justify-center text-sm font-medium text-ink-soft">No sessions match these filters.</div>
            )}
        </section>
    );
}

function buildDayGroups(days: string[], sessions: ProgramExportSession[], program: ProgramExport): DayGroup[] {
    return days.map((day) => {
        const daySessions = sessions.filter((session) => session.program_day === day);
        const usedRoomIds = new Set(daySessions.flatMap((session) => session.room_id == null ? [] : [session.room_id]));
        const rooms = program.rooms.filter((room) => usedRoomIds.has(room.id));
        const hasEventWide = daySessions.some((session) => session.room_id == null);
        return {
            day,
            sessions: daySessions,
            columns: [...rooms, ...(hasEventWide || !rooms.length ? [null] : [])],
        };
    });
}

function scheduleRange(sessions: ProgramExportSession[], program: ProgramExport): TimeRange {
    if (!sessions.length) return { start: 8 * 60, end: 18 * 60 };
    const starts = sessions.map((session) => minuteOfProgramDay(session.start, program.timezone, program.day_start_hour));
    const ends = sessions.map((session) => sessionEndMinute(session, program));
    const start = Math.max(0, Math.floor((Math.min(...starts) - 30) / 60) * 60);
    const end = Math.max(start + 8 * 60, Math.ceil((Math.max(...ends) + 30) / 60) * 60);
    return { start, end };
}

function formatMinute(minute: number, dayStartHour: number): string {
    const hour = (dayStartHour + Math.floor(minute / 60)) % 24;
    return `${String(hour).padStart(2, '0')}:00`;
}

function sessionEndMinute(session: ProgramExportSession, program: ProgramExport): number {
    const start = minuteOfProgramDay(session.start, program.timezone, program.day_start_hour);
    let end = minuteOfProgramDay(session.end, program.timezone, program.day_start_hour);
    if (end <= start) end += 24 * 60;
    return end;
}
