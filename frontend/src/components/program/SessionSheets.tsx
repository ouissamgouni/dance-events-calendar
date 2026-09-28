import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { BookmarkPlus, CalendarDays, ChevronLeft, ChevronRight, Clock, MapPin, Trash2 } from 'lucide-react';
import BottomSheet from '../BottomSheet';
import AudiencePicker from '../AudiencePicker';
import SignInNudge, { useSignInNudge } from '../SignInNudge';
import { useAuth } from '../../context/AuthContext';
import type { ShareAudience } from '../../api';
import { fetchSessionAttendees } from '../../api';
import type { EventSchedule, ScheduleSession, SessionAttendanceSummary, SessionPlanAttendee } from '../../types';
import { formatDayLabel, formatTimeRange, programDayOf } from '../../utils/schedule';
import RoomPill from './RoomPill';
import SessionAttendeeStack from './SessionAttendeeStack';

interface SheetProps {
    schedule: EventSchedule;
    session: ScheduleSession;
    planned: boolean;
    preview?: boolean;
    onClose: () => void;
    onTogglePlan: (session: ScheduleSession) => Promise<void>;
    attendanceSummary?: SessionAttendanceSummary | null;
    attendanceLoading?: boolean;
    eventId: string;
}

export function SessionDetailsSheet({ schedule, session, planned, preview, onClose, onTogglePlan, attendanceSummary, attendanceLoading = false, eventId }: SheetProps) {
    const room = schedule.rooms.find((item) => item.id === session.room_id);
    const venue = schedule.venues.find((item) => item.id === (session.venue_id ?? room?.venue_id));
    const level = schedule.levels.find((item) => item.id === session.level_id);
    const activityType = schedule.activity_types.find((item) => item.id === session.activity_type_id);
    const { user } = useAuth();
    const nudge = useSignInNudge('save');
    const actionRef = useRef<HTMLButtonElement | null>(null);
    const [busy, setBusy] = useState(false);
    const [showNudge, setShowNudge] = useState(false);
    const [showAttendees, setShowAttendees] = useState(false);
    const attendeeCount = attendanceSummary?.visible_count ?? 0;
    const showAttendanceSection = !preview && (!user || attendanceLoading || attendeeCount > 0);

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
                className={`flex min-h-12 w-full items-center justify-center gap-2 rounded-field px-4 text-sm font-semibold disabled:opacity-50 ${planned ? 'border border-danger/30 bg-danger/5 text-danger' : 'bg-action text-white hover:opacity-90'}`}
            >
                {planned ? <Trash2 size={18} /> : <BookmarkPlus size={18} />}
                {busy ? 'Updating…' : planned ? 'In My Plan · Remove' : 'Add to My Plan'}
            </button>
            {showNudge ? <SignInNudge anchorRef={actionRef} trigger="save" onClose={() => { nudge.dismiss(); setShowNudge(false); }} /> : null}
        </>
    ) : undefined;

    if (showAttendees) {
        return (
            <SessionAttendeesSheet
                eventId={eventId}
                session={session}
                onBack={() => setShowAttendees(false)}
            />
        );
    }

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
                {showAttendanceSection ? (
                    <div className="border-t border-line pt-4">
                        <h3 className="text-sm font-semibold text-ink">Who’s attending</h3>
                        {!user ? (
                            <p className="mt-2 text-sm text-ink-soft">
                                <Link to="/login" state={{ redirectTo: `/event/${eventId}/program?session=${session.id}` }} className="font-medium text-action">Sign in</Link> to see shared session plans.
                            </p>
                        ) : attendanceLoading ? (
                            <p className="mt-2 text-sm text-muted">Loading attendees…</p>
                        ) : attendeeCount > 0 ? (
                            <button
                                type="button"
                                onClick={() => setShowAttendees(true)}
                                className="mt-2 flex w-full items-center gap-2 rounded-field bg-canvas px-3 py-3 text-left hover:bg-line/60"
                                aria-label={`View ${attendeeCount} ${attendeeCount === 1 ? 'attendee' : 'attendees'}`}
                            >
                                <SessionAttendeeStack summary={attendanceSummary!} max={5} />
                                <span className="text-sm font-medium text-ink">{planned ? 'You are going' : 'Going'}</span>
                                <ChevronRight size={18} className="shrink-0 text-ink-soft ml-auto" aria-hidden="true" />
                            </button>
                        ) : null}
                    </div>
                ) : null}
                {session.is_cancelled ? <p className="border border-line bg-canvas p-3 text-sm font-medium text-danger">This session was cancelled by the organizer.</p> : null}
                {session.attendee_note ? <p className="text-sm leading-6 text-ink-soft">{session.attendee_note}</p> : null}
            </div>
        </BottomSheet>
    );
}

