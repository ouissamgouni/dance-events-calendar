import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CalendarPlus, X } from 'lucide-react';
import type { EventSchedule, MyPlanEntry } from '../../types';
import { findPlanConflicts, focusedPlanEntry, formatDayLabel, formatTimeRange, planEntryId, planEntryItem, programDayOf, sessionRooms } from '../../utils/schedule';
import { scheduleColor } from '../../utils/scheduleColors';
import RoomPill from './RoomPill';

interface Props {
    schedule: EventSchedule;
    entries: MyPlanEntry[];
    onOpen?: (entry: MyPlanEntry) => void;
    onRemove?: (entry: MyPlanEntry) => void;
    onProgram?: () => void;
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
        positionedSessionId.current = planEntryId(focus.entry);
    }, [focus]);
    if (!entries.length) {
        return (
            <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
                <CalendarPlus size={32} className="text-action" />
                <h2 className="mt-4 text-lg font-bold text-ink">Your plan is empty</h2>
                <p className="mt-2 max-w-sm text-sm leading-6 text-ink-soft">Add workshops, shows and socials from the Program to build your weekend schedule.</p>
                {onProgram ? <button type="button" onClick={onProgram} className="mt-5 rounded-field bg-action px-4 py-3 text-sm font-semibold text-white hover:opacity-90">Browse Program</button> : null}
            </div>
        );
    }
    const conflicts = findPlanConflicts(entries);
    const grouped = new Map<string, MyPlanEntry[]>();
    for (const entry of [...entries].sort((left, right) => planEntryItem(left).start.localeCompare(planEntryItem(right).start))) {
        const day = programDayOf(planEntryItem(entry).start, schedule.timezone, schedule.day_start_hour);
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
                                const entryId = planEntryId(entry);
                                const item = planEntryItem(entry);
                                const rooms = sessionRooms(schedule.rooms, item);
                                const venue = schedule.venues.find((row) => row.id === (item.venue_id ?? rooms[0]?.venue_id));
                                const activityType = schedule.activity_types.find((row) => row.id === item.activity_type_id);
                                const overlap = conflicts.get(entryId);
                                const focused = focus ? planEntryId(focus.entry) === entryId : false;
                                const byline = entry.kind === 'overview_item' ? entry.overview_item.subtitle : entry.session.instructors;
                                const sessionContent = (
                                    <>
                                        <RoomPill rooms={rooms} venue={venue} compact />
                                        {byline ? <p className="mt-2 font-bold text-ink">{byline}</p> : null}
                                        <p className="text-sm text-ink">{item.title}</p>
                                    </>
                                );
                                return (
                                    <article ref={focused ? focusRef : undefined} key={entryId} aria-current={focus?.status === 'now' && focused ? 'time' : undefined} className={`relative overflow-hidden rounded-card border bg-surface p-4 shadow-sm ${focused ? 'border-action ring-2 ring-action/20' : 'border-card-line'} ${entry.status !== 'active' ? 'opacity-70' : ''}`}>
                                        {activityType ? <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-1 ${scheduleColor(activityType.color).accent}`} /> : null}
                                        {focused ? <p className="mb-2 text-xs font-bold uppercase text-action">{focus?.status === 'now' ? 'Now' : 'Next'}</p> : null}
                                        <div className="flex gap-3">
                                            <p className="w-20 shrink-0 text-sm font-semibold text-ink">{formatTimeRange(item, schedule.timezone)}</p>
                                            {onOpen
                                                ? <button type="button" onClick={() => onOpen(entry)} className="min-w-0 flex-1 text-left">{sessionContent}</button>
                                                : <div className="min-w-0 flex-1 text-left">{sessionContent}</div>}
                                            {onRemove ? <button type="button" aria-label={`Remove ${item.title} from My Plan`} onClick={() => onRemove(entry)} className="flex h-11 w-11 shrink-0 items-center justify-center text-ink-soft hover:text-danger"><X size={20} /></button> : null}
                                        </div>
                                        {overlap?.length ? <p className="mt-2 inline-flex max-w-full items-start gap-1 rounded-field bg-amber-50 px-2 py-1 text-xs font-medium leading-4 text-amber-900"><AlertTriangle size={12} className="mt-0.5 shrink-0" /><span><span className="font-semibold">Time conflict</span> with {overlap.join(', ')}</span></p> : null}
                                        {entry.status !== 'active' ? <p className="mt-3 text-xs font-medium text-danger">This {entry.kind === 'overview_item' ? 'item' : 'session'} was {entry.status} by the organizer.{onRemove ? ' Remove it when you are ready.' : ''}</p> : null}
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
