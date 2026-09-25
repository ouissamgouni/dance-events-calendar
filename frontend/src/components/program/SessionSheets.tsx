import { useRef, useState } from 'react';
import { BookmarkCheck, BookmarkPlus, CalendarDays, Clock, MapPin } from 'lucide-react';
import BottomSheet from '../BottomSheet';
import SignInNudge, { useSignInNudge } from '../SignInNudge';
import { useAuth } from '../../context/AuthContext';
import type { EventSchedule, ScheduleSession } from '../../types';
import { formatDayLabel, formatTimeRange, programDayOf } from '../../utils/schedule';
import RoomPill from './RoomPill';

interface SheetProps {
    schedule: EventSchedule;
    session: ScheduleSession;
    planned: boolean;
    preview?: boolean;
    onClose: () => void;
    onTogglePlan: (session: ScheduleSession) => Promise<void>;
}

export function SessionDetailsSheet({ schedule, session, planned, preview, onClose, onTogglePlan }: SheetProps) {
    const room = schedule.rooms.find((item) => item.id === session.room_id);
    const venue = schedule.venues.find((item) => item.id === (session.venue_id ?? room?.venue_id));
    const level = schedule.levels.find((item) => item.id === session.level_id);
    const activityType = schedule.activity_types.find((item) => item.id === session.activity_type_id);
    const { user } = useAuth();
    const nudge = useSignInNudge('save');
    const actionRef = useRef<HTMLButtonElement | null>(null);
    const [busy, setBusy] = useState(false);
    const [showNudge, setShowNudge] = useState(false);

    const toggle = async () => {
        if (!user) {
            if (nudge.shouldShow) {
                nudge.markShown();
                setShowNudge(true);
            }
            return;
        }
        setBusy(true);
        try {
            await onTogglePlan(session);
        } finally {
            setBusy(false);
        }
    };

    const footer = !preview && session.allow_plan && !session.is_cancelled ? (
        <>
            <button
                ref={actionRef}
                type="button"
                disabled={busy}
                onClick={toggle}
                className={`flex min-h-12 w-full items-center justify-center gap-2 rounded-field px-4 text-sm font-semibold disabled:opacity-50 ${planned ? 'border border-line bg-surface text-ink' : 'bg-action text-white hover:opacity-90'}`}
            >
                {planned ? <BookmarkCheck size={18} /> : <BookmarkPlus size={18} />}
                {busy ? 'Updating…' : planned ? 'In My Plan · Remove' : 'Add to My Plan'}
            </button>
            {showNudge ? <SignInNudge anchorRef={actionRef} trigger="save" onClose={() => { nudge.dismiss(); setShowNudge(false); }} /> : null}
        </>
    ) : undefined;

    return (
        <BottomSheet title="Session details" onClose={onClose} footer={footer}>
            <div className="space-y-5 pb-2">
                <RoomPill room={room} venue={venue} />
                <div>
                    {session.instructors ? <p className="text-xl font-bold text-ink">{session.instructors}</p> : null}
                    <h2 className={`${session.instructors ? 'mt-1 text-base font-medium' : 'text-xl font-bold'} text-ink`}>{session.title}</h2>
                    <div className="mt-2 flex flex-wrap gap-2">
                        {level ? <span className="rounded-field bg-blue-50 px-2 py-1 text-xs font-medium text-action">{level.label}</span> : null}
                        {activityType ? <span className="rounded-field bg-canvas px-2 py-1 text-xs font-medium text-ink-soft">{activityType.name}</span> : null}
                    </div>
                </div>
                <div className="space-y-3 border-t border-line pt-4 text-sm text-ink">
                    <p className="flex items-start gap-3"><CalendarDays size={18} className="mt-0.5 shrink-0 text-ink-soft" />{formatDayLabel(programDayOf(session.start, schedule.timezone, schedule.day_start_hour), true)}</p>
                    <p className="flex items-start gap-3"><Clock size={18} className="mt-0.5 shrink-0 text-ink-soft" />{formatTimeRange(session, schedule.timezone)}</p>
                    {venue ? <p className="flex items-start gap-3"><MapPin size={18} className="mt-0.5 shrink-0 text-ink-soft" />{room ? `${room.name} · ` : ''}{venue.name}{venue.address ? `, ${venue.address}` : ''}</p> : null}
                </div>
                {session.is_cancelled ? <p className="border border-line bg-canvas p-3 text-sm font-medium text-danger">This session was cancelled by the organizer.</p> : null}
                {session.attendee_note ? <p className="text-sm leading-6 text-ink-soft">{session.attendee_note}</p> : null}
            </div>
        </BottomSheet>
    );
}

interface TimeSlotProps {
    schedule: EventSchedule;
    sessions: ScheduleSession[];
    label: string;
    onClose: () => void;
    onSelect: (session: ScheduleSession) => void;
}

export function TimeSlotSheet({ schedule, sessions, label, onClose, onSelect }: TimeSlotProps) {
    return (
        <BottomSheet title={`${label} · ${sessions.length} ${sessions.length === 1 ? 'session' : 'sessions'}`} onClose={onClose}>
            <div className="space-y-3">
                {sessions.map((session) => {
                    const room = schedule.rooms.find((item) => item.id === session.room_id);
                    const venue = schedule.venues.find((item) => item.id === (session.venue_id ?? room?.venue_id));
                    const level = schedule.levels.find((item) => item.id === session.level_id);
                    return (
                        <button key={session.id} type="button" onClick={() => onSelect(session)} className="w-full rounded-card border border-card-line bg-surface p-3 text-left shadow-sm">
                            <RoomPill room={room} venue={venue} compact />
                            {session.instructors ? <p className="mt-2 text-sm font-bold text-ink">{session.instructors}</p> : null}
                            <p className="text-sm text-ink">{session.title}</p>
                            <div className="mt-1 flex gap-2 text-xs text-ink-soft">
                                <span>{formatTimeRange(session, schedule.timezone)}</span>
                                {level ? <span>· {level.label}</span> : null}
                            </div>
                        </button>
                    );
                })}
                {!sessions.length ? <p className="py-6 text-center text-sm text-ink-soft">Nothing is scheduled during this hour.</p> : null}
            </div>
        </BottomSheet>
    );
}
