import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { BookmarkPlus, CalendarDays, ChevronLeft, ChevronRight, Clock, ExternalLink, Info, MapPin, Trash2 } from 'lucide-react';
import BottomSheet from '../BottomSheet';
import AudiencePicker from '../AudiencePicker';
import { useAuth } from '../../context/AuthContext';
import { useSignIn } from '../../context/SignInSheetContext';
import type { ShareAudience } from '../../api';
import { fetchOverviewItemAttendees, fetchSessionAttendees } from '../../api';
import type { EventSchedule, ScheduleOverviewItem, ScheduleRoom, ScheduleSession, SessionAttendanceSummary, SessionPlanAttendee } from '../../types';
import { formatDayLabel, formatTimeRange, programDayOf, sessionRooms } from '../../utils/schedule';
import { scheduleColor } from '../../utils/scheduleColors';
import RoomPill from './RoomPill';
import SessionAttendeeStack from './SessionAttendeeStack';

type AttendanceSummary = Pick<SessionAttendanceSummary, 'visible_count' | 'preview_attendees'>;

interface AttendeesTarget {
    kind: 'session' | 'overview_item';
    id: string;
    title: string;
}

interface SheetProps {
    schedule: EventSchedule;
    session: ScheduleSession;
    planned: boolean;
    preview?: boolean;
    onClose: () => void;
    onTogglePlan: (session: ScheduleSession) => Promise<void>;
    attendanceSummary?: AttendanceSummary | null;
    attendanceLoading?: boolean;
    eventId: string;
}

function usePlanToggle<T>(target: T, onTogglePlan: ((target: T) => Promise<void>) | undefined) {
    const { user } = useAuth();
    const openSignIn = useSignIn();
    const togglePlanRef = useRef(onTogglePlan);
    useEffect(() => {
        togglePlanRef.current = onTogglePlan;
    });
    const [busy, setBusy] = useState(false);
    const toggle = async () => {
        if (!onTogglePlan) return;
        if (!user) {
            openSignIn('my_plans', { onSignedIn: () => { togglePlanRef.current?.(target).catch(() => undefined); } });
            return;
        }
        setBusy(true);
        try {
            await onTogglePlan(target);
        } finally {
            setBusy(false);
        }
    };
    return { busy, toggle };
}

function PlanToggleButton({ planned, busy, onClick }: { planned: boolean; busy: boolean; onClick: () => void }) {
    return (
        <button
            type="button"
            disabled={busy}
            onClick={onClick}
            className={`flex min-h-12 w-full items-center justify-center gap-2 rounded-field px-4 text-sm font-semibold disabled:opacity-50 ${planned ? 'border border-danger/30 bg-danger/5 text-danger' : 'bg-action text-white hover:opacity-90'}`}
        >
            {planned ? <Trash2 size={18} /> : <BookmarkPlus size={18} />}
            {busy ? 'Updating…' : planned ? 'In My Plan · Remove' : 'Add to My Plan'}
        </button>
    );
}

function ActivityTypePill({ name, color }: { name: string; color: string }) {
    return <span className={`rounded-field px-2 py-1 text-xs font-medium ${scheduleColor(color).pill}`}>{name}</span>;
}

function PlanAttendanceSection({ summary, loading, planned, onOpen }: { summary?: AttendanceSummary | null; loading: boolean; planned: boolean; onOpen: () => void }) {
    const { user } = useAuth();
    const openSignIn = useSignIn();
    const attendeeCount = summary?.visible_count ?? 0;
    if (user && !loading && attendeeCount === 0) return null;
    return (
        <div className="border-t border-line pt-4">
            <h3 className="text-sm font-semibold text-ink">Who’s attending</h3>
            {!user ? (
                <p className="mt-2 text-sm text-ink-soft">
                    <button type="button" onClick={() => openSignIn('people')} className="font-medium text-action">Sign in</button> to see shared session plans.
                </p>
            ) : loading ? (
                <p className="mt-2 text-sm text-muted">Loading attendees…</p>
            ) : (
                <button
                    type="button"
                    onClick={onOpen}
                    className="mt-2 flex w-full items-center gap-2 rounded-field bg-canvas px-3 py-3 text-left hover:bg-line/60"
                    aria-label={`View ${attendeeCount} ${attendeeCount === 1 ? 'attendee' : 'attendees'}`}
                >
                    <SessionAttendeeStack summary={summary!} max={5} />
                    <span className="text-sm font-medium text-ink">{planned ? 'You are going' : 'Going'}</span>
                    <ChevronRight size={18} className="shrink-0 text-ink-soft ml-auto" aria-hidden="true" />
                </button>
            )}
        </div>
    );
}

