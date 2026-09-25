import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { addToMyPlan, fetchAdminEventSchedule, fetchEvent, fetchEventSchedule, fetchMyPlan, removeFromMyPlan } from '../api';
import ScheduleGrid from '../components/program/ScheduleGrid';
import MyPlanList from '../components/program/MyPlanList';
import { ProgramDayPicker, ProgramFilters } from '../components/program/ProgramControls';
import { SessionDetailsSheet, TimeSlotSheet } from '../components/program/SessionSheets';
import { useAuth } from '../context/AuthContext';
import { useFeatureFlags, useFeatureFlagsReady } from '../context/FeatureFlagsContext';
import type { CalendarEvent, EventSchedule, MyPlanEntry, ScheduleSession } from '../types';
import { filterScheduleSessions, programDayOf, sessionsAtHour, sessionsForDay, type ScheduleFilters } from '../utils/schedule';

const EMPTY_FILTERS: ScheduleFilters = { instructor: '', levelIds: [], activityTypeIds: [] };

export default function EventProgramPage() {
    const { eventId } = useParams<{ eventId: string }>();
    const navigate = useNavigate();
    const location = useLocation();
    const [searchParams, setSearchParams] = useSearchParams();
    const { user, loading: authLoading } = useAuth();
    const { eventScheduleEnabled } = useFeatureFlags();
    const flagsReady = useFeatureFlagsReady();
    const initialSearchParams = useRef(searchParams);
    const preview = searchParams.get('preview') === 'draft';
    const unavailable = flagsReady && !eventScheduleEnabled && !preview;
    const activeTab = location.pathname.endsWith('/plan') ? 'plan' : 'program';
    const [event, setEvent] = useState<CalendarEvent | null>(null);
    const [schedule, setSchedule] = useState<EventSchedule | null>(null);
    const [plan, setPlan] = useState<MyPlanEntry[]>([]);
    const [selectedDay, setSelectedDay] = useState('');
    const [selectedSession, setSelectedSession] = useState<ScheduleSession | null>(null);
    const [selectedHour, setSelectedHour] = useState<number | null>(null);
    const [filters, setFilters] = useState<ScheduleFilters>(EMPTY_FILTERS);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!eventId || !flagsReady || unavailable) return;
        let cancelled = false;
        Promise.all([
            fetchEvent(eventId, { fresh: preview }),
            preview ? fetchAdminEventSchedule(eventId) : fetchEventSchedule(eventId),
        ]).then(([eventValue, scheduleValue]) => {
            if (cancelled) return;
            setEvent(eventValue);
            setSchedule(scheduleValue);
            const stored = sessionStorage.getItem(`program:${eventId}:day`);
            const today = programDayOf(new Date(), scheduleValue.timezone, scheduleValue.day_start_hour);
            const queryDay = initialSearchParams.current.get('day');
            const nextDay = queryDay && scheduleValue.days.includes(queryDay)
                ? queryDay
                : scheduleValue.days.includes(today)
                    ? today
                    : stored && scheduleValue.days.includes(stored)
                        ? stored
                        : scheduleValue.days[0] ?? '';
            setSelectedDay(nextDay);
            try {
                const storedFilters = sessionStorage.getItem(`program:${eventId}:filters`);
                if (storedFilters) setFilters(JSON.parse(storedFilters) as ScheduleFilters);
            } catch { setFilters(EMPTY_FILTERS); }
            const sessionId = initialSearchParams.current.get('session');
            if (sessionId) setSelectedSession(scheduleValue.sessions.find((item) => item.id === sessionId) ?? null);
        }).catch((reason: unknown) => {
            if (!cancelled) setError(reason instanceof Error ? reason.message : 'Program unavailable');
        });
        return () => { cancelled = true; };
    }, [eventId, flagsReady, preview, unavailable]);

    useEffect(() => {
        if (!eventId || authLoading || !user || preview) return;
        fetchMyPlan(eventId).then((value) => setPlan(value.entries)).catch(() => setPlan([]));
    }, [authLoading, eventId, preview, user]);

    const plannedIds = useMemo(() => new Set(user ? plan.filter((entry) => entry.status !== 'removed').map((entry) => entry.session_id) : []), [plan, user]);
    const filteredSessions = useMemo(
        () => schedule ? filterScheduleSessions(schedule.sessions, filters) : [],
        [filters, schedule],
    );
    const filteredSchedule = useMemo(
        () => schedule ? { ...schedule, sessions: filteredSessions } : null,
        [filteredSessions, schedule],
    );
    const daySessions = schedule && selectedDay
        ? sessionsForDay(filteredSessions, selectedDay, schedule.timezone, schedule.day_start_hour)
        : [];
    const hourSessions = schedule && selectedHour != null
        ? sessionsAtHour(daySessions, selectedHour, schedule.timezone, schedule.day_start_hour)
        : [];

    const selectDay = (day: string) => {
        setSelectedDay(day);
        if (eventId) sessionStorage.setItem(`program:${eventId}:day`, day);
        const next = new URLSearchParams(searchParams);
        next.set('day', day);
        setSearchParams(next, { replace: true });
    };
    const updateFilters = (next: ScheduleFilters) => {
        setFilters(next);
        if (eventId) sessionStorage.setItem(`program:${eventId}:filters`, JSON.stringify(next));
    };
    const openSession = (session: ScheduleSession) => {
        setSelectedHour(null);
        setSelectedSession(session);
        const next = new URLSearchParams(searchParams);
        next.set('session', session.id);
        setSearchParams(next, { replace: true });
    };
    const closeSession = () => {
        setSelectedSession(null);
        const next = new URLSearchParams(searchParams);
        next.delete('session');
        setSearchParams(next, { replace: true });
    };
    const togglePlan = async (session: ScheduleSession) => {
        if (!eventId) return;
        const existing = plan.find((entry) => entry.session_id === session.id);
        const previous = plan;
        if (existing) {
            setPlan((rows) => rows.filter((entry) => entry.session_id !== session.id));
            try {
                await removeFromMyPlan(eventId, session.id);
            } catch (reason) {
                setPlan(previous);
                throw reason;
            }
        } else {
            const optimistic: MyPlanEntry = { session_id: session.id, status: 'active', session };
            setPlan((rows) => [...rows, optimistic]);
            try {
                const saved = await addToMyPlan(eventId, session.id);
                setPlan((rows) => rows.map((entry) => entry.session_id === session.id ? saved : entry));
            } catch (reason) {
                setPlan(previous);
                throw reason;
            }
        }
    };
    const removePlanEntry = async (sessionId: string) => {
        if (!eventId) return;
        const previous = plan;
        setPlan((rows) => rows.filter((entry) => entry.session_id !== sessionId));
        try {
            await removeFromMyPlan(eventId, sessionId);
        } catch {
            setPlan(previous);
        }
    };

    if (unavailable) return <ProgramState title="Program unavailable" detail="The event program is not available." onBack={() => navigate(`/event/${eventId}`)} />;
    if (error) return <ProgramState title="Program unavailable" detail={error} onBack={() => navigate(`/event/${eventId}`)} />;
    if (!event || !schedule) return <ProgramState title="Loading program…" onBack={() => navigate(`/event/${eventId}`)} />;

    return (
        <div className="flex h-full min-h-0 flex-col bg-canvas">
            {preview ? <div className="shrink-0 bg-amber-50 px-4 py-2 text-center text-xs font-semibold text-amber-900">Draft preview · changes are not visible to attendees</div> : null}
            <header className="shrink-0 bg-surface px-3 py-3">
                <div className="mx-auto flex max-w-5xl items-center gap-3">
                    <button type="button" onClick={() => navigate(`/event/${event.event_id}`)} aria-label="Back to event" className="flex h-11 w-11 shrink-0 items-center justify-center text-ink-soft"><ChevronLeft size={24} /></button>
                    <div className="min-w-0">
                        <h1 className="truncate text-base font-bold text-ink">{event.title}</h1>
                        <p className="truncate text-xs text-ink-soft">{event.city ?? event.location ?? 'Event program'}</p>
                    </div>
                </div>
            </header>

            <div className="shrink-0 border-b border-line bg-surface px-3">
                <div className="mx-auto grid max-w-5xl grid-cols-2 gap-1 bg-canvas p-1">
                    <ProgramTab active={activeTab === 'program'} onClick={() => navigate(`/event/${event.event_id}/program${searchParams.toString() ? `?${searchParams}` : ''}`)}>Program</ProgramTab>
                    <ProgramTab active={activeTab === 'plan'} onClick={() => navigate(`/event/${event.event_id}/program/plan${searchParams.toString() ? `?${searchParams}` : ''}`)}>My Plan{plan.length ? ` (${plan.length})` : ''}</ProgramTab>
                </div>
                {activeTab === 'program' ? <ProgramFilters schedule={schedule} filters={filters} onChange={updateFilters} /> : null}
                {activeTab === 'program' ? <ProgramDayPicker schedule={schedule} sessions={filteredSessions} selectedDay={selectedDay} filtersActive={Boolean(filters.instructor || filters.levelIds.length || filters.activityTypeIds.length)} onSelect={selectDay} /> : null}
            </div>

            <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col">
                {activeTab === 'program' ? (
                    <ScheduleGrid schedule={filteredSchedule ?? schedule} day={selectedDay} plannedSessionIds={plannedIds} onSessionClick={openSession} onTimeClick={setSelectedHour} />
                ) : user ? (
                    <MyPlanList schedule={schedule} entries={plan} onOpen={openSession} onRemove={removePlanEntry} onProgram={() => navigate(`/event/${event.event_id}/program`)} />
                ) : (
                    <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
                        <h2 className="text-lg font-bold text-ink">Sign in to build My Plan</h2>
                        <p className="mt-2 max-w-sm text-sm text-ink-soft">Keep your saved sessions available across devices throughout the event.</p>
                        <button type="button" onClick={() => navigate(`/login?next=${encodeURIComponent(location.pathname + location.search)}`)} className="mt-5 rounded-field bg-action px-4 py-3 text-sm font-semibold text-white">Sign in</button>
                    </div>
                )}
            </div>

            {selectedHour != null ? (
                <TimeSlotSheet
                    schedule={schedule}
                    sessions={hourSessions}
                    label={`${String((schedule.day_start_hour + Math.floor(selectedHour / 60)) % 24).padStart(2, '0')}:00–${String((schedule.day_start_hour + Math.floor(selectedHour / 60) + 1) % 24).padStart(2, '0')}:00`}
                    onClose={() => setSelectedHour(null)}
                    onSelect={openSession}
                />
            ) : null}
            {selectedSession ? (
                <SessionDetailsSheet schedule={schedule} session={selectedSession} planned={plannedIds.has(selectedSession.id)} preview={preview} onClose={closeSession} onTogglePlan={togglePlan} />
            ) : null}
        </div>
    );
}

function ProgramTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
    return <button type="button" onClick={onClick} className={`rounded-field px-3 py-2 text-sm font-semibold ${active ? 'bg-action/10 text-action' : 'text-ink-soft'}`}>{children}</button>;
}

function ProgramState({ title, detail, onBack }: { title: string; detail?: string; onBack: () => void }) {
    return (
        <div className="flex h-full flex-col items-center justify-center gap-3 bg-canvas px-6 text-center">
            <p className="font-semibold text-ink">{title}</p>
            {detail ? <p className="text-sm text-ink-soft">{detail}</p> : null}
            <button type="button" onClick={onBack} className="text-sm font-semibold text-action">Back to event</button>
        </div>
    );
}
