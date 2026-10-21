import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, Download, Pencil } from 'lucide-react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { addOverviewItemToMyPlan, addToMyPlan, fetchAdminEventSchedule, fetchEvent, fetchEventSchedule, fetchEventScheduleEditorAccess, fetchMyPlan, fetchOverviewItemAttendanceSummary, fetchSessionAttendanceSummary, fetchSingleSessionAttendanceSummary, removeFromMyPlan, removeOverviewItemFromMyPlan, updateMyPlanAudience, type ShareAudience } from '../api';
import MyPlanUtilityMenu from '../components/MyPlanUtilityMenu';
import ScheduleGrid from '../components/program/ScheduleGrid';
import ProgramOverview from '../components/program/ProgramOverview';
import MyPlanList from '../components/program/MyPlanList';
import PlanAudienceSheet from '../components/program/PlanAudienceSheet';
import { AttendeeProgramFilters, ProgramDayPicker } from '../components/program/ProgramControls';
import { OverviewItemSheet, PlanAttendanceFeedbackSheet, RoomDetailsSheet, SessionDetailsSheet, TimeSlotSheet } from '../components/program/SessionSheets';
import { useAttendingEvents } from '../context/AttendingEventsContext';
import { useAuth } from '../context/AuthContext';
import { useSignIn } from '../context/SignInSheetContext';
import { useFeatureFlags, useFeatureFlagsReady } from '../context/FeatureFlagsContext';
import { useSetMyPlanCount } from '../context/MyPlanCountContext';
import { usePwaInstall } from '../context/PwaInstallContext';
import type { CalendarEvent, EventSchedule, MyPlanEntry, OverviewItemAttendanceSummary, PlanAudience, ScheduleOverviewItem, ScheduleRoom, ScheduleSession, SessionAttendanceSummary } from '../types';
import { defaultRsvpAudienceFor } from '../utils/audiencePreference';
import { programInstallDismissedKey, programPushOptInKey } from '../utils/installPromptStorage';
import { filterScheduleSessions, firstDayWithSessions, planEntryId, programDayOf, sessionsAtHour, sessionsForDay, type ScheduleFilters } from '../utils/schedule';
import { trackProgramViewed } from '../utils/tracking';

const EMPTY_FILTERS: ScheduleFilters = { instructor: '', levelIds: [], activityTypeIds: [] };

