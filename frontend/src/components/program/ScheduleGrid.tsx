import { useEffect, useMemo, useRef, useState } from 'react';
import type { EventSchedule, ScheduleRoom, ScheduleSession } from '../../types';
import { formatTime, isSessionActive, minuteOfProgramDay, programDayOf, sessionsForDay } from '../../utils/schedule';
import { roomColor } from './RoomPill';

interface Props {
    schedule: EventSchedule;
    day: string;
    plannedSessionIds?: Set<string>;
    onSessionClick: (session: ScheduleSession) => void;
    onTimeClick: (minute: number) => void;
}

const SLOT_MINUTES = 15;
const SLOT_HEIGHT = 22;

export default function ScheduleGrid({ schedule, day, plannedSessionIds, onSessionClick, onTimeClick }: Props) {
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const positionedDays = useRef(new Set<string>());
    const [now, setNow] = useState(() => new Date());
    useEffect(() => {
        const timer = window.setInterval(() => setNow(new Date()), 60_000);
        return () => window.clearInterval(timer);
    }, []);
    const sessions = useMemo(
        () => sessionsForDay(schedule.sessions, day, schedule.timezone, schedule.day_start_hour),
        [day, schedule],
    );
    const usedRoomIds = new Set(sessions.flatMap((session) => session.room_id == null ? [] : [session.room_id]));
    const rooms = schedule.rooms.filter((room) => usedRoomIds.has(room.id));
    const startMinutes = sessions.map((session) => minuteOfProgramDay(session.start, schedule.timezone, schedule.day_start_hour));
    const endMinutes = sessions.map((session) => {
        const start = minuteOfProgramDay(session.start, schedule.timezone, schedule.day_start_hour);
        let end = minuteOfProgramDay(session.end, schedule.timezone, schedule.day_start_hour);
        if (end <= start) end += 24 * 60;
        return end;
    });
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

    const roomColumn = (roomId: number | null): string => {
        if (roomId == null) return `2 / ${rooms.length + 2}`;
        const index = rooms.findIndex((room) => room.id === roomId);
        return `${index + 2}`;
    };
    const sessionRow = (session: ScheduleSession): string => {
        const start = minuteOfProgramDay(session.start, schedule.timezone, schedule.day_start_hour);
        let end = minuteOfProgramDay(session.end, schedule.timezone, schedule.day_start_hour);
        if (end <= start) end += 24 * 60;
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
                    gridTemplateRows: `48px repeat(${rowCount}, ${SLOT_HEIGHT}px)`,
                    minWidth: `${48 + Math.max(rooms.length, 1) * 144}px`,
                }}
            >
                <div className="sticky left-0 top-0 z-30 border-b border-r border-line bg-surface" />
                {rooms.length ? rooms.map((room, index) => (
                    <RoomHeader key={room.id} room={room} column={index + 2} />
                )) : (
                    <div className="sticky top-0 z-20 flex items-center justify-center border-b border-line bg-canvas px-2 text-xs font-semibold text-ink-soft" style={{ gridColumn: 2, gridRow: 1 }}>
                        Event-wide
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
                                className="sticky left-0 z-10 border-r border-t border-line bg-surface pr-2 pt-1 text-right text-[11px] font-medium text-ink-soft"
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

                {sessions.map((session) => {
                    const room = schedule.rooms.find((item) => item.id === session.room_id);
                    const level = schedule.levels.find((item) => item.id === session.level_id);
                    const color = roomColor(room?.color ?? 'slate');
                    const activeNow = showNow && isSessionActive(session, now);
                    return (
                        <button
                            key={session.id}
                            type="button"
                            onClick={() => onSessionClick(session)}
                            aria-current={activeNow ? 'time' : undefined}
                            className={`relative z-10 m-0.5 min-h-11 overflow-hidden rounded-field border p-2 text-left shadow-sm ${color.cell} ${activeNow ? 'ring-2 ring-action ring-inset' : ''} ${session.is_cancelled ? 'opacity-60' : ''}`}
                            style={{ gridColumn: roomColumn(session.room_id), gridRow: sessionRow(session) }}
                        >
                            <span className={`block line-clamp-2 text-xs font-semibold leading-4 text-ink ${session.is_cancelled ? 'line-through' : ''}`}>{session.title}</span>
                            {session.instructors ? <span className="mt-0.5 block truncate text-[11px] text-ink-soft">{session.instructors}</span> : null}
                            {level ? <span className="mt-1 block truncate text-[10px] font-medium text-action">{level.label}</span> : null}
                            {activeNow ? <span className="mt-1 inline-block bg-action px-1.5 py-0.5 text-[10px] font-bold text-white">Now</span> : null}
                            {plannedSessionIds?.has(session.id) ? <span className="sr-only">In My Plan</span> : null}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

function RoomHeader({ room, column }: { room: ScheduleRoom; column: number }) {
    const color = roomColor(room.color);
    return (
        <div className={`sticky top-0 z-20 flex items-center justify-center border-b border-line px-2 text-center text-xs font-semibold ${color.header}`} style={{ gridColumn: column, gridRow: 1 }}>
            {room.name}
        </div>
    );
}
