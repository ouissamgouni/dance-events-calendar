import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import type { EventSchedule, ScheduleRoom, ScheduleSession, SessionAttendanceSummary } from '../../types';
import { formatDayLabel, formatTime, isSessionActive, minuteOfProgramDay, programDayOf, roomColumnRuns, sessionRoomIds, sessionsForDay, sessionSpan, sessionsInOverviewWindow } from '../../utils/schedule';
import { scheduleColor, sessionCellColors } from '../../utils/scheduleColors';
import SessionAttendeeStack from './SessionAttendeeStack';

interface Props {
    schedule: EventSchedule;
    day: string;
    plannedSessionIds?: Set<string>;
    onSessionClick: (session: ScheduleSession) => void;
    onTimeClick: (minute: number) => void;
    positionRequest?: number;
    compactHeader?: boolean;
    attendeeSummaries?: Map<string, SessionAttendanceSummary>;
    onRoomClick?: (room: ScheduleRoom) => void;
    /** Scrolls to `start` and briefly highlights sessions starting in the window; a new token re-triggers. */
    focusWindow?: { start: string; end: string; token: string } | null;
    /** Editor-only: sessions that overlap another one in the same room. */
    conflictIds?: Set<string>;
}

const SLOT_MINUTES = 15;
const SLOT_HEIGHT = 24;