export default function EventProgramPage() {
    const { eventId } = useParams<{ eventId: string }>();
    const navigate = useNavigate();
    const location = useLocation();
    const [searchParams, setSearchParams] = useSearchParams();
    const { user, loading: authLoading } = useAuth();
    const openSignIn = useSignIn();
    const { isAttending, toggleAttending, setAudience } = useAttendingEvents();
    const { requestInstallInvitation } = usePwaInstall();
    const { eventScheduleEnabled, programGridAttendeePreviewEnabled } = useFeatureFlags();
    const flagsReady = useFeatureFlagsReady();
    const initialSearchParams = useRef(searchParams);
    const preview = searchParams.get('preview') === 'draft';
    const embeddedProgram = preview && searchParams.get('embed') === 'program';
    const unavailable = flagsReady && !eventScheduleEnabled && !preview;
    const activeTab = location.pathname.endsWith('/plan') ? 'plan' : 'program';
    const fromEventDetail = Boolean((location.state as { fromEventDetail?: boolean } | null)?.fromEventDetail);
    const inOverlay = Boolean((location.state as { backgroundLocation?: unknown } | null)?.backgroundLocation);
    const [leaving, setLeaving] = useState(false);
    const [event, setEvent] = useState<CalendarEvent | null>(null);
    const [schedule, setSchedule] = useState<EventSchedule | null>(null);
    const [plan, setPlan] = useState<MyPlanEntry[]>([]);
    const [planAudience, setPlanAudience] = useState<PlanAudience | null>(null);
    const [planAudienceLoaded, setPlanAudienceLoaded] = useState(false);
    const [planAudiencePrompt, setPlanAudiencePrompt] = useState(false);
    const [planAudienceBusy, setPlanAudienceBusy] = useState(false);
    const [planAudienceError, setPlanAudienceError] = useState<string | null>(null);
    const [pendingPostAdd, setPendingPostAdd] = useState<{ inviteAfterClose: boolean } | null>(null);
    const [selectedDay, setSelectedDay] = useState('');
    const [selectedSession, setSelectedSession] = useState<ScheduleSession | null>(null);
    const [selectedHour, setSelectedHour] = useState<number | null>(null);
    const [selectedRoom, setSelectedRoom] = useState<ScheduleRoom | null>(null);
    const [selectedOverviewItem, setSelectedOverviewItem] = useState<ScheduleOverviewItem | null>(null);
    const [filters, setFilters] = useState<ScheduleFilters>(EMPTY_FILTERS);
    const [positionRequest, setPositionRequest] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [canEdit, setCanEdit] = useState(false);
    const [attendanceFeedback, setAttendanceFeedback] = useState<{ audience: ShareAudience; inviteAfterClose: boolean } | null>(null);
    const [attendanceFeedbackBusy, setAttendanceFeedbackBusy] = useState(false);
    const [attendanceFeedbackError, setAttendanceFeedbackError] = useState<string | null>(null);
    const [attendanceSummaries, setAttendanceSummaries] = useState<Map<string, SessionAttendanceSummary>>(new Map());
    const [overviewAttendanceSummaries, setOverviewAttendanceSummaries] = useState<Map<string, OverviewItemAttendanceSummary>>(new Map());
    const [selectedAttendance, setSelectedAttendance] = useState<SessionAttendanceSummary | OverviewItemAttendanceSummary | null>(null);
    const [selectedAttendanceLoading, setSelectedAttendanceLoading] = useState(false);
    const trackedProgramEventId = useRef<string | null>(null);

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
                        : firstDayWithSessions(
                            scheduleValue.days,
                            [...scheduleValue.sessions, ...(scheduleValue.overview_items ?? []).filter((item) => !item.parent_id)],
                            scheduleValue.timezone,
                            scheduleValue.day_start_hour,
                        ) ?? scheduleValue.days[0] ?? '';
            setSelectedDay(nextDay);
            try {
                const storedFilters = sessionStorage.getItem(`program:${eventId}:filters`);
                if (storedFilters) setFilters(JSON.parse(storedFilters) as ScheduleFilters);
            } catch { setFilters(EMPTY_FILTERS); }
            const sessionId = initialSearchParams.current.get('session');
            if (sessionId) setSelectedSession(scheduleValue.sessions.find((item) => item.id === sessionId) ?? null);
            const itemId = initialSearchParams.current.get('item');
            const linkedItem = itemId ? scheduleValue.overview_items?.find((item) => item.id === itemId) : undefined;
            if (linkedItem) {
                setSelectedOverviewItem(linkedItem);
                if (!queryDay) setSelectedDay(programDayOf(linkedItem.start, scheduleValue.timezone, scheduleValue.day_start_hour));
            }
        }).catch((reason: unknown) => {
            if (!cancelled) setError(reason instanceof Error ? reason.message : 'Program unavailable');
        });
        return () => { cancelled = true; };
    }, [eventId, flagsReady, preview, unavailable]);

    useEffect(() => {
        if (!eventId || authLoading || !user || preview) return;
        fetchMyPlan(eventId).then((value) => {
            setPlan(value.entries);
            setPlanAudience(value.audience);
            setPlanAudienceLoaded(true);
        }).catch(() => {
            setPlan([]);
            setPlanAudienceLoaded(false);
        });
    }, [authLoading, eventId, preview, user]);

    const setMyPlanCount = useSetMyPlanCount();
    useEffect(() => {
        if (eventId && planAudienceLoaded) setMyPlanCount(eventId, plan.length);
    }, [eventId, plan.length, planAudienceLoaded, setMyPlanCount]);

    useEffect(() => {
        if (!eventId || authLoading || !user || preview) {
            setCanEdit(false);
            return;
        }
        let cancelled = false;
        fetchEventScheduleEditorAccess(eventId)
            .then((value) => { if (!cancelled) setCanEdit(value.can_edit); })
            .catch(() => { if (!cancelled) setCanEdit(false); });
        return () => { cancelled = true; };
    }, [authLoading, eventId, preview, user]);

    useEffect(() => {
        if (!eventId || authLoading || !user || preview || !programGridAttendeePreviewEnabled) {
            setAttendanceSummaries(new Map());
            setOverviewAttendanceSummaries(new Map());
            return;
        }
        let cancelled = false;
        fetchSessionAttendanceSummary(eventId)
            .then((value) => {
                if (cancelled) return;
                setAttendanceSummaries(new Map(value.sessions.map((item) => [item.session_id, item])));
                setOverviewAttendanceSummaries(new Map((value.overview_items ?? []).map((item) => [item.overview_item_id, item])));
            })
            .catch(() => {
                if (cancelled) return;
                setAttendanceSummaries(new Map());
                setOverviewAttendanceSummaries(new Map());
            });
        return () => { cancelled = true; };
    }, [authLoading, eventId, preview, programGridAttendeePreviewEnabled, user]);

    const selectedPlannableItem = selectedOverviewItem?.allow_plan && !selectedOverviewItem.parent_id ? selectedOverviewItem : null;
    useEffect(() => {
        const target = selectedSession
            ? { id: selectedSession.id, cached: attendanceSummaries.get(selectedSession.id), load: fetchSingleSessionAttendanceSummary }
            : selectedPlannableItem
                ? { id: selectedPlannableItem.id, cached: overviewAttendanceSummaries.get(selectedPlannableItem.id), load: fetchOverviewItemAttendanceSummary }
                : null;
        if (!eventId || authLoading || !user || preview || !target) {
            setSelectedAttendance(null);
            setSelectedAttendanceLoading(false);
            return;
        }
        if (target.cached) {
            setSelectedAttendance(target.cached);
            setSelectedAttendanceLoading(false);
            return;
        }
        let cancelled = false;
        setSelectedAttendance(null);
        setSelectedAttendanceLoading(true);
        target.load(eventId, target.id)
            .then((value) => { if (!cancelled) setSelectedAttendance(value); })
            .catch(() => { if (!cancelled) setSelectedAttendance(null); })
            .finally(() => { if (!cancelled) setSelectedAttendanceLoading(false); });
        return () => { cancelled = true; };
    }, [attendanceSummaries, authLoading, eventId, overviewAttendanceSummaries, preview, selectedPlannableItem, selectedSession, user]);

    useEffect(() => {
        if (activeTab !== 'program') {
            trackedProgramEventId.current = null;
            return;
        }
        if (preview || !eventId || schedule?.event_id !== eventId || trackedProgramEventId.current === eventId) return;
        trackedProgramEventId.current = eventId;
        trackProgramViewed();
    }, [activeTab, eventId, preview, schedule]);

    const plannedIds = useMemo(() => new Set(user ? plan.filter((entry) => entry.status !== 'removed').map(planEntryId) : []), [plan, user]);
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
    const hasOverview = Boolean(schedule?.overview_items?.some((item) => !item.parent_id));
    const hasSessions = Boolean(schedule?.sessions.length);
    const requestedView = searchParams.get('view');
    const programView: 'overview' | 'schedule' = hasOverview && (!hasSessions || requestedView !== 'schedule') ? 'overview' : 'schedule';
    const focusItemId = programView === 'schedule' ? searchParams.get('focus') : null;
    const focusItem = focusItemId ? schedule?.overview_items?.find((item) => item.id === focusItemId) : undefined;
    const focusWindow = useMemo(
        () => focusItem ? { start: focusItem.start, end: focusItem.end, token: `${focusItem.id}:${location.key}` } : null,
        [focusItem, location.key],
    );
    const dayContent = useMemo(
        () => programView === 'overview' ? (schedule?.overview_items ?? []).filter((item) => !item.parent_id) : filteredSessions,
        [filteredSessions, programView, schedule],
    );

    const selectDay = (day: string) => {
        setSelectedDay(day);
        setPositionRequest((value) => value + 1);
        if (eventId) sessionStorage.setItem(`program:${eventId}:day`, day);
        const next = new URLSearchParams(searchParams);
        next.set('day', day);
        setSearchParams(next, { replace: true });
    };
    const updateFilters = (next: ScheduleFilters) => {
        setFilters(next);
        if (schedule) {
            const matches = filterScheduleSessions(schedule.sessions, next);
            if (!sessionsForDay(matches, selectedDay, schedule.timezone, schedule.day_start_hour).length) {
                const firstMatchingDay = firstDayWithSessions(schedule.days, matches, schedule.timezone, schedule.day_start_hour);
                if (firstMatchingDay) selectDay(firstMatchingDay);
            }
        }
        setPositionRequest((value) => value + 1);
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
    const openOverviewDetails = (item: ScheduleOverviewItem) => {
        setSelectedOverviewItem(item);
        const next = new URLSearchParams(searchParams);
        next.set('item', item.id);
        setSearchParams(next, { replace: true });
    };
    const closeOverviewDetails = () => {
        setSelectedOverviewItem(null);
        const next = new URLSearchParams(searchParams);
        next.delete('item');
        setSearchParams(next, { replace: true });
    };
    const closeSheets = () => {
        setSelectedSession(null);
        setSelectedOverviewItem(null);
        const next = new URLSearchParams(searchParams);
        next.delete('session');
        next.delete('item');
        setSearchParams(next, { replace: true });
    };
    const switchProgramView = (view: 'overview' | 'schedule') => {
        const next = new URLSearchParams(searchParams);
        next.set('view', view);
        next.delete('focus');
        setSearchParams(next, { replace: true });
    };
    const openOverviewInSchedule = (item: ScheduleOverviewItem) => {
        if (!schedule) return;
        const day = programDayOf(item.start, schedule.timezone, schedule.day_start_hour);
        setSelectedDay(day);
        if (eventId) sessionStorage.setItem(`program:${eventId}:day`, day);
        const next = new URLSearchParams(searchParams);
        next.set('view', 'schedule');
        next.set('day', day);
        next.set('focus', item.id);
        // Pushed (not replaced) so Back returns to the Overview.
        navigate({ search: `?${next}` }, { state: location.state });
    };
    const requestProgramInstallInvitation = () => {
        if (!eventId || !user?.user_id || localStorage.getItem(programInstallDismissedKey(user.user_id, eventId))) return;
        localStorage.setItem(programPushOptInKey(user.user_id), eventId);
        requestInstallInvitation({ source: 'program', eventId, eventTitle: event?.title ?? 'this event' });
    };
    const closeAttendanceFeedback = () => {
        const inviteAfterClose = attendanceFeedback?.inviteAfterClose;
        setAttendanceFeedback(null);
        setAttendanceFeedbackError(null);
        if (inviteAfterClose) requestProgramInstallInvitation();
    };
    const changeAttendanceAudience = async (audience: ShareAudience) => {
        if (!eventId) return;
        setAttendanceFeedbackBusy(true);
        setAttendanceFeedbackError(null);
        const updated = await setAudience(eventId, audience);
        if (updated) setAttendanceFeedback((value) => value ? { ...value, audience } : value);
        else setAttendanceFeedbackError('Could not update visibility. Try again.');
        setAttendanceFeedbackBusy(false);
    };
    const undoAutomaticAttendance = async () => {
        if (!eventId) return;
        setAttendanceFeedbackBusy(true);
        setAttendanceFeedbackError(null);
        const updated = await toggleAttending(eventId);
        setAttendanceFeedbackBusy(false);
        if (updated) closeAttendanceFeedback();
        else setAttendanceFeedbackError('Could not undo Going. Try again.');
    };
    const continueAfterPlanAudience = async (inviteAfterClose: boolean) => {
        if (!eventId) return;
        if (user && !isAttending(eventId)) {
            const audience = defaultRsvpAudienceFor(user);
            const markedGoing = await toggleAttending(eventId, audience).catch(() => false);
            if (markedGoing) {
                closeSheets();
                setAttendanceFeedback({ audience, inviteAfterClose });
                return;
            }
        }
        if (inviteAfterClose) {
            requestProgramInstallInvitation();
            closeSheets();
        }
    };
    const persistPlanAudience = async (audience: PlanAudience) => {
        if (!eventId || planAudienceBusy) return;
        setPlanAudienceBusy(true);
        setPlanAudienceError(null);
        try {
            const response = await updateMyPlanAudience(eventId, audience);
            setPlanAudience(response.audience);
        } catch {
            setPlanAudienceError('Could not save this choice. Try again.');
            throw new Error('Could not update session sharing');
        } finally {
            setPlanAudienceBusy(false);
        }
    };
    const savePromptPlanAudience = async (audience: PlanAudience) => {
        try {
            await persistPlanAudience(audience);
            setPlanAudiencePrompt(false);
            const pending = pendingPostAdd;
            setPendingPostAdd(null);
            await continueAfterPlanAudience(pending?.inviteAfterClose ?? false);
        } catch {
            // Error is rendered in the sheet.
        }
    };
    const togglePlanEntry = async (
        id: string,
        optimistic: MyPlanEntry,
        add: () => Promise<MyPlanEntry>,
        remove: () => Promise<void>,
    ) => {
        if (!eventId) return;
        const existing = plan.find((entry) => planEntryId(entry) === id);
        const previous = plan;
        if (existing) {
            setPlan((rows) => rows.filter((entry) => planEntryId(entry) !== id));
            try {
                await remove();
            } catch (reason) {
                setPlan(previous);
                throw reason;
            }
        } else {
            setPlan((rows) => [...rows, optimistic]);
            try {
                const saved = await add();
                setPlan((rows) => rows.map((entry) => planEntryId(entry) === id ? saved : entry));
                const inviteAfterClose = Boolean(user?.user_id && !localStorage.getItem(programInstallDismissedKey(user.user_id, eventId)));
                if (planAudienceLoaded && planAudience === null) {
                    setPendingPostAdd({ inviteAfterClose });
                    setPlanAudiencePrompt(true);
                    closeSheets();
                    return;
                }
                await continueAfterPlanAudience(inviteAfterClose);
            } catch (reason) {
                setPlan(previous);
                throw reason;
            }
        }
    };
    const togglePlan = async (session: ScheduleSession) => {
        if (!eventId) return;
        await togglePlanEntry(
            session.id,
            { session_id: session.id, status: 'active', session },
            () => addToMyPlan(eventId, session.id),
            () => removeFromMyPlan(eventId, session.id),
        );
    };
    const toggleOverviewPlan = async (item: ScheduleOverviewItem) => {
        if (!eventId) return;
        await togglePlanEntry(
            item.id,
            { kind: 'overview_item', overview_item_id: item.id, status: 'active', overview_item: item },
            () => addOverviewItemToMyPlan(eventId, item.id),
            () => removeOverviewItemFromMyPlan(eventId, item.id),
        );
    };
    const toggleOverviewPlanRef = useRef(toggleOverviewPlan);
    useEffect(() => {
        toggleOverviewPlanRef.current = toggleOverviewPlan;
    });
    const toggleOverviewPlanFromCard = async (item: ScheduleOverviewItem) => {
        if (!user) {
            openSignIn('my_plans', { onSignedIn: () => { toggleOverviewPlanRef.current(item).catch(() => undefined); } });
            return;
        }
        await toggleOverviewPlan(item);
    };
    const removePlanEntry = async (entry: MyPlanEntry) => {
        if (!eventId) return;
        const id = planEntryId(entry);
        const previous = plan;
        setPlan((rows) => rows.filter((row) => planEntryId(row) !== id));
        try {
            if (entry.kind === 'overview_item') await removeOverviewItemFromMyPlan(eventId, id);
            else await removeFromMyPlan(eventId, id);
        } catch {
            setPlan(previous);
        }
    };
    const openPlanEntry = (entry: MyPlanEntry) => {
        if (entry.kind === 'overview_item') openOverviewDetails(entry.overview_item);
        else openSession(entry.session);
    };
    const backToEvent = () => {
        if (inOverlay && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) setLeaving(true);
        else if (fromEventDetail && window.history.length > 1) navigate(-1);
        else navigate(`/event/${eventId}`, { replace: true });
    };
    const navigateProgramTab = (path: string) => navigate(path, { replace: true, state: location.state });
    const shell = (content: React.ReactNode) => inOverlay ? (
        <div
            className={`fixed inset-0 z-[9000] flex flex-col bg-surface pt-[env(safe-area-inset-top)] shadow-2xl ${leaving ? 'animate-slide-out-right' : 'animate-slide-right'} motion-reduce:animate-none`}
            onAnimationEnd={(animationEvent) => {
                if (leaving && animationEvent.target === animationEvent.currentTarget) navigate(-1);
            }}
        >
            <div className="min-h-0 flex-1">{content}</div>
        </div>
    ) : content;

    if (unavailable) return shell(<ProgramState title="Program unavailable" detail="The event program is not available." onBack={backToEvent} />);
    if (error) return shell(<ProgramState title="Program unavailable" detail={error} onBack={backToEvent} />);
    if (!event || !schedule) return shell(<ProgramState title="Loading program…" onBack={backToEvent} />);

    return shell(
        <div className="flex h-full min-h-0 flex-col bg-canvas">
            {preview && !embeddedProgram ? <div className="shrink-0 bg-amber-50 px-4 py-2 text-center text-xs font-semibold text-amber-900">Draft preview · changes are not visible to attendees</div> : null}
            {!embeddedProgram ? <header className="shrink-0 bg-surface px-3 py-3">
                <div className="mx-auto flex max-w-5xl items-center gap-3">
                    <button type="button" onClick={backToEvent} aria-label="Back to event" className="flex h-11 w-11 shrink-0 items-center justify-center text-ink-soft"><ChevronLeft size={24} /></button>
                    <h1 className="min-w-0 truncate text-base font-bold text-ink">{event.title}</h1>
                    {canEdit ? <div className="ml-auto flex shrink-0 items-center gap-1">
                        <button type="button" onClick={() => navigate(`/event/${event.event_id}/program/export`)} aria-label="Export published program" className="flex min-h-10 items-center gap-2 rounded-field border border-line bg-surface px-3 py-2 text-sm font-semibold text-ink"><Download size={16} /><span className="hidden sm:inline">Export</span></button>
                        <button type="button" onClick={() => navigate(`/event/${event.event_id}/program/edit`)} aria-label="Edit program" className="flex min-h-10 items-center gap-2 rounded-field border border-line bg-surface px-3 py-2 text-sm font-semibold text-ink"><Pencil size={16} /><span className="hidden sm:inline">Edit program</span></button>
                    </div> : null}
                </div>
            </header> : null}

            <div className="shrink-0 border-b border-line bg-surface px-3">
                {!embeddedProgram ? <div className="mx-auto grid max-w-5xl grid-cols-2 gap-1 bg-canvas p-1">
                    <ProgramTab active={activeTab === 'program'} onClick={() => navigateProgramTab(`/event/${event.event_id}/program${searchParams.toString() ? `?${searchParams}` : ''}`)}>Program</ProgramTab>
                    <ProgramTab active={activeTab === 'plan'} onClick={() => navigateProgramTab(`/event/${event.event_id}/program/plan${searchParams.toString() ? `?${searchParams}` : ''}`)}>My Plan{plan.length ? ` (${plan.length})` : ''}</ProgramTab>
                </div> : null}
                {activeTab === 'program' && hasOverview && hasSessions ? (
                    <div className="mx-auto flex max-w-5xl gap-4 pt-2" role="tablist" aria-label="Program view">
                        <ViewTab active={programView === 'overview'} onClick={() => switchProgramView('overview')}>Overview</ViewTab>
                        <ViewTab active={programView === 'schedule'} onClick={() => switchProgramView('schedule')}>Full schedule</ViewTab>
                    </div>
                ) : null}
                {activeTab === 'program' && programView === 'schedule' ? <AttendeeProgramFilters schedule={schedule} filters={filters} onChange={updateFilters} /> : null}
                {activeTab === 'program' ? <ProgramDayPicker schedule={schedule} sessions={dayContent} selectedDay={selectedDay} filtersActive={programView === 'schedule' && Boolean(filters.instructor || filters.levelIds.length || filters.activityTypeIds.length)} softSelection onSelect={selectDay} /> : null}
            </div>

            <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col">
                {activeTab === 'program' && programView === 'overview' ? (
                    <ProgramOverview
                        schedule={schedule}
                        day={selectedDay}
                        onOpenSchedule={openOverviewInSchedule}
                        onOpenDetails={openOverviewDetails}
                        plan={preview ? undefined : { plannedIds, onToggle: toggleOverviewPlanFromCard, attendeeSummaries: overviewAttendanceSummaries }}
                    />
                ) : activeTab === 'program' ? (
                    <ScheduleGrid schedule={filteredSchedule ?? schedule} day={selectedDay} plannedSessionIds={plannedIds} onSessionClick={openSession} onTimeClick={setSelectedHour} positionRequest={positionRequest} compactHeader attendeeSummaries={attendanceSummaries} onRoomClick={setSelectedRoom} focusWindow={focusWindow} />
                ) : user ? (
                    <div className="flex min-h-0 flex-1 flex-col">
                        {plan.length ? <div className="shrink-0 border-b border-line bg-surface px-4 py-2 text-right">
                            <MyPlanUtilityMenu eventId={event.event_id} audience={planAudience} onAudienceChange={persistPlanAudience} />
                        </div> : null}
                        <MyPlanList schedule={schedule} entries={plan} onOpen={openPlanEntry} onRemove={removePlanEntry} onProgram={() => navigateProgramTab(`/event/${event.event_id}/program`)} />
                    </div>
                ) : (
                    <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
                        <h2 className="text-lg font-bold text-ink">Sign in to build My Plan</h2>
                        <p className="mt-2 max-w-sm text-sm text-ink-soft">Keep your saved sessions available across devices throughout the event.</p>
                        <button type="button" onClick={() => openSignIn('my_plans')} className="mt-5 rounded-field bg-action px-4 py-3 text-sm font-semibold text-white">Sign in</button>
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
            {selectedRoom ? <RoomDetailsSheet schedule={schedule} room={selectedRoom} onClose={() => setSelectedRoom(null)} /> : null}
            {selectedOverviewItem ? (
                <OverviewItemSheet
                    schedule={schedule}
                    item={selectedOverviewItem}
                    onClose={closeOverviewDetails}
                    planned={plannedIds.has(selectedOverviewItem.id)}
                    onTogglePlan={preview ? undefined : toggleOverviewPlan}
                    attendanceSummary={selectedPlannableItem ? selectedAttendance : null}
                    attendanceLoading={selectedAttendanceLoading}
                    eventId={event.event_id}
                />
            ) : null}
            {selectedSession ? (
                <SessionDetailsSheet schedule={schedule} session={selectedSession} planned={plannedIds.has(selectedSession.id)} preview={preview} onClose={closeSession} onTogglePlan={togglePlan} attendanceSummary={selectedAttendance} attendanceLoading={selectedAttendanceLoading} eventId={event.event_id} />
            ) : null}
            {attendanceFeedback ? (
                <PlanAttendanceFeedbackSheet
                    audience={attendanceFeedback.audience}
                    busy={attendanceFeedbackBusy}
                    error={attendanceFeedbackError}
                    onAudienceChange={changeAttendanceAudience}
                    onUndoGoing={undoAutomaticAttendance}
                    onClose={closeAttendanceFeedback}
                />
            ) : null}
            {planAudiencePrompt ? (
                <PlanAudienceSheet
                    busy={planAudienceBusy}
                    error={planAudienceError}
                    onConfirm={savePromptPlanAudience}
                    onNotNow={() => savePromptPlanAudience('private')}
                />
            ) : null}
        </div>
    );
}

function ProgramTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
    return <button type="button" onClick={onClick} className={`rounded-field px-3 py-2 text-sm font-semibold ${active ? 'bg-action/10 text-action' : 'text-ink-soft'}`}>{children}</button>;
}

function ViewTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
    return <button type="button" role="tab" aria-selected={active} onClick={onClick} className={`border-b-2 px-1 py-2 text-sm font-semibold ${active ? 'border-action text-action' : 'border-transparent text-ink-soft'}`}>{children}</button>;
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