export function SessionDetailsSheet({ schedule, session, planned, preview, onClose, onTogglePlan, attendanceSummary, attendanceLoading = false, eventId }: SheetProps) {
    const rooms = sessionRooms(schedule.rooms, session);
    const room = rooms[0];
    const venue = schedule.venues.find((item) => item.id === (session.venue_id ?? room?.venue_id));
    const roomDetails = [...new Set(rooms.map((item) => item.details?.trim()).filter((value): value is string => Boolean(value)))];
    const level = schedule.levels.find((item) => item.id === session.level_id);
    const activityType = schedule.activity_types.find((item) => item.id === session.activity_type_id);
    const { busy, toggle } = usePlanToggle(session, onTogglePlan);
    const [showAttendees, setShowAttendees] = useState(false);

    const footer = !preview && session.allow_plan && !session.is_cancelled ? (
        <PlanToggleButton planned={planned} busy={busy} onClick={toggle} />
    ) : undefined;

    if (showAttendees) {
        return (
            <PlanAttendeesSheet
                eventId={eventId}
                target={{ kind: 'session', id: session.id, title: session.title }}
                onBack={() => setShowAttendees(false)}
            />
        );
    }

    return (
        <BottomSheet title="Session details" onClose={onClose} footer={footer}>
            <div className="space-y-5 pb-2">
                <RoomPill rooms={rooms} venue={venue} />
                <div>
                    {session.instructors ? <p className="text-xl font-bold text-ink">{session.instructors}</p> : null}
                    <h2 className={`${session.instructors ? 'mt-1 text-base font-medium' : 'text-xl font-bold'} text-ink`}>{session.title}</h2>
                    <div className="mt-2 flex flex-wrap gap-2">
                        {level ? <span className="rounded-field bg-blue-50 px-2 py-1 text-xs font-medium text-action">{level.label}</span> : null}
                        {activityType ? <ActivityTypePill name={activityType.name} color={activityType.color} /> : null}
                    </div>
                    {session.description?.trim() ? <p className="mt-3 whitespace-pre-line text-sm leading-6 text-ink">{session.description.trim()}</p> : null}
                </div>
                <div className="space-y-3 border-t border-line pt-4 text-sm text-ink">
                    <p className="flex items-start gap-3"><CalendarDays size={18} className="mt-0.5 shrink-0 text-ink-soft" />{formatDayLabel(programDayOf(session.start, schedule.timezone, schedule.day_start_hour), true)}</p>
                    <p className="flex items-start gap-3"><Clock size={18} className="mt-0.5 shrink-0 text-ink-soft" />{formatTimeRange(session, schedule.timezone)}</p>
                    {venue || rooms.length ? (
                        <div className="flex items-start gap-3">
                            <MapPin size={18} className="mt-0.5 shrink-0 text-ink-soft" />
                            <div>
                                <p>{[rooms.map((item) => item.name).join(' + '), venue ? `${venue.name}${venue.address ? `, ${venue.address}` : ''}` : null].filter(Boolean).join(' · ')}</p>
                                {roomDetails.length ? <p className="mt-0.5 text-ink-soft">{roomDetails.join(' / ')}</p> : null}
                            </div>
                        </div>
                    ) : null}
                </div>
                {!preview ? <PlanAttendanceSection summary={attendanceSummary} loading={attendanceLoading} planned={planned} onOpen={() => setShowAttendees(true)} /> : null}
                {session.is_cancelled ? <p className="border border-line bg-canvas p-3 text-sm font-medium text-danger">This session was cancelled by the organizer.</p> : null}
                {session.attendee_note ? <p className="text-sm leading-6 text-ink-soft">{session.attendee_note}</p> : null}
            </div>
        </BottomSheet>
    );
}

export function RoomDetailsSheet({ schedule, room, onClose }: { schedule: EventSchedule; room: ScheduleRoom; onClose: () => void }) {
    const venue = schedule.venues.find((item) => item.id === room.venue_id);
    return (
        <BottomSheet title={room.name} onClose={onClose}>
            <div className="space-y-3 pb-2 text-sm text-ink">
                {room.details ? <p className="flex items-start gap-3"><Info size={18} className="mt-0.5 shrink-0 text-ink-soft" />{room.details}</p> : null}
                {venue ? <p className="flex items-start gap-3"><MapPin size={18} className="mt-0.5 shrink-0 text-ink-soft" />{venue.name}{venue.address ? `, ${venue.address}` : ''}</p> : null}
                {!room.details && !venue ? <p className="text-ink-soft">No extra details for this room.</p> : null}
            </div>
        </BottomSheet>
    );
}

interface OverviewItemSheetProps {
    schedule: EventSchedule;
    item: ScheduleOverviewItem;
    onClose: () => void;
    planned?: boolean;
    onTogglePlan?: (item: ScheduleOverviewItem) => Promise<void>;
    attendanceSummary?: AttendanceSummary | null;
    attendanceLoading?: boolean;
    eventId?: string;
}

