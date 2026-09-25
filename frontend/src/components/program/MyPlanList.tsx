import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CalendarPlus, MoreVertical } from 'lucide-react';
import type { EventSchedule, MyPlanEntry, ScheduleSession } from '../../types';
import { findPlanConflicts, focusedPlanEntry, formatDayLabel, formatTimeRange, programDayOf } from '../../utils/schedule';
import RoomPill from './RoomPill';

interface Props {
    schedule: EventSchedule;
    entries: MyPlanEntry[];
    onOpen: (session: ScheduleSession) => void;
    onRemove: (sessionId: string) => void;
    onProgram: () => void;
}

export default function MyPlanList({ schedule, entries, onOpen, onRemove, onProgram }: Props) {
    const [now, setNow] = useState(() => new Date());
    const focusRef = useRef<HTMLElement | null>(null);
    const positionedSessionId = useRef<string | null>(null);
    const focus = focusedPlanEntry(entries, now);
    useEffect(() => {
        const timer = window.setInterval(() => setNow(new Date()), 60_000);
        return () => window.clearInterval(timer);
    }, []);
    useEffect(() => {
        if (!focus || positionedSessionId.current !== null || !focusRef.current) return;
        focusRef.current.scrollIntoView?.({ block: 'center' });
        positionedSessionId.current = focus.entry.session_id;
    }, [focus]);
    if (!entries.length) {
        return (
            <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
                <CalendarPlus size={32} className="text-action" />
                <h2 className="mt-4 text-lg font-bold text-ink">Your plan is empty</h2>
                <p className="mt-2 max-w-sm text-sm leading-6 text-ink-soft">Add workshops, shows and socials from the Program to build your weekend schedule.</p>
                <button type="button" onClick={onProgram} className="mt-5 rounded-field bg-action px-4 py-3 text-sm font-semibold text-white hover:opacity-90">Browse Program</button>
            </div>
        );
    }
    const conflicts = findPlanConflicts(entries);
    const grouped = new Map<string, MyPlanEntry[]>();
    for (const entry of [...entries].sort((left, right) => left.session.start.localeCompare(right.session.start))) {
        const day = programDayOf(entry.session.start, schedule.timezone, schedule.day_start_hour);
        grouped.set(day, [...(grouped.get(day) ?? []), entry]);
    }
    return (
        <div className="flex-1 overflow-y-auto bg-canvas px-4 py-5 pb-24">
            <div className="mx-auto max-w-2xl space-y-6">
                {[...grouped.entries()].map(([day, dayEntries]) => (
                    <section key={day}>
                        <h2 className="mb-3 text-base font-bold text-ink">{formatDayLabel(day, true)}</h2>
                        <div className="space-y-3">
                            {dayEntries.map((entry) => {
                                const room = schedule.rooms.find((item) => item.id === entry.session.room_id);
                                const venue = schedule.venues.find((item) => item.id === (entry.session.venue_id ?? room?.venue_id));
                                const overlap = conflicts.get(entry.session_id);
                                const focused = focus?.entry.session_id === entry.session_id;
                                return (
                                    <article ref={focused ? focusRef : undefined} key={entry.session_id} aria-current={focus?.status === 'now' && focused ? 'time' : undefined} className={`rounded-card border bg-surface p-4 shadow-sm ${focused ? 'border-action ring-2 ring-action/20' : 'border-card-line'} ${entry.status !== 'active' ? 'opacity-70' : ''}`}>
                                        {focused ? <p className="mb-2 text-xs font-bold uppercase text-action">{focus.status === 'now' ? 'Now' : 'Next'}</p> : null}
                                        <div className="flex gap-3">
                                            <p className="w-20 shrink-0 text-sm font-semibold text-ink">{formatTimeRange(entry.session, schedule.timezone)}</p>
                                            <button type="button" onClick={() => onOpen(entry.session)} className="min-w-0 flex-1 text-left">
                                                <RoomPill room={room} venue={venue} compact />
                                                {entry.session.instructors ? <p className="mt-2 font-bold text-ink">{entry.session.instructors}</p> : null}
                                                <p className="text-sm text-ink">{entry.session.title}</p>
                                            </button>
                                            <button type="button" aria-label={`Remove ${entry.session.title} from My Plan`} onClick={() => onRemove(entry.session_id)} className="flex h-11 w-11 shrink-0 items-center justify-center text-ink-soft"><MoreVertical size={20} /></button>
                                        </div>
                                        {overlap?.length ? <p className="mt-2 inline-flex max-w-full items-start gap-1 rounded-field bg-amber-50 px-2 py-1 text-[10px] font-medium leading-4 text-amber-900"><AlertTriangle size={12} className="mt-0.5 shrink-0" /><span><span className="font-semibold">Time conflict</span> with {overlap.join(', ')}</span></p> : null}
                                        {entry.status !== 'active' ? <p className="mt-3 text-xs font-medium text-danger">This session was {entry.status} by the organizer. Remove it when you are ready.</p> : null}
                                    </article>
                                );
                            })}
                        </div>
                    </section>
                ))}
            </div>
        </div>
    );
}