function SessionAttendeesSheet({ eventId, session, onBack }: { eventId: string; session: ScheduleSession; onBack: () => void }) {
    const [attendees, setAttendees] = useState<SessionPlanAttendee[] | null>(null);
    const [error, setError] = useState(false);
    const load = () => {
        setError(false);
        setAttendees(null);
        fetchSessionAttendees(eventId, session.id)
            .then(setAttendees)
            .catch(() => setError(true));
    };

    useEffect(() => {
        let cancelled = false;
        fetchSessionAttendees(eventId, session.id)
            .then((value) => { if (!cancelled) setAttendees(value); })
            .catch(() => { if (!cancelled) setError(true); });
        return () => { cancelled = true; };
    }, [eventId, session.id]);

    return (
        <BottomSheet
            title="Who’s attending"
            onClose={onBack}
            showClose={false}
            headerLeading={(
                <button type="button" onClick={onBack} aria-label="Back to session details" className="flex h-11 w-11 items-center justify-center text-ink-soft">
                    <ChevronLeft size={22} aria-hidden="true" />
                </button>
            )}
        >
            <p className="mb-3 text-sm font-medium text-ink">{session.title}</p>
            {error ? (
                <div className="space-y-3">
                    <p className="text-sm text-danger">Could not load attendees.</p>
                    <button type="button" onClick={load} className="rounded-field border border-line bg-surface px-3 py-2 text-sm font-semibold text-ink">Try again</button>
                </div>
            ) : attendees === null ? (
                <p className="text-sm text-muted">Loading attendees…</p>
            ) : attendees.length === 0 ? (
                <p className="text-sm text-ink-soft">No shared plans for this session yet.</p>
            ) : (
                <ul className="divide-y divide-line">
                    {attendees.map((attendee) => {
                        const name = attendee.display_name ?? 'Attendee';
                        const content = (
                            <>
                                {attendee.avatar_url ? (
                                    // eslint-disable-next-line no-restricted-syntax -- avatar is intentionally circular
                                    <img src={attendee.avatar_url} alt="" className="h-10 w-10 rounded-full object-cover" />
                                ) : (
                                    // eslint-disable-next-line no-restricted-syntax -- avatar placeholder is intentionally circular
                                    <span className="flex h-10 w-10 items-center justify-center rounded-full bg-canvas text-sm font-semibold text-ink">{name[0]?.toUpperCase() ?? '?'}</span>
                                )}
                                <span className="font-medium text-ink">{name}</span>
                            </>
                        );
                        return (
                            <li key={attendee.user_id}>
                                {attendee.handle ? <Link to={`/u/${attendee.handle}`} className="flex items-center gap-3 py-3">{content}</Link> : <span className="flex items-center gap-3 py-3">{content}</span>}
                            </li>
                        );
                    })}
                </ul>
            )}
        </BottomSheet>
    );
}

interface PlanAttendanceFeedbackSheetProps {
    audience: ShareAudience;
    busy: boolean;
    error: string | null;
    onAudienceChange: (audience: ShareAudience) => void;
    onUndoGoing: () => void;
    onClose: () => void;
}

export function PlanAttendanceFeedbackSheet({
    audience,
    busy,
    error,
    onAudienceChange,
    onUndoGoing,
    onClose,
}: PlanAttendanceFeedbackSheetProps) {
    return (
        <BottomSheet
            title="Added to My Plan"
            onClose={() => { if (!busy) onClose(); }}
            footer={(
                <button type="button" onClick={onClose} disabled={busy} className="min-h-12 w-full rounded-field bg-action px-4 text-sm font-semibold text-white disabled:opacity-50">
                    Done
                </button>
            )}
        >
            <div className="space-y-4 pb-2">
                <div>
                    <p className="text-lg font-bold text-ink">You’re going</p>
                    <p className="mt-1 text-sm text-ink-soft">Adding a session to your plan also marked you as going to this event.</p>
                </div>
                <div>
                    <p className="mb-2 text-sm font-semibold text-ink">Who can see you in the attendee list?</p>
                    <AudiencePicker
                        value={audience}
                        onChange={onAudienceChange}
                        disabled={busy}
                        size="full"
                        ariaLabel="Attendance visibility"
                    />
                </div>
                {error ? <p role="alert" className="text-sm font-medium text-danger">{error}</p> : null}
                <button type="button" onClick={onUndoGoing} disabled={busy} className="text-sm font-semibold text-danger disabled:opacity-50">
                    {busy ? 'Updating…' : 'Undo Going'}
                </button>
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