export function OverviewItemSheet({ schedule, item, onClose, planned = false, onTogglePlan, attendanceSummary, attendanceLoading = false, eventId }: OverviewItemSheetProps) {
    const parent = item.parent_id ? schedule.overview_items?.find((row) => row.id === item.parent_id) : undefined;
    const roomIds = item.room_ids.length ? item.room_ids : parent?.room_ids ?? [];
    const rooms = schedule.rooms.filter((room) => roomIds.includes(room.id));
    const venueId = item.venue_id ?? parent?.venue_id ?? rooms[0]?.venue_id;
    const venue = schedule.venues.find((row) => row.id === venueId);
    const activityType = schedule.activity_types.find((row) => row.id === item.activity_type_id);
    const plannable = Boolean(onTogglePlan && eventId && item.allow_plan && !item.parent_id);
    const { busy, toggle } = usePlanToggle(item, onTogglePlan);
    const [showAttendees, setShowAttendees] = useState(false);
    if (showAttendees && eventId) {
        return (
            <PlanAttendeesSheet
                eventId={eventId}
                target={{ kind: 'overview_item', id: item.id, title: item.title }}
                onBack={() => setShowAttendees(false)}
            />
        );
    }
    return (
        <BottomSheet title={item.title} onClose={onClose} footer={plannable && !item.is_cancelled ? <PlanToggleButton planned={planned} busy={busy} onClick={toggle} /> : undefined}>
            <div className="space-y-4 pb-2">
                {item.subtitle ? <p className="text-base font-medium text-ink">{item.subtitle}</p> : null}
                {activityType || parent ? (
                    <div className="flex flex-wrap gap-2">
                        {activityType ? <ActivityTypePill name={activityType.name} color={activityType.color} /> : null}
                        {parent ? <span className="rounded-field bg-canvas px-2 py-1 text-xs font-medium text-ink-soft">Part of {parent.title}</span> : null}
                    </div>
                ) : null}
                {item.description?.trim() ? <p className="whitespace-pre-line text-sm leading-6 text-ink">{item.description.trim()}</p> : null}
                <div className="space-y-3 border-t border-line pt-4 text-sm text-ink">
                    <p className="flex items-start gap-3"><CalendarDays size={18} className="mt-0.5 shrink-0 text-ink-soft" />{formatDayLabel(programDayOf(item.start, schedule.timezone, schedule.day_start_hour), true)}</p>
                    <p className="flex items-start gap-3"><Clock size={18} className="mt-0.5 shrink-0 text-ink-soft" />{formatTimeRange(item, schedule.timezone)}</p>
                    {venue || rooms.length ? (
                        <p className="flex items-start gap-3"><MapPin size={18} className="mt-0.5 shrink-0 text-ink-soft" />{[rooms.map((room) => room.name).join(' + '), venue ? `${venue.name}${venue.address ? `, ${venue.address}` : ''}` : null].filter(Boolean).join(' · ')}</p>
                    ) : null}
                </div>
                {plannable ? <PlanAttendanceSection summary={attendanceSummary} loading={attendanceLoading} planned={planned} onOpen={() => setShowAttendees(true)} /> : null}
                {item.is_cancelled ? <p className="border border-line bg-canvas p-3 text-sm font-medium text-danger">This was cancelled by the organizer.</p> : null}
                {item.url ? (
                    <a href={item.url} target="_blank" rel="noopener noreferrer" className="flex min-h-12 w-full items-center justify-center gap-2 rounded-field border border-line bg-surface px-4 text-sm font-semibold text-ink hover:bg-canvas">
                        {item.url_label?.trim() || 'More info'}
                        <ExternalLink size={16} aria-hidden="true" />
                    </a>
                ) : null}
            </div>
        </BottomSheet>
    );
}

function PlanAttendeesSheet({ eventId, target, onBack }: { eventId: string; target: AttendeesTarget; onBack: () => void }) {
    const [attendees, setAttendees] = useState<SessionPlanAttendee[] | null>(null);
    const [error, setError] = useState(false);
    const fetchAttendees = target.kind === 'session' ? fetchSessionAttendees : fetchOverviewItemAttendees;
    const load = () => {
        setError(false);
        setAttendees(null);
        fetchAttendees(eventId, target.id)
            .then(setAttendees)
            .catch(() => setError(true));
    };

    useEffect(() => {
        let cancelled = false;
        (target.kind === 'session' ? fetchSessionAttendees : fetchOverviewItemAttendees)(eventId, target.id)
            .then((value) => { if (!cancelled) setAttendees(value); })
            .catch(() => { if (!cancelled) setError(true); });
        return () => { cancelled = true; };
    }, [eventId, target.id, target.kind]);

    return (
        <BottomSheet
            title="Who’s attending"
            onClose={onBack}
            showClose={false}
            headerLeading={(
                <button type="button" onClick={onBack} aria-label={target.kind === 'session' ? 'Back to session details' : 'Back to details'} className="flex h-11 w-11 items-center justify-center text-ink-soft">
                    <ChevronLeft size={22} aria-hidden="true" />
                </button>
            )}
        >
            <p className="mb-3 text-sm font-medium text-ink">{target.title}</p>
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
                    const rooms = sessionRooms(schedule.rooms, session);
                    const venue = schedule.venues.find((item) => item.id === (session.venue_id ?? rooms[0]?.venue_id));
                    const level = schedule.levels.find((item) => item.id === session.level_id);
                    return (
                        <button key={session.id} type="button" onClick={() => onSelect(session)} className="w-full rounded-card border border-card-line bg-surface p-3 text-left shadow-sm">
                            <RoomPill rooms={rooms} venue={venue} compact />
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