export default function ScheduleGrid({ schedule, day, plannedSessionIds, onSessionClick, onTimeClick, positionRequest = 0, compactHeader = false, attendeeSummaries, onRoomClick, focusWindow, conflictIds }: Props) {
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const positionedDays = useRef(new Set<string>());
    const handledPositionRequest = useRef(0);
    const handledFocusToken = useRef<string | null>(null);
    const [flashIds, setFlashIds] = useState<Set<string>>(() => new Set());
    const [now, setNow] = useState(() => new Date());
    useEffect(() => {
        const timer = window.setInterval(() => setNow(new Date()), 60_000);
        return () => window.clearInterval(timer);
    }, []);
    const sessions = useMemo(
        () => sessionsForDay(schedule.sessions, day, schedule.timezone, schedule.day_start_hour),
        [day, schedule],
    );
    const contributorNames = useMemo(
        () => new Map(schedule.contributors?.map((contributor) => [contributor.id, contributor.display_name]) ?? []),
        [schedule.contributors],
    );
    const usedRoomIds = new Set(sessions.flatMap(sessionRoomIds));
    const rooms = schedule.rooms.filter((room) => usedRoomIds.has(room.id));
    const columnRoomIds = rooms.map((room) => room.id);
    const hasRoomDetails = rooms.some((room) => room.details);
    const headerHeight = (compactHeader ? 40 : 48) + (hasRoomDetails ? 16 : 0);
    const startMinutes = sessions.map((session) => sessionSpan(session, schedule.timezone, schedule.day_start_hour).start);
    const endMinutes = sessions.map((session) => sessionSpan(session, schedule.timezone, schedule.day_start_hour).end);
    const axisStart = Math.max(0, Math.floor((Math.min(...startMinutes, 8 * 60) - 30) / 60) * 60);
    const axisEnd = Math.max(axisStart + 8 * 60, Math.ceil((Math.max(...endMinutes, 18 * 60) + 30) / 60) * 60);
    const rowCount = Math.ceil((axisEnd - axisStart) / SLOT_MINUTES);
    const nowDay = programDayOf(now, schedule.timezone, schedule.day_start_hour);
    const nowMinute = minuteOfProgramDay(now, schedule.timezone, schedule.day_start_hour);
    const showNow = nowDay === day && nowMinute >= axisStart && nowMinute <= axisEnd;

    useEffect(() => {
        if (!showNow || !scrollRef.current || positionedDays.current.has(day)) return;
        scrollRef.current.scrollTop = Math.max(0, ((nowMinute - axisStart) / SLOT_MINUTES) * SLOT_HEIGHT - 88);
        positionedDays.current.add(day);
    }, [axisStart, day, nowMinute, showNow]);

    useEffect(() => {
        if (!positionRequest || !scrollRef.current || handledPositionRequest.current === positionRequest) return;
        const firstMinute = sessions.length
            ? Math.min(...sessions.map((session) => minuteOfProgramDay(session.start, schedule.timezone, schedule.day_start_hour)))
            : axisStart;
        scrollRef.current.scrollTop = Math.max(0, ((firstMinute - axisStart) / SLOT_MINUTES) * SLOT_HEIGHT - 48);
        scrollRef.current.scrollLeft = 0;
        handledPositionRequest.current = positionRequest;
    }, [axisStart, positionRequest, schedule.day_start_hour, schedule.timezone, sessions]);

    useEffect(() => {
        if (!focusWindow || !scrollRef.current || handledFocusToken.current === focusWindow.token) return;
        handledFocusToken.current = focusWindow.token;
        positionedDays.current.add(day);
        const minute = minuteOfProgramDay(focusWindow.start, schedule.timezone, schedule.day_start_hour);
        scrollRef.current.scrollTop = Math.max(0, ((minute - axisStart) / SLOT_MINUTES) * SLOT_HEIGHT - 48);
        scrollRef.current.scrollLeft = 0;
        setFlashIds(new Set(sessionsInOverviewWindow(sessions, focusWindow).map((session) => session.id)));
    }, [axisStart, day, focusWindow, schedule.day_start_hour, schedule.timezone, sessions]);

    useEffect(() => {
        if (!flashIds.size) return;
        const timer = window.setTimeout(() => setFlashIds(new Set()), 1600);
        return () => window.clearTimeout(timer);
    }, [flashIds]);

    const roomColumns = (session: ScheduleSession): string[] => {
        const runs = roomColumnRuns(sessionRoomIds(session), columnRoomIds);
        if (!runs.length) return [`2 / ${rooms.length + 2}`];
        return runs.map(([start, end]) => `${start + 2} / ${end + 2}`);
    };
    const sessionRow = (session: ScheduleSession): string => {
        const { start, end } = sessionSpan(session, schedule.timezone, schedule.day_start_hour);
        const first = Math.floor((start - axisStart) / SLOT_MINUTES) + 2;
        const span = Math.max(2, Math.ceil((end - start) / SLOT_MINUTES));
        return `${first} / span ${span}`;
    };

    return (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto bg-surface" data-testid="schedule-grid">
            <div
                className="relative grid min-w-max"
                style={{
                    gridTemplateColumns: `48px repeat(${Math.max(rooms.length, 1)}, minmax(144px, 1fr))`,
                    gridTemplateRows: `${headerHeight}px repeat(${rowCount}, ${SLOT_HEIGHT}px)`,
                    minWidth: `${48 + Math.max(rooms.length, 1) * 144}px`,
                }}
            >
                <div className="sticky left-0 top-0 z-30 border-b border-r border-line bg-surface" />
                <div aria-hidden="true" className="sticky left-0 z-20 border-r border-line bg-surface" style={{ gridColumn: 1, gridRow: `2 / ${rowCount + 2}` }} />
                {rooms.length ? rooms.map((room, index) => (
                    <RoomHeader key={room.id} room={room} column={index + 2} onClick={onRoomClick} />
                )) : (
                    <div className="sticky top-0 z-20 flex min-w-0 items-center justify-center border-b border-line bg-canvas px-2 text-xs font-semibold text-ink-soft" style={{ gridColumn: 2, gridRow: 1 }}>
                        <span className="truncate">Event-wide</span>
                    </div>
                )}

                {Array.from({ length: Math.ceil((axisEnd - axisStart) / 60) + 1 }, (_, index) => axisStart + index * 60).map((minute) => {
                    const row = Math.floor((minute - axisStart) / SLOT_MINUTES) + 2;
                    const hour = (schedule.day_start_hour + Math.floor(minute / 60)) % 24;
                    const label = `${String(hour).padStart(2, '0')}:00`;
                    return (
                        <div key={minute} className="contents">
                            <button
                                type="button"
                                onClick={() => onTimeClick(minute)}
                                className="sticky left-0 z-20 border-r border-t border-line bg-surface pr-2 pt-1 text-right text-xs font-medium text-ink-soft"
                                style={{ gridColumn: 1, gridRow: row }}
                            >
                                {label}
                            </button>
                            <div className="pointer-events-none z-0 border-t border-line" style={{ gridColumn: `2 / ${rooms.length + 2}`, gridRow: row }} />
                        </div>
                    );
                })}

                {showNow ? (
                    <div
                        className="pointer-events-none z-20 border-t-2 border-action"
                        style={{
                            gridColumn: `1 / ${rooms.length + 2}`,
                            gridRow: Math.floor((nowMinute - axisStart) / SLOT_MINUTES) + 2,
                        }}
                        aria-label={`Current time ${formatTime(now, schedule.timezone)}`}
                    />
                ) : null}

                {sessions.flatMap((session) => {
                    const room = schedule.rooms.find((item) => item.id === sessionRoomIds(session)[0]);
                    const level = schedule.levels.find((item) => item.id === session.level_id);
                    const contributors = session.contributors
                        ?.map((assignment) => contributorNames.get(assignment.contributor_id))
                        .filter((name): name is string => Boolean(name))
                        .join(', ') || session.instructors;
                    const color = sessionCellColors(
                        schedule.session_color_mode,
                        room,
                        schedule.activity_types.find((item) => item.id === session.activity_type_id),
                    );
                    const activeNow = showNow && isSessionActive(session, now);
                    const endProgramDay = programDayOf(session.end, schedule.timezone, schedule.day_start_hour);
                    const endsOnLaterDay = endProgramDay !== day;
                    const attendance = attendeeSummaries?.get(session.id);
                    const hasDescription = Boolean(session.description?.trim());
                    const hasConflict = conflictIds?.has(session.id) ?? false;
                    return roomColumns(session).map((gridColumn, runIndex) => (
                        <button
                            key={`${session.id}-${runIndex}`}
                            type="button"
                            onClick={() => onSessionClick(session)}
                            aria-current={activeNow ? 'time' : undefined}
                            className={`relative z-10 m-0.5 min-h-11 overflow-hidden rounded-field border px-2 py-2 text-left shadow-sm ${color.cell} ${color.stripe ? 'pl-3' : ''} ${hasDescription ? 'pb-6' : ''} ${hasConflict ? 'pr-6 outline outline-2 outline-amber-500' : ''} ${activeNow ? 'ring-2 ring-action ring-inset' : ''} ${session.is_cancelled ? 'opacity-60' : ''} ${flashIds.has(session.id) ? 'animate-session-flash' : ''}`}
                            style={{ gridColumn, gridRow: sessionRow(session) }}
                        >
                            {color.stripe ? <span aria-hidden="true" data-testid="session-type-stripe" className={`absolute inset-y-0 left-0 w-1 ${color.stripe}`} /> : null}
                            {hasConflict ? <AlertTriangle size={14} aria-hidden="true" data-testid="session-conflict-icon" className="absolute right-1.5 top-1.5 text-amber-700" /> : null}
                            {hasConflict ? <span className="sr-only">Room conflict</span> : null}
                            <span className={`block line-clamp-2 text-xs font-semibold leading-4 text-ink ${session.is_cancelled ? 'line-through' : ''}`}>{session.title}</span>
                            {contributors ? <span className="mt-0.5 block whitespace-normal text-xs leading-4 text-ink-soft">{contributors}</span> : null}
                            {level ? <span className="mt-1 block truncate text-xs font-medium text-action">{level.label}</span> : null}
                            {endsOnLaterDay ? <span className="mt-1 block truncate text-xs font-medium text-ink-soft" data-testid="session-ends-later-day">Ends {formatDayLabel(endProgramDay)}</span> : null}
                            {hasDescription ? <Info size={14} aria-hidden="true" className="absolute bottom-1.5 right-2 text-ink-soft" data-testid="session-details-icon" /> : null}
                            {hasDescription ? <span className="sr-only">Has details</span> : null}
                            {activeNow ? <span className="mt-1 inline-block bg-action px-1.5 py-0.5 text-xs font-bold text-white">Now</span> : null}
                            {attendance?.visible_count ? (
                                <span className="mt-1 block" aria-label={`${attendance.visible_count} people in their plan`}>
                                    <SessionAttendeeStack summary={attendance} max={3} size="sm" />
                                </span>
                            ) : null}
                            {plannedSessionIds?.has(session.id) ? <span className="sr-only">In My Plan</span> : null}
                        </button>
                    ));
                })}
            </div>
        </div>
    );
}

function RoomHeader({ room, column, onClick }: { room: ScheduleRoom; column: number; onClick?: (room: ScheduleRoom) => void }) {
    const color = scheduleColor(room.color);
    const className = `sticky top-0 z-20 flex min-w-0 flex-col items-center justify-center border-b border-line px-2 text-center text-xs font-semibold ${color.header}`;
    const content = (
        <>
            <span className="block max-w-full truncate">{room.name}</span>
            {room.details ? <span className="block max-w-full truncate font-normal opacity-80">{room.details}</span> : null}
        </>
    );
    if (!onClick) {
        return <div className={className} style={{ gridColumn: column, gridRow: 1 }}>{content}</div>;
    }
    return (
        <button type="button" onClick={() => onClick(room)} aria-label={`${room.name} room details`} className={className} style={{ gridColumn: column, gridRow: 1 }}>
            {content}
        </button>
    );
}
