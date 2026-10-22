import { useEffect, useId, useState } from 'react';
import useBackToClose from '../hooks/useBackToClose';
import { AlertTriangle, Bell, Check, ChevronDown, ChevronLeft, ChevronUp, ExternalLink, Eye, EyeOff, Info, MoreHorizontal, Plus, Search, Send, Trash2, Users, X } from 'lucide-react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import {
    addScheduleEditor,
    createAdminEventSchedule,
    createScheduleActivityType,
    createScheduleContributor,
    createScheduleLevel,
    createScheduleOverviewItem,
    createScheduleRoom,
    createScheduleSession,
    createScheduleVenue,
    deleteEventSchedule,
    deleteScheduleActivityType,
    deleteScheduleContributor,
    deleteScheduleLevel,
    deleteScheduleOverviewItem,
    deleteScheduleRoom,
    deleteScheduleSession,
    deleteScheduleVenue,
    applyScheduleImport,
    duplicateScheduleSession,
    exportEventSchedule,
    fetchAdminEventSchedule,
    fetchAdminUsers,
    fetchEvent,
    fetchEventScheduleEditorAccess,
    fetchOptionalAdminEventSchedule,
    fetchSchedulePlanners,
    fetchScheduleEditors,
    publishEventSchedule,
    republishEventSchedule,
    unpublishEventSchedule,
    fetchScheduleImportSchema,
    previewScheduleImport,
    removeScheduleEditor,
    updateAdminEventSchedule,
    updateScheduleActivityType,
    updateScheduleContributor,
    updateScheduleLevel,
    updateScheduleOverviewItem,
    updateScheduleRoom,
    updateScheduleSession,
    updateScheduleVenue,
    type ScheduleOverviewItemInput,
    type ScheduleSessionInput,
    type SchedulePlanner,
    type SchedulePublishResponse,
    type AdminUserRow,
    type EventScheduleEditor,
    type ProgramNotifyCandidate,
    type ProgramNotifyReason,
    fetchProgramNotifyCandidates,
    fetchSchedulePublishPreview,
    notifyProgram,
    revertScheduleChange,
    type SchedulePublishPreview,
} from '../api';
import { Switch } from '../components/ToggleRow';
import ScheduleGrid, { DraftPill, type SessionMark } from '../components/program/ScheduleGrid';
import ProgramOverview from '../components/program/ProgramOverview';
import ProgramExportPanel from '../components/program/ProgramExportPanel';
import { ProgramDayPicker, ProgramFilters } from '../components/program/ProgramControls';
import { SCHEDULE_COLORS, SESSION_COLOR_MODES, scheduleColor } from '../utils/scheduleColors';
import type { AdminEventSchedule, CalendarEvent, ProgramExport, ScheduleActivityType, ScheduleChange, ScheduleContributor, ScheduleContributorRole, ScheduleImportDocument, ScheduleImportPreview, ScheduleLevel, ScheduleOverviewItem, ScheduleRoom, ScheduleSession, ScheduleVenue, SessionColorMode } from '../types';
import { draftStatuses, filterScheduleSessions, firstDayWithSessions, formatDayDateLabel, formatTime, formatTimeRange, issuesByItem, programDayOf, programUpdateMessage, sessionRoomIds, sessionRooms, sessionsForDay, sessionsInOverviewWindow, sessionsOverlap, toZonedInput, zonedInputToIso, type ScheduleFilters } from '../utils/schedule';

type Section = 'overview' | 'schedule' | 'sessions' | 'locations' | 'taxonomy' | 'export' | 'settings';
type ConfigEntity = ScheduleVenue | ScheduleRoom | ScheduleLevel | ScheduleActivityType | ScheduleContributor;
type ConfigKind = 'venue' | 'room' | 'level' | 'activity' | 'contributor';
type TaxonomyKind = Extract<ConfigKind, 'level' | 'activity' | 'contributor'>;
const FIELD_CLASS = 'w-full rounded-field border border-line bg-surface px-3 py-2 font-normal text-ink focus:border-action focus:outline-none';
const EMPTY_FILTERS: ScheduleFilters = { instructor: '', levelIds: [], activityTypeIds: [] };
const defaultScheduleDay = (value: AdminEventSchedule, eventStart?: string) => firstDayWithSessions(value.days, [...value.sessions, ...(value.overview_items ?? [])], value.timezone, value.day_start_hour)
    ?? value.days[0]
    ?? (eventStart ? programDayOf(eventStart, value.timezone, value.day_start_hour) : '');

function draftProgramExport(event: CalendarEvent, schedule: AdminEventSchedule): ProgramExport {
    return {
        event_id: event.event_id,
        event_title: event.title,
        program_url: `/event/${encodeURIComponent(event.event_id)}/program`,
        timezone: schedule.timezone,
        day_start_hour: schedule.day_start_hour,
        session_color_mode: schedule.session_color_mode,
        available_days: schedule.days,
        selected_days: schedule.days,
        venues: schedule.venues,
        rooms: schedule.rooms,
        levels: schedule.levels,
        activity_types: schedule.activity_types,
        contributors: schedule.contributors ?? [],
        version: schedule.version ?? 0,
        published_at: schedule.published_at ?? '',
        sessions: schedule.sessions.map((session) => {
            const day = programDayOf(session.start, schedule.timezone, schedule.day_start_hour);
            const venue = schedule.venues.find((item) => item.id === session.venue_id);
            const roomNames = sessionRooms(schedule.rooms, session).map((item) => item.name).join(' + ');
            return {
                ...session,
                contributors: session.contributors ?? [],
                program_day: day,
                local_date: day,
                local_start_time: formatTime(session.start, schedule.timezone),
                local_end_time: formatTime(session.end, schedule.timezone),
                venue: venue?.name ?? null,
                room: roomNames || null,
                address: venue?.address ?? null,
                level: schedule.levels.find((item) => item.id === session.level_id)?.label ?? null,
                activity_type: schedule.activity_types.find((item) => item.id === session.activity_type_id)?.name ?? null,
                status: session.is_cancelled ? 'cancelled' as const : 'active' as const,
            };
        }),
    };
}

export default function AdminEventSchedulePage() {
    const { eventId } = useParams<{ eventId: string }>();
    const navigate = useNavigate();
    const location = useLocation();
    const isAdminRoute = location.pathname.startsWith('/admin/');
    const [event, setEvent] = useState<CalendarEvent | null>(null);
    const [schedule, setSchedule] = useState<AdminEventSchedule | null>(null);
    const [section, setSection] = useState<Section>('schedule');
    const [selectedDay, setSelectedDay] = useState('');
    const [sessionsDay, setSessionsDay] = useState('');
    const [editingSession, setEditingSession] = useState<ScheduleSession | 'new' | null>(null);
    const [editingOverview, setEditingOverview] = useState<{ item: ScheduleOverviewItem | null; parent?: ScheduleOverviewItem } | null>(null);
    const [editingConfig, setEditingConfig] = useState<{ kind: ConfigKind; item?: ConfigEntity } | null>(null);
    const [showPublish, setShowPublish] = useState(false);
    const [showPreview, setShowPreview] = useState(false);
    const [loading, setLoading] = useState(true);
    const [accessDenied, setAccessDenied] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [filters, setFilters] = useState<ScheduleFilters>(EMPTY_FILTERS);
    const [positionRequest, setPositionRequest] = useState(0);
    const [visibilityAction, setVisibilityAction] = useState<'unpublish' | 'republish' | null>(null);
    const [notifyOpen, setNotifyOpen] = useState(false);
    const [issuesOnly, setIssuesOnly] = useState(false);

    const reload = async () => {
        if (!eventId) return;
        const next = await fetchAdminEventSchedule(eventId);
        setSchedule(next);
        setSelectedDay((current) => next.days.includes(current) ? current : defaultScheduleDay(next, event?.start));
    };

    const changeVisibility = async (action: 'unpublish' | 'republish') => {
        if (!eventId) return;
        if (action === 'unpublish') await unpublishEventSchedule(eventId);
        else await republishEventSchedule(eventId);
        await reload();
    };

    useEffect(() => {
        if (!eventId) return;
        const access = isAdminRoute
            ? Promise.resolve({ can_edit: true })
            : fetchEventScheduleEditorAccess(eventId);
        access.then((value) => {
            if (!value.can_edit) {
                setAccessDenied(true);
                return null;
            }
            return Promise.all([fetchEvent(eventId, { fresh: true }), fetchOptionalAdminEventSchedule(eventId)]);
        })
            .then((values) => {
                if (!values) return;
                const [eventValue, scheduleValue] = values;
                setEvent(eventValue);
                setSchedule(scheduleValue);
                if (scheduleValue) setSelectedDay(defaultScheduleDay(scheduleValue, eventValue.start));
                if (scheduleValue?.overview_items?.some((item) => !item.parent_id)) setSection('overview');
            })
            .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Schedule unavailable'))
            .finally(() => setLoading(false));
    }, [eventId, isAdminRoute]);

    const createSchedule = async () => {
        if (!eventId || !event) return;
        setError(null);
        try {
            const value = await createAdminEventSchedule(eventId, {
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
                day_start_hour: 6,
            });
            setSchedule(value);
            setSelectedDay(defaultScheduleDay(value, event.start));
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : 'Could not create schedule');
        }
    };

    if (loading) return <AdminState text="Loading schedule…" />;
    if (accessDenied) return <ProgramEditorAccessDenied onBack={() => navigate(`/event/${eventId}/program`)} />;
    if (!event) return <AdminState text={error ?? 'Event not found'} />;
    if (!schedule) {
        return (
            <div className="flex min-h-full items-center justify-center bg-canvas p-6">
                <div className="max-w-md rounded-card border border-card-line bg-surface p-6 text-center shadow-sm">
                    <h1 className="text-xl font-bold text-ink">Create {event.title}'s program</h1>
                    <p className="mt-2 text-sm leading-6 text-ink-soft">This creates a private draft with default activity types and Dance levels. Nothing is visible to attendees until you publish.</p>
                    {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
                    <button type="button" onClick={createSchedule} className="mt-5 rounded-field bg-action px-4 py-3 text-sm font-semibold text-white">Create schedule</button>
                </div>
            </div>
        );
    }

    const changeCount = schedule.diff.changes?.length ?? schedule.diff.added_session_ids.length + schedule.diff.removed_session_ids.length + Object.keys(schedule.diff.changed_sessions).length + (schedule.diff.configuration_changed ? 1 : 0);
    const filteredSessions = filterScheduleSessions(schedule.sessions, filters);
    const filteredSchedule = { ...schedule, sessions: filteredSessions };
    const drafts = draftStatuses(schedule);
    const itemIssues = issuesByItem(schedule.issues);
    const sessionMarks = new Map<string, SessionMark>();
    for (const session of schedule.sessions) {
        const draft = drafts.get(session.id);
        const issues = itemIssues.get(session.id)?.map((issue) => issue.message) ?? [];
        if (draft || issues.length) sessionMarks.set(session.id, { draft, issues });
    }
    const sessionsWithIssues = filteredSessions.filter((session) => itemIssues.has(session.id));
    const listSchedule = issuesOnly ? { ...filteredSchedule, sessions: sessionsWithIssues } : filteredSchedule;
    const showIssues = () => {
        setSection('sessions');
        setSessionsDay('');
        setIssuesOnly(true);
    };
    const headerMenu = [
        { label: 'Preview as attendee', icon: <Eye size={17} aria-hidden="true" />, onSelect: () => setShowPreview(true) },
        ...(schedule.version != null && !schedule.unpublished_at ? [{ label: 'Notify attendees', icon: <Bell size={17} aria-hidden="true" />, onSelect: () => setNotifyOpen(true) }] : []),
        ...(schedule.version != null ? [schedule.unpublished_at
            ? { label: 'Republish', icon: <Eye size={17} aria-hidden="true" />, onSelect: () => setVisibilityAction('republish') }
            : { label: 'Unpublish', icon: <EyeOff size={17} aria-hidden="true" />, onSelect: () => setVisibilityAction('unpublish') }] : []),
    ];
    const selectDay = (day: string) => {
        setSelectedDay(day);
        setPositionRequest((value) => value + 1);
    };
    const updateFilters = (next: ScheduleFilters) => {
        const matches = filterScheduleSessions(schedule.sessions, next);
        setFilters(next);
        if (!sessionsForDay(matches, selectedDay, schedule.timezone, schedule.day_start_hour).length) {
            const firstMatchingDay = firstDayWithSessions(schedule.days, matches, schedule.timezone, schedule.day_start_hour);
            if (firstMatchingDay) setSelectedDay(firstMatchingDay);
        }
        setPositionRequest((value) => value + 1);
    };
    return (
        <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col bg-canvas">
            <header className="shrink-0 border-b border-line bg-surface px-2 py-2 sm:px-4 sm:py-3">
                <div className="flex items-center gap-2 sm:gap-3">
                    <button type="button" onClick={() => navigate(isAdminRoute ? '/admin' : `/event/${event.event_id}/program`)} aria-label={isAdminRoute ? 'Back to admin' : 'Back to program'} className="flex h-11 w-11 shrink-0 items-center justify-center text-ink-soft"><ChevronLeft /></button>
                    <div className="min-w-0 flex-1">
                        <p className="text-xs font-semibold uppercase text-ink-soft">Event schedule</p>
                        <h1 className="truncate text-base font-bold text-ink sm:text-lg">{event.title}</h1>
                    </div>
                    <div className="hidden items-center gap-2 sm:flex">
                        <button type="button" onClick={() => setShowPreview(true)} className="flex items-center gap-2 rounded-field border border-line bg-surface px-3 py-2 text-sm font-semibold text-ink hover:bg-canvas"><Eye size={17} />Preview</button>
                        {schedule.version != null && !schedule.unpublished_at ? <button type="button" onClick={() => setNotifyOpen(true)} aria-label="Notify attendees" className="flex items-center gap-2 rounded-field border border-line bg-surface px-3 py-2 text-sm font-semibold text-ink hover:bg-canvas"><Bell size={17} />Notify</button> : null}
                        {schedule.version != null && (schedule.unpublished_at ? <button type="button" onClick={() => setVisibilityAction('republish')} className="rounded-field border border-line bg-surface px-3 py-2 text-sm font-semibold text-ink hover:bg-canvas">Republish</button> : <button type="button" onClick={() => setVisibilityAction('unpublish')} className="rounded-field border border-line bg-surface px-3 py-2 text-sm font-semibold text-ink hover:bg-canvas">Unpublish</button>)}
                    </div>
                    <button type="button" onClick={() => setShowPublish(true)} className="flex shrink-0 items-center gap-2 rounded-field bg-action px-3 py-2 text-sm font-semibold text-white hover:opacity-90"><Send size={17} />Publish{changeCount ? ` (${changeCount})` : ''}</button>
                    <div className="sm:hidden"><OverflowMenu label="Program actions" items={headerMenu} /></div>
                </div>
            </header>
            <ProgramStatusStrip schedule={schedule} changeCount={changeCount} onReview={() => setShowPublish(true)} onShowIssues={showIssues} />
            <div className="flex min-h-0 flex-1 flex-col md:flex-row">
                <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-line bg-surface p-2 md:w-48 md:flex-col md:border-b-0 md:border-r md:p-3">
                    {(['overview', 'schedule', 'sessions', 'locations', 'taxonomy', 'export', 'settings'] as Section[]).map((item) => (
                        <button key={item} type="button" onClick={() => setSection(item)} className={`shrink-0 rounded-field px-3 py-2 text-left text-sm font-semibold capitalize ${section === item ? 'bg-action/10 text-action' : 'text-ink-soft hover:bg-canvas'}`}>{item}</button>
                    ))}
                </nav>
                <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
                    {error ? <div className="border-b border-line bg-rose-50 px-4 py-2 text-sm text-danger">{error}</div> : null}
                    {section === 'overview' ? (
                        <>
                            <div className="shrink-0 border-b border-line bg-surface px-3">
                                <ProgramDayPicker schedule={schedule} sessions={(schedule.overview_items ?? []).filter((item) => !item.parent_id)} selectedDay={selectedDay} onSelect={setSelectedDay} endSlot={<button type="button" onClick={() => setEditingOverview({ item: null })} className="ml-auto flex shrink-0 items-center gap-2 rounded-field bg-action px-3 py-2 text-xs font-semibold text-white"><Plus size={15} />Add item</button>} />
                            </div>
                            <ProgramOverview schedule={schedule} day={selectedDay} admin={{ issues: schedule.issues, drafts, onEdit: (item) => setEditingOverview({ item }), onAddMoment: (parent) => setEditingOverview({ item: null, parent }) }} />
                        </>
                    ) : null}
                    {section === 'schedule' || section === 'sessions' ? (
                        <div className="shrink-0 border-b border-line bg-surface px-3">
                            <ProgramFilters schedule={schedule} filters={filters} onChange={updateFilters} />
                            <ProgramDayPicker schedule={schedule} sessions={filteredSessions} selectedDay={section === 'sessions' ? sessionsDay : selectedDay} includeAll={section === 'sessions'} filtersActive={Boolean(filters.instructor || filters.levelIds.length || filters.activityTypeIds.length)} onSelect={section === 'sessions' ? setSessionsDay : selectDay} endSlot={section === 'schedule' ? <button type="button" onClick={() => setEditingSession('new')} className="ml-auto flex shrink-0 items-center gap-2 rounded-field bg-action px-3 py-2 text-xs font-semibold text-white"><Plus size={15} />Add session</button> : sessionsWithIssues.length || issuesOnly ? <button type="button" aria-pressed={issuesOnly} onClick={() => setIssuesOnly(!issuesOnly)} className={`ml-auto flex shrink-0 items-center gap-1.5 rounded-field border px-3 py-2 text-xs font-semibold ${issuesOnly ? 'border-action bg-action text-white' : 'border-amber-200 bg-amber-50 text-amber-900 hover:bg-amber-100'}`}><AlertTriangle size={14} aria-hidden="true" />Issues · {sessionsWithIssues.length}</button> : undefined} />
                        </div>
                    ) : null}
                    {section === 'schedule' ? (
                        <>
                            <ScheduleGrid schedule={filteredSchedule} day={selectedDay} onSessionClick={setEditingSession} onTimeClick={() => setEditingSession('new')} positionRequest={positionRequest} marks={sessionMarks} />
                        </>
                    ) : null}
                    {section === 'sessions' ? <SessionsTable schedule={listSchedule} day={sessionsDay} marks={sessionMarks} onEdit={setEditingSession} /> : null}
                    {section === 'locations' ? <ConfigLists schedule={schedule} kinds={['venue', 'room']} onEdit={(kind, item) => setEditingConfig({ kind, item })} /> : null}
                    {section === 'taxonomy' ? <TaxonomyPanel schedule={schedule} onEdit={(kind, item) => setEditingConfig({ kind, item })} /> : null}
                    {section === 'export' ? <div className="min-h-0 flex-1 overflow-y-auto p-4"><div className="mx-auto max-w-4xl"><ProgramExportPanel program={draftProgramExport(event, schedule)} eyebrow="Draft program" showCalendarDownloads={false} /></div></div> : null}
                    {section === 'settings' ? <SettingsPanel schedule={schedule} eventId={event.event_id} eventTitle={event.title} canManageEditors={isAdminRoute} onSaved={setSchedule} onDeleted={() => { setSchedule(null); setSection('schedule'); }} /> : null}
                </main>
            </div>

            {editingSession ? <SessionEditor schedule={schedule} day={selectedDay} session={editingSession === 'new' ? null : editingSession} eventId={event.event_id} onClose={() => setEditingSession(null)} onSaved={async () => { setEditingSession(null); await reload(); }} onError={setError} /> : null}
            {editingOverview ? <OverviewItemEditor schedule={schedule} day={selectedDay} item={editingOverview.item} parent={editingOverview.parent} eventId={event.event_id} onClose={() => setEditingOverview(null)} onSaved={async () => { setEditingOverview(null); await reload(); }} onError={setError} /> : null}
            {editingConfig ? <ConfigEditor schedule={schedule} eventId={event.event_id} kind={editingConfig.kind} item={editingConfig.item} onClose={() => setEditingConfig(null)} onSaved={async () => { setEditingConfig(null); await reload(); }} onError={setError} /> : null}
            {section === 'locations' ? <button type="button" onClick={() => setEditingConfig({ kind: 'venue' })} className="fixed bottom-6 right-6 z-40 flex h-12 items-center gap-2 rounded-field bg-action px-4 text-sm font-semibold text-white shadow-lg"><Plus size={18} />Add</button> : null}
            {showPublish ? <PublishDialog schedule={schedule} eventId={event.event_id} eventTitle={event.title} onClose={() => setShowPublish(false)} onPublished={reload} onReverted={setSchedule} /> : null}
            {visibilityAction ? <VisibilityDialog action={visibilityAction} eventId={event.event_id} eventTitle={event.title} onClose={() => setVisibilityAction(null)} onChange={() => changeVisibility(visibilityAction)} /> : null}
            {notifyOpen ? <ProgramNotifyDialog eventId={event.event_id} eventTitle={event.title} onClose={() => setNotifyOpen(false)} /> : null}
            {showPreview ? <PreviewDialog eventId={event.event_id} onClose={() => setShowPreview(false)} /> : null}
        </div>
    );
}

function SessionsTable({ schedule, day, marks, onEdit }: { schedule: AdminEventSchedule; day: string; marks: Map<string, SessionMark>; onEdit: (session: ScheduleSession) => void }) {
    const sessions = (day ? sessionsForDay(schedule.sessions, day, schedule.timezone, schedule.day_start_hour) : [...schedule.sessions])
        .sort((left, right) => left.start.localeCompare(right.start));
    return (
        <div className="overflow-auto p-4">
            <div className="mx-auto max-w-5xl overflow-hidden rounded-card border border-card-line bg-surface">
                <table className="w-full min-w-[720px] text-left text-sm">
                    <thead className="bg-canvas text-xs uppercase text-ink-soft"><tr><th className="p-3">Date</th><th className="p-3">Time</th><th className="p-3">Room</th><th className="p-3">Title</th><th className="p-3">Artists & instructors</th><th className="p-3">Type</th></tr></thead>
                    <tbody>{sessions.map((session) => {
                        const mark = marks.get(session.id);
                        const issues = mark?.issues ?? [];
                        return <tr key={session.id} onClick={() => onEdit(session)} className={`cursor-pointer border-t border-card-line hover:bg-canvas ${issues.length ? 'bg-amber-50/60' : ''}`}>
                            <td className={`p-3 text-ink-soft ${issues.length ? 'border-l-4 border-l-amber-500' : ''}`}>{formatDayDateLabel(programDayOf(session.start, schedule.timezone, schedule.day_start_hour))}</td>
                            <td className="p-3 font-medium text-ink">{formatTimeRange(session, schedule.timezone)}</td>
                            <td className="p-3 text-ink-soft">{sessionRooms(schedule.rooms, session).map((room) => room.name).join(' + ') || 'Event-wide'}</td>
                            <td className="p-3">
                                <span className={`font-semibold text-ink ${session.is_cancelled ? 'line-through' : ''}`} title={mark?.draft?.status === 'edited' ? `Edited: ${mark.draft.fields.join(', ')}` : undefined}>{mark?.draft ? <DraftPill status={mark.draft.status} /> : null}{session.title}</span>
                                {mark?.draft?.status === 'edited' ? <span className="mt-0.5 block text-xs text-ink-soft">Changed: {mark.draft.fields.join(', ')}</span> : null}
                                {issues.map((message) => <span key={message} className="mt-1 flex items-start gap-1 text-xs font-medium text-amber-800"><AlertTriangle size={13} aria-hidden="true" className="mt-0.5 shrink-0" />{message}</span>)}
                            </td>
                            <td className="p-3 text-ink-soft">{session.contributors?.map((assignment) => schedule.contributors?.find((contributor) => contributor.id === assignment.contributor_id)?.display_name).filter(Boolean).join(', ') || session.instructors || '—'}</td>
                            <td className="p-3 text-ink-soft">{schedule.activity_types.find((type) => type.id === session.activity_type_id)?.name ?? '—'}</td>
                        </tr>;
                    })}{!sessions.length ? <tr><td colSpan={6} className="p-8 text-center text-sm text-ink-soft">No sessions match this date and filter.</td></tr> : null}</tbody>
                </table>
            </div>
        </div>
    );
}

function ProgramStatusStrip({ schedule, changeCount, onReview, onShowIssues }: { schedule: AdminEventSchedule; changeCount: number; onReview: () => void; onShowIssues: () => void }) {
    const firstPublish = schedule.version == null;
    const pending = !firstPublish && changeCount > 0;
    const state = firstPublish
        ? { tone: 'border-blue-100 bg-blue-50', dot: 'bg-action', text: 'Draft · not visible to attendees until you publish' }
        : schedule.unpublished_at
            ? { tone: 'border-amber-200 bg-amber-50', dot: 'bg-amber-500', text: 'Hidden · attendees see "Program under work"' }
            : pending
                ? { tone: 'border-blue-100 bg-blue-50', dot: 'bg-action', text: `Version ${schedule.version} · ${changeCount} unpublished ${changeCount === 1 ? 'change' : 'changes'}` }
                : { tone: 'border-line bg-surface', dot: 'bg-success', text: `Version ${schedule.version} · up to date` };
    return <div role="status" data-testid="program-status" className={`flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2 text-xs ${state.tone}`}>
        <span className="flex min-w-0 items-center gap-2 font-semibold text-ink">
            {/* eslint-disable-next-line no-restricted-syntax -- status dot is intentionally circular */}
            <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${state.dot}`} />{state.text}
        </span>
        {pending ? <button type="button" onClick={onReview} className="font-semibold text-action hover:underline">Review</button> : null}
        {schedule.issues.length ? <button type="button" onClick={onShowIssues} className="ml-auto flex items-center gap-1 font-semibold text-amber-900 hover:underline"><AlertTriangle size={14} aria-hidden="true" />{schedule.issues.length} {schedule.issues.length === 1 ? 'warning' : 'warnings'}</button> : null}
    </div>;
}

function ConfigLists({ schedule, kinds, onEdit }: { schedule: AdminEventSchedule; kinds: ConfigKind[]; onEdit: (kind: ConfigKind, item?: ConfigEntity) => void }) {
    const rows = (kind: ConfigKind): ConfigEntity[] => kind === 'venue' ? schedule.venues : kind === 'room' ? schedule.rooms : kind === 'level' ? schedule.levels : kind === 'activity' ? schedule.activity_types : schedule.contributors ?? [];
    return <div className="overflow-y-auto p-4"><div className="mx-auto max-w-3xl space-y-6">{kinds.map((kind) => (
        <section key={kind}>
            <div className="mb-3 flex items-center justify-between"><h2 className="text-lg font-bold capitalize text-ink">{kind === 'activity' ? 'Activity types' : `${kind}s`}</h2><button type="button" onClick={() => onEdit(kind)} className="flex items-center gap-1 text-sm font-semibold text-action"><Plus size={16} />Add</button></div>
            <div className="overflow-hidden rounded-card border border-card-line bg-surface">{rows(kind).map((item) => (
                <button key={item.id} type="button" onClick={() => onEdit(kind, item)} className="flex w-full items-center gap-3 border-b border-card-line px-4 py-3 text-left last:border-b-0 hover:bg-canvas">
                    {'color' in item ? <span className={`h-4 w-4 shrink-0 ${scheduleColor(item.color).header}`} /> : null}
                    <span className="flex-1 font-medium text-ink">{'display_name' in item ? item.display_name : 'name' in item ? item.name : item.label}</span>
                    {'notation' in item && item.notation ? <span className="text-sm text-ink-soft">{item.notation}</span> : null}
                </button>
            ))}{!rows(kind).length ? <p className="p-4 text-sm text-ink-soft">No items yet.</p> : null}</div>
        </section>
    ))}</div></div>;
}

const TAXONOMY_TABS: Array<{ kind: TaxonomyKind; label: string; singular: string }> = [
    { kind: 'contributor', label: 'Contributors', singular: 'contributor' },
    { kind: 'activity', label: 'Activity types', singular: 'activity type' },
    { kind: 'level', label: 'Levels', singular: 'level' },
];

function TaxonomyPanel({ schedule, onEdit }: { schedule: AdminEventSchedule; onEdit: (kind: ConfigKind, item?: ConfigEntity) => void }) {
    const [selectedKind, setSelectedKind] = useState<TaxonomyKind>('contributor');
    const selectedTab = TAXONOMY_TABS.find((tab) => tab.kind === selectedKind) ?? TAXONOMY_TABS[0];
    const rows: Record<TaxonomyKind, ConfigEntity[]> = {
        contributor: schedule.contributors ?? [],
        activity: schedule.activity_types,
        level: schedule.levels,
    };
    return <div className="overflow-y-auto p-4">
        <div className="mx-auto max-w-3xl">
            <div className="flex items-start justify-between gap-4">
                <div><h2 className="text-lg font-bold text-ink">Program taxonomy</h2><p className="mt-1 text-sm text-ink-soft">Manage the reusable options available when editing sessions.</p></div>
                <button type="button" onClick={() => onEdit(selectedKind)} className="flex shrink-0 items-center gap-2 rounded-field bg-action px-3 py-2 text-sm font-semibold text-white"><Plus size={16} />Add {selectedTab.singular}</button>
            </div>
            <div role="tablist" aria-label="Program taxonomy" className="mt-6 flex gap-1 overflow-x-auto border-b border-line">
                {TAXONOMY_TABS.map((tab) => <button key={tab.kind} type="button" role="tab" aria-label={`${tab.label}, ${rows[tab.kind].length} ${rows[tab.kind].length === 1 ? 'item' : 'items'}`} aria-selected={selectedKind === tab.kind} onClick={() => setSelectedKind(tab.kind)} className={`shrink-0 border-b-2 px-3 py-3 text-sm font-semibold ${selectedKind === tab.kind ? 'border-action text-action' : 'border-transparent text-ink-soft hover:text-ink'}`}>{tab.label}<span className="ml-2 text-xs font-medium text-muted">{rows[tab.kind].length}</span></button>)}
            </div>
            <div role="tabpanel" aria-label={selectedTab.label} className="mt-4 overflow-hidden rounded-card border border-card-line bg-surface">
                {rows[selectedKind].map((item) => <button key={item.id} type="button" onClick={() => onEdit(selectedKind, item)} className="flex w-full items-center gap-3 border-b border-card-line px-4 py-3 text-left last:border-b-0 hover:bg-canvas">
                    {'color' in item ? <span className={`h-4 w-4 shrink-0 ${scheduleColor(item.color).header}`} /> : null}
                    <span className="flex-1 font-medium text-ink">{'display_name' in item ? item.display_name : 'name' in item ? item.name : item.label}</span>
                    {'notation' in item && item.notation ? <span className="text-sm text-ink-soft">{item.notation}</span> : null}
                </button>)}
                {!rows[selectedKind].length ? <p className="p-4 text-sm text-ink-soft">No {selectedTab.label.toLocaleLowerCase()} yet.</p> : null}
            </div>
        </div>
    </div>;
}

function SettingsPanel({ schedule, eventId, eventTitle, canManageEditors, onSaved, onDeleted }: { schedule: AdminEventSchedule; eventId: string; eventTitle: string; canManageEditors: boolean; onSaved: (value: AdminEventSchedule) => void; onDeleted: () => void }) {
    const [timezone, setTimezone] = useState(schedule.timezone);
    const [pendingTimezone, setPendingTimezone] = useState<string | null>(null);
    const [saveState, setSaveState] = useState<{ status: 'idle' | 'saving' | 'saved' } | { status: 'error'; message: string }>({ status: 'idle' });
    const timezoneOptions = supportedTimezones(schedule.timezone);
    const persist = async (patch: { timezone?: string; day_start_hour?: number; session_color_mode?: SessionColorMode }) => {
        setSaveState({ status: 'saving' });
        try {
            onSaved(await updateAdminEventSchedule(eventId, patch));
            setSaveState({ status: 'saved' });
        } catch (reason) {
            setSaveState({ status: 'error', message: reason instanceof Error ? reason.message : 'Could not save settings' });
        }
    };
    return <div className="mx-auto w-full max-w-2xl space-y-8 overflow-y-auto p-6">
        <section className="space-y-5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <h2 className="text-lg font-bold text-ink">Schedule settings</h2>
                <p aria-live="polite" className={`text-xs font-medium ${saveState.status === 'error' ? 'text-danger' : saveState.status === 'saved' ? 'text-success' : 'text-ink-soft'}`}>{saveState.status === 'saving' ? 'Saving…' : saveState.status === 'saved' ? 'Saved to draft' : saveState.status === 'error' ? saveState.message : 'Changes save automatically'}</p>
            </div>
            <TimezoneCombobox value={timezone} options={timezoneOptions} onChange={setTimezone} onSelect={(value) => setPendingTimezone(value === schedule.timezone ? null : value)} />
            {pendingTimezone ? <div className="border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                <p>Switch to <strong>{pendingTimezone}</strong>? Sessions keep their exact moment, so their local times shift.</p>
                <div className="mt-3 flex flex-wrap gap-2">
                    <button type="button" onClick={() => { setTimezone(schedule.timezone); setPendingTimezone(null); }} className="rounded-field border border-line bg-surface px-3 py-2 text-sm font-semibold text-ink hover:bg-canvas">Keep {schedule.timezone}</button>
                    <button type="button" onClick={() => { const value = pendingTimezone; setPendingTimezone(null); void persist({ timezone: value }); }} className="rounded-field bg-action px-3 py-2 text-sm font-semibold text-white hover:opacity-90">Change timezone</button>
                </div>
            </div> : null}
            <label className="block text-sm font-semibold text-ink">Program day changes at<select value={schedule.day_start_hour} disabled={saveState.status === 'saving'} onChange={(event) => void persist({ day_start_hour: Number(event.target.value) })} className="mt-2 w-full rounded-field border border-line bg-surface px-3 py-2 font-normal disabled:opacity-50">{Array.from({ length: 12 }, (_, hour) => <option key={hour} value={hour}>{String(hour).padStart(2, '0')}:00</option>)}</select></label>
            <label className="block text-sm font-semibold text-ink">Color sessions in the grid<select value={schedule.session_color_mode ?? 'room'} disabled={saveState.status === 'saving'} onChange={(event) => void persist({ session_color_mode: event.target.value as SessionColorMode })} className="mt-2 w-full rounded-field border border-line bg-surface px-3 py-2 font-normal disabled:opacity-50">{SESSION_COLOR_MODES.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}</select><span className="mt-1 block text-xs font-normal text-ink-soft">Sessions without an activity type keep their room color.</span></label>
        </section>
        {canManageEditors ? <ProgramEditorsPanel eventId={eventId} /> : null}
        <PlannerRoster eventId={eventId} schedule={schedule} />
        <ScheduleImportPanel eventId={eventId} onApplied={async () => onSaved(await fetchAdminEventSchedule(eventId))} />
        {canManageEditors ? <DeleteProgramSection eventId={eventId} eventTitle={eventTitle} onDeleted={onDeleted} /> : null}
    </div>;
}

function DeleteProgramSection({ eventId, eventTitle, onDeleted }: { eventId: string; eventTitle: string; onDeleted: () => void }) {
    const [confirmation, setConfirmation] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const matches = confirmation.trim().toLocaleLowerCase() === eventTitle.trim().toLocaleLowerCase();
    const remove = async () => {
        setBusy(true); setError(null);
        try { await deleteEventSchedule(eventId, confirmation); onDeleted(); }
        catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not delete the program'); }
        finally { setBusy(false); }
    };
    return <section className="border-t border-line pt-6">
        <h2 className="text-lg font-bold text-danger">Delete program</h2>
        <p className="mt-1 text-sm text-ink-soft">Removes the draft, every published version and all attendee plans for this program. The event page stays. This cannot be undone; to take the program offline temporarily, use Unpublish.</p>
        <label className="mt-4 block text-sm font-semibold text-ink">Type <span className="font-bold">{eventTitle}</span> to confirm
            <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} className={`${FIELD_CLASS} mt-2`} autoComplete="off" />
        </label>
        {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
        <button type="button" disabled={!matches || busy} onClick={() => void remove()} className="mt-3 rounded-field bg-danger px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">{busy ? 'Deleting…' : 'Delete program'}</button>
    </section>;
}

function ProgramEditorsPanel({ eventId }: { eventId: string }) {
    const [editors, setEditors] = useState<EventScheduleEditor[]>([]);
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<AdminUserRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [busyUserId, setBusyUserId] = useState<string | null>(null);
    const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        fetchScheduleEditors(eventId)
            .then((value) => { if (!cancelled) setEditors(value); })
            .catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : 'Could not load program editors'); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [eventId]);

    useEffect(() => {
        const value = query.trim();
        if (!value) {
            setResults([]);
            return;
        }
        let cancelled = false;
        const timeout = window.setTimeout(() => {
            fetchAdminUsers({ q: value, limit: 20 })
                .then((response) => { if (!cancelled) setResults(response.items); })
                .catch(() => { if (!cancelled) setResults([]); });
        }, 250);
        return () => { cancelled = true; window.clearTimeout(timeout); };
    }, [query]);

    const availableUsers = results.filter((user) => !user.is_admin && !user.deleted_at && !editors.some((editor) => editor.user_id === user.user_id));
    const addEditor = async (user: AdminUserRow) => {
        setBusyUserId(user.user_id);
        setError(null);
        try {
            const editor = await addScheduleEditor(eventId, user.user_id);
            setEditors((current) => [...current, editor].sort((left, right) => left.email.localeCompare(right.email)));
            setQuery('');
            setResults([]);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : 'Could not add program editor');
        } finally {
            setBusyUserId(null);
        }
    };
    const removeEditor = async (editor: EventScheduleEditor) => {
        if (confirmRemove !== editor.user_id) {
            setConfirmRemove(editor.user_id);
            return;
        }
        setBusyUserId(editor.user_id);
        setError(null);
        try {
            await removeScheduleEditor(eventId, editor.user_id);
            setEditors((current) => current.filter((row) => row.user_id !== editor.user_id));
            setConfirmRemove(null);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : 'Could not remove program editor');
        } finally {
            setBusyUserId(null);
        }
    };

    return <section className="border-t border-line pt-6">
        <h2 className="text-lg font-bold text-ink">Program editors</h2>
        <p className="mt-1 text-sm text-ink-soft">Editors can change and publish this program. The event's verified organizer is always an editor. Only admins can manage access.</p>
        <label className="mt-4 block text-sm font-semibold text-ink">Add an editor
            <span className="relative mt-2 block">
                <Search size={17} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search email, name, or handle" className={`${FIELD_CLASS} pl-10`} />
            </span>
        </label>
        {query.trim() ? <div className="mt-2 divide-y divide-card-line border-y border-line">
            {availableUsers.map((user) => <button key={user.user_id} type="button" disabled={busyUserId === user.user_id} onClick={() => addEditor(user)} className="flex min-h-11 w-full items-center justify-between gap-3 px-2 py-2 text-left disabled:opacity-50"><span className="min-w-0"><span className="block truncate text-sm font-semibold text-ink">{user.display_name || user.handle || user.email}</span><span className="block truncate text-xs text-ink-soft">{user.email}</span></span><span className="text-sm font-semibold text-action">Add</span></button>)}
            {!availableUsers.length ? <p className="px-2 py-3 text-sm text-ink-soft">No available users found.</p> : null}
        </div> : null}
        {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
        {loading ? <p className="mt-4 text-sm text-ink-soft">Loading editors…</p> : null}
        {!loading ? <div className="mt-4 divide-y divide-card-line border-y border-line">
            {editors.map((editor) => <div key={editor.user_id} className="flex min-h-14 items-center gap-3 py-2"><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-ink">{editor.name || editor.handle || editor.email}</span><span className="block truncate text-xs text-ink-soft">{editor.email}</span></span>{editor.is_organizer ? <span className="shrink-0 px-3 py-2 text-xs font-semibold text-ink-soft">Organizer · automatic</span> : <button type="button" disabled={busyUserId === editor.user_id} onClick={() => removeEditor(editor)} className="shrink-0 rounded-field px-3 py-2 text-sm font-semibold text-danger disabled:opacity-50">{confirmRemove === editor.user_id ? 'Confirm remove' : 'Remove'}</button>}</div>)}
            {!editors.length ? <p className="py-3 text-sm text-ink-soft">No delegated editors.</p> : null}
        </div> : null}
    </section>;
}

function TimezoneCombobox({ value, options, onChange, onSelect }: { value: string; options: string[]; onChange: (value: string) => void; onSelect?: (value: string) => void }) {
    const inputId = useId();
    const listId = useId();
    const [open, setOpen] = useState(false);
    const [filtering, setFiltering] = useState(false);
    const [activeIndex, setActiveIndex] = useState(0);
    const query = value.trim().toLocaleLowerCase();
    const matches = filtering ? options.filter((option) => !query || option.toLocaleLowerCase().includes(query)) : options;
    const select = (option: string) => { onChange(option); onSelect?.(option); setFiltering(false); setOpen(false); };
    return <div>
        <label htmlFor={inputId} className="block text-sm font-semibold text-ink">Event timezone</label>
        <div className="relative mt-2" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
            <Search size={17} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input id={inputId} type="text" inputMode="search" role="combobox" autoComplete="off" aria-autocomplete="list" aria-expanded={open && matches.length > 0} aria-controls={listId} aria-activedescendant={open && matches[activeIndex] ? `${listId}-${activeIndex}` : undefined} value={value} onFocus={() => { setFiltering(false); setActiveIndex(0); setOpen(true); }} onChange={(event) => { onChange(event.target.value); setFiltering(true); setActiveIndex(0); setOpen(true); }} onKeyDown={(event) => {
                if (event.key === 'Escape') { setOpen(false); return; }
                if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); setActiveIndex((index) => Math.min(index + 1, matches.length - 1)); }
                if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex((index) => Math.max(index - 1, 0)); }
                if (event.key === 'Enter' && open && matches[activeIndex]) { event.preventDefault(); select(matches[activeIndex]); }
            }} required className="min-h-11 w-full rounded-field border border-line bg-surface py-2 pl-10 pr-10 font-normal text-ink outline-none focus:border-action" />
            {value ? <button type="button" onClick={() => { onChange(''); setFiltering(false); setActiveIndex(0); setOpen(true); }} aria-label="Clear event timezone" className="absolute right-0 top-0 flex h-11 w-11 items-center justify-center text-muted hover:text-ink"><X size={17} /></button> : null}
            {open && matches.length ? <div id={listId} role="listbox" aria-label="Timezone suggestions" className="absolute inset-x-0 top-[calc(100%+0.375rem)] z-[12000] max-h-64 overflow-y-auto rounded-card border border-card-line bg-surface p-1.5 shadow-xl">
                {matches.map((option, index) => <button key={option} id={`${listId}-${index}`} type="button" role="option" aria-selected={index === activeIndex} onMouseDown={(event) => event.preventDefault()} onClick={() => select(option)} className={`flex min-h-11 w-full items-center px-3 text-left text-sm font-medium ${index === activeIndex ? 'bg-action/10 text-action' : 'text-ink hover:bg-canvas'}`}>{option}</button>)}
            </div> : null}
        </div>
    </div>;
}

function PlannerRoster({ eventId, schedule }: { eventId: string; schedule: AdminEventSchedule }) {
    const [open, setOpen] = useState(false);
    const [planners, setPlanners] = useState<SchedulePlanner[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        let cancelled = false;
        fetchSchedulePlanners(eventId)
            .then((value) => { if (!cancelled) setPlanners(value); })
            .catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : 'Could not load planners'); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [eventId]);
    return <section className="flex items-center gap-4 border-t border-line pt-6">
        <Users size={20} className="shrink-0 text-ink-soft" />
        <div className="min-w-0 flex-1"><h2 className="text-base font-bold text-ink">People with plans{loading || error ? '' : ` · ${planners.length}`}</h2><p className="mt-1 text-sm text-ink-soft">Review attendees who added sessions from this program.</p></div>
        <button type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" className="shrink-0 rounded-field border border-line bg-surface px-3 py-2 text-sm font-semibold text-ink hover:border-action hover:text-action">View people</button>
        {open ? <PlannerRosterDialog planners={planners} loading={loading} error={error} schedule={schedule} onClose={() => setOpen(false)} /> : null}
    </section>;
}

function PlannerRosterDialog({ planners, loading, error, schedule, onClose }: { planners: SchedulePlanner[]; loading: boolean; error: string | null; schedule: AdminEventSchedule; onClose: () => void }) {
    return <Modal title="People with plans" onClose={onClose} sheetOnMobile><div>
        <p className="text-sm text-ink-soft">People who added at least one session from this program.</p>
        {loading ? <p className="py-8 text-center text-sm text-ink-soft">Loading planners…</p> : null}
        {error ? <p className="mt-4 text-sm text-danger">{error}</p> : null}
        {!loading && !error && !planners.length ? <p className="py-8 text-center text-sm text-ink-soft">No one has added sessions yet.</p> : null}
        {planners.length ? <div className="mt-4 divide-y divide-card-line border-y border-line">{planners.map((planner) => (
            <details key={planner.user_id} className="group py-3">
                <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3">
                    <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-ink">{planner.name || planner.handle || planner.email}</span><span className="block truncate text-xs text-ink-soft">{planner.email}</span></span>
                    {planner.going ? <span className="rounded-field bg-emerald-50 px-2 py-1 text-xs font-semibold text-success">Going</span> : null}
                    <span className="text-xs font-semibold text-ink-soft">{planner.planned_session_count} {planner.planned_session_count === 1 ? 'session' : 'sessions'}</span>
                </summary>
                <ul className="mt-3 space-y-2 pl-4">{planner.sessions.map((session) => <li key={session.session_id ?? session.overview_item_id} className="text-sm text-ink"><span className={session.status !== 'active' ? 'line-through text-ink-soft' : ''}>{session.title}</span><span className="ml-2 text-xs text-ink-soft">{formatDayDateLabel(programDayOf(session.start, schedule.timezone, schedule.day_start_hour))} · {formatTimeRange(session, schedule.timezone)}</span></li>)}</ul>
            </details>
        ))}</div> : null}
    </div></Modal>;
}

function downloadJson(filename: string, value: object) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
}

function ScheduleImportPanel({ eventId, onApplied }: { eventId: string; onApplied: () => Promise<void> }) {
    const [text, setText] = useState('');
    const [mode, setMode] = useState<'merge' | 'replace'>('merge');
    const [preview, setPreview] = useState<ScheduleImportPreview | null>(null);
    const [document, setDocument] = useState<ScheduleImportDocument | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [loadingDocument, setLoadingDocument] = useState(true);
    const [loadingExample, setLoadingExample] = useState(false);
    const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
    const toggleChange = (change: ScheduleChange) => setExcluded((current) => {
        const next = new Set(current);
        const key = changeKey(change);
        if (next.has(key)) next.delete(key); else next.add(key);
        return next;
    });
    useEffect(() => {
        let cancelled = false;
        setLoadingDocument(true);
        exportEventSchedule(eventId)
            .then((value) => {
                if (!cancelled) setText(JSON.stringify(value, null, 2));
            })
            .catch((reason: unknown) => {
                if (!cancelled) setError(reason instanceof Error ? reason.message : 'Could not load the current draft JSON');
            })
            .finally(() => {
                if (!cancelled) setLoadingDocument(false);
            });
        return () => { cancelled = true; };
    }, [eventId]);
    const parse = (): ScheduleImportDocument => JSON.parse(text) as ScheduleImportDocument;
    const runPreview = async () => {
        setBusy(true); setError(null); setPreview(null); setExcluded(new Set());
        try {
            const parsed = parse();
            const value = await previewScheduleImport(eventId, mode, parsed);
            setDocument(parsed); setPreview(value);
        } catch (reason) { setError(reason instanceof Error ? reason.message : 'Invalid schedule JSON'); }
        finally { setBusy(false); }
    };
    const apply = async () => {
        if (!document || !preview) return;
        setBusy(true); setError(null);
        try { await applyScheduleImport(eventId, mode, document, (preview.changes ?? []).filter((change) => excluded.has(changeKey(change)))); await onApplied(); setPreview(null); setExcluded(new Set()); }
        catch (reason) { setError(reason instanceof Error ? reason.message : 'Import failed'); }
        finally { setBusy(false); }
    };
    return <section className="border-t border-line pt-6">
        <h2 className="text-lg font-bold text-ink">Import or export JSON</h2>
        <p className="mt-1 text-sm text-ink-soft">Edit the current private draft as JSON, preview the changes, then apply them. Publishing remains a separate step.</p>
        <p className="mt-2 text-xs leading-5 text-ink-soft"><strong className="text-ink">External IDs</strong> are stable import keys, not database IDs. Keep them unchanged across reimports so venues, rooms, taxonomy, and sessions update instead of duplicating; sessions use them to reference configuration rows.</p>
        <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" onClick={async () => downloadJson(`${eventId}-schedule.json`, await exportEventSchedule(eventId))} className="rounded-field border border-line bg-surface px-3 py-2 text-sm font-semibold text-ink">Download schedule</button>
            <button type="button" onClick={async () => { const value = await fetchScheduleImportSchema(eventId); downloadJson('movida-schedule-schema.json', value.schema); }} className="rounded-field border border-line bg-surface px-3 py-2 text-sm font-semibold text-ink">Download schema</button>
            <button type="button" disabled={loadingDocument} onClick={async () => { setLoadingDocument(true); setError(null); try { setText(JSON.stringify(await exportEventSchedule(eventId), null, 2)); setDocument(null); setPreview(null); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not load the current draft JSON'); } finally { setLoadingDocument(false); } }} className="rounded-field border border-line bg-surface px-3 py-2 text-sm font-semibold text-ink disabled:opacity-50">Reset to current draft</button>
            <button type="button" disabled={loadingExample} onClick={async () => { setLoadingExample(true); setError(null); try { const value = await fetchScheduleImportSchema(eventId); setText(JSON.stringify(value.example, null, 2)); setDocument(null); setPreview(null); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not load the example JSON'); } finally { setLoadingExample(false); } }} className="rounded-field border border-line bg-surface px-3 py-2 text-sm font-semibold text-ink disabled:opacity-50">{loadingExample ? 'Loading example…' : 'Load example'}</button>
        </div>
        <label className="mt-4 block text-sm font-semibold text-ink">JSON document
            <textarea aria-label="Schedule JSON document" value={text} disabled={loadingDocument} onChange={(event) => { setText(event.target.value); setDocument(null); setPreview(null); }} rows={12} spellCheck={false} placeholder="Loading current draft…" className="mt-2 w-full rounded-field border border-line bg-surface p-3 font-mono text-xs font-normal text-ink disabled:opacity-60" />
        </label>
        <label className="mt-3 inline-flex cursor-pointer items-center rounded-field border border-line bg-surface px-3 py-2 text-sm font-semibold text-ink">Choose JSON file<input type="file" accept="application/json,.json" className="sr-only" onChange={async (event) => { const file = event.target.files?.[0]; if (file) { setText(await file.text()); setPreview(null); } }} /></label>
        <fieldset className="mt-4"><legend className="text-sm font-semibold text-ink">Import mode</legend><div className="mt-2 flex gap-4"><label className="flex items-center gap-2 text-sm text-ink"><input type="radio" name="import-mode" checked={mode === 'merge'} onChange={() => { setMode('merge'); setPreview(null); }} />Merge</label><label className="flex items-center gap-2 text-sm text-ink"><input type="radio" name="import-mode" checked={mode === 'replace'} onChange={() => { setMode('replace'); setPreview(null); }} />Replace program</label></div><p className="mt-1 text-xs text-ink-soft">{mode === 'merge' ? 'Adds and updates what the JSON lists. Nothing else changes.' : 'The draft becomes exactly the JSON. Items missing from it are removed; items with the same external ID keep their identity, so attendee plans survive.'}</p></fieldset>
        {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
        {preview ? <div className="mt-4 bg-canvas p-4"><h3 className="font-bold text-ink">Preview</h3><p className="mt-1 text-xs text-ink-soft">Counts include sessions, locations, and taxonomy.</p><div className="mt-3 grid grid-cols-4 gap-2"><DiffCount value={preview.operations.created} label="Create" /><DiffCount value={preview.operations.updated} label="Update" /><DiffCount value={preview.operations.removed} label="Remove" /><DiffCount value={preview.operations.unchanged} label="Unchanged" /></div><ChangeDetails changes={preview.changes ?? []} excluded={excluded} onToggle={toggleChange} />{(preview.changes ?? []).length ? <p className="mt-2 text-xs text-ink-soft">{excluded.size ? `${excluded.size} ${excluded.size === 1 ? 'change' : 'changes'} will be skipped.` : 'Untick a change to skip it when applying.'}</p> : null}{preview.issues.length ? <ul className="mt-3 space-y-2">{preview.issues.map((issue, index) => <li key={`${issue.code}-${index}`} className="text-sm text-amber-900">{issue.message}</li>)}</ul> : <p className="mt-3 text-sm text-success">No schedule warnings.</p>}</div> : null}
        <div className="mt-4 flex gap-2"><button type="button" disabled={busy || loadingDocument || !text.trim()} onClick={runPreview} className="rounded-field border border-action px-4 py-2 text-sm font-semibold text-action disabled:opacity-50">{busy ? 'Checking…' : 'Preview import'}</button><button type="button" disabled={busy || !preview} onClick={apply} className="rounded-field bg-action px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Apply to draft</button></div>
    </section>;
}

function SessionEditor({ schedule, day, session, eventId, onClose, onSaved, onError }: { schedule: AdminEventSchedule; day: string; session: ScheduleSession | null; eventId: string; onClose: () => void; onSaved: () => void; onError: (message: string | null) => void }) {
    const initialStart = session ? toZonedInput(session.start, schedule.timezone) : `${day}T10:00`;
    const initialEnd = session ? toZonedInput(session.end, schedule.timezone) : `${day}T11:00`;
    const [form, setForm] = useState({ title: session?.title ?? '', description: session?.description ?? '', contributors: session?.contributors ?? [], start: initialStart, end: initialEnd, room_ids: session ? sessionRoomIds(session) : [] as number[], venue_id: session?.venue_id?.toString() ?? '', level_id: session?.level_id?.toString() ?? '', activity_type_id: session?.activity_type_id?.toString() ?? '', attendee_note: session?.attendee_note ?? '', allow_plan: session?.allow_plan ?? true, is_cancelled: session?.is_cancelled ?? false });
    const [busy, setBusy] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const formId = useId();
    const startIso = form.start ? zonedInputToIso(form.start, schedule.timezone) : '';
    const endIso = form.end ? zonedInputToIso(form.end, schedule.timezone) : '';
    const draftSession = { ...session, id: session?.id ?? 'draft', start: startIso, end: endIso } as ScheduleSession;
    const conflicts = form.is_cancelled ? [] : schedule.sessions.filter((row) => row.id !== session?.id && !row.is_cancelled && sessionRoomIds(row).some((roomId) => form.room_ids.includes(roomId)) && sessionsOverlap(draftSession, row));
    const orderedRoomIds = schedule.rooms.filter((room) => form.room_ids.includes(room.id)).map((room) => room.id);
    const toggleRoom = (roomId: number, checked: boolean) => {
        const room = schedule.rooms.find((item) => item.id === roomId);
        setForm({
            ...form,
            room_ids: checked ? [...form.room_ids, roomId] : form.room_ids.filter((id) => id !== roomId),
            venue_id: checked && room?.venue_id != null ? room.venue_id.toString() : form.venue_id,
        });
    };
    const moveContributor = (index: number, offset: -1 | 1) => {
        const target = index + offset;
        if (target < 0 || target >= form.contributors.length) return;
        const contributors = [...form.contributors];
        [contributors[index], contributors[target]] = [contributors[target], contributors[index]];
        setForm({ ...form, contributors });
    };
    const submit = async (event: React.FormEvent) => {
        event.preventDefault(); setBusy(true); onError(null);
        const body: ScheduleSessionInput = { title: form.title, instructors: null, description: form.description.trim() || null, contributors: form.contributors.map(({ contributor_id, role }) => ({ contributor_id, role })), start: startIso, end: endIso, room_id: orderedRoomIds[0] ?? null, room_ids: orderedRoomIds, venue_id: form.venue_id ? Number(form.venue_id) : null, level_id: form.level_id ? Number(form.level_id) : null, activity_type_id: form.activity_type_id ? Number(form.activity_type_id) : null, attendee_note: form.attendee_note || null, allow_plan: form.allow_plan, is_cancelled: form.is_cancelled };
        try { if (session) await updateScheduleSession(eventId, session.id, body); else await createScheduleSession(eventId, body); await onSaved(); } catch (reason) { onError(reason instanceof Error ? reason.message : 'Could not save session'); } finally { setBusy(false); }
    };
    const removeSession = async () => { if (!session) return; try { await deleteScheduleSession(eventId, session.id); await onSaved(); } catch (reason) { onError(reason instanceof Error ? reason.message : 'Could not delete session'); } };
    const duplicateSession = async () => { if (!session) return; try { await duplicateScheduleSession(eventId, session.id); await onSaved(); } catch (reason) { onError(reason instanceof Error ? reason.message : 'Could not duplicate session'); } };
    const footer = confirmDelete
        ? <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-semibold text-ink">Delete this session?</p><div className="flex gap-2"><button type="button" onClick={() => setConfirmDelete(false)} className="rounded-field border border-line bg-surface px-3 py-2 text-sm font-semibold text-ink hover:bg-canvas">Keep</button><button type="button" onClick={() => void removeSession()} className="rounded-field bg-danger px-4 py-2 text-sm font-semibold text-white hover:opacity-90">Delete session</button></div></div>
        : <>
            {conflicts.length ? <div role="status" className="mb-3 flex items-start gap-2 rounded-field border border-amber-200 bg-amber-50 p-2 text-sm text-amber-900"><AlertTriangle size={16} aria-hidden="true" className="mt-0.5 shrink-0" /><p><strong>Scheduling conflict.</strong> This overlaps {conflicts.map((item) => item.title).join(', ')} in the same room. You may still save intentionally.</p></div> : null}
            <div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="rounded-field border border-line bg-surface px-3 py-2 text-sm font-semibold text-ink hover:bg-canvas">Cancel</button><button type="submit" form={formId} disabled={busy} className="rounded-field bg-action px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50">{busy ? 'Saving…' : conflicts.length ? 'Save anyway' : 'Save'}</button></div>
        </>;
    const menu = session ? <OverflowMenu label="Session actions" items={[{ label: 'Duplicate', onSelect: () => void duplicateSession() }, { label: 'Delete session', danger: true, onSelect: () => setConfirmDelete(true) }]} /> : null;
    return <Modal title={session ? 'Edit session' : 'Add session'} onClose={onClose} headerAction={menu} footer={footer}><form id={formId} onSubmit={submit} className="space-y-4">
        <Field label="Title"><input required value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} className={FIELD_CLASS} /></Field>
        <Field label="Artists & instructors"><div className="space-y-2">{form.contributors.map((assignment, index) => <div key={`${assignment.contributor_id}-${index}`} className="grid grid-cols-[1fr_auto_auto_auto] gap-2 sm:grid-cols-[1fr_8rem_auto_auto_auto]"><select aria-label={`Contributor ${index + 1}`} value={assignment.contributor_id} onChange={(event) => setForm({ ...form, contributors: form.contributors.map((item, itemIndex) => itemIndex === index ? { ...item, contributor_id: Number(event.target.value) } : item) })} className={FIELD_CLASS}>{(schedule.contributors ?? []).map((contributor) => <option key={contributor.id} value={contributor.id}>{contributor.display_name}</option>)}</select><select aria-label={`Contributor ${index + 1} role`} value={assignment.role} onChange={(event) => setForm({ ...form, contributors: form.contributors.map((item, itemIndex) => itemIndex === index ? { ...item, role: event.target.value as ScheduleContributorRole } : item) })} className={`${FIELD_CLASS} col-span-4 row-start-2 sm:col-span-1 sm:row-start-auto`}>{(['instructor', 'dj', 'performer', 'host', 'other'] as ScheduleContributorRole[]).map((role) => <option key={role} value={role}>{role}</option>)}</select><button type="button" disabled={index === 0} aria-label={`Move contributor ${index + 1} up`} onClick={() => moveContributor(index, -1)} className="flex h-11 w-11 items-center justify-center text-ink-soft disabled:text-muted"><ChevronUp size={17} /></button><button type="button" disabled={index === form.contributors.length - 1} aria-label={`Move contributor ${index + 1} down`} onClick={() => moveContributor(index, 1)} className="flex h-11 w-11 items-center justify-center text-ink-soft disabled:text-muted"><ChevronDown size={17} /></button><button type="button" aria-label={`Remove contributor ${index + 1}`} onClick={() => setForm({ ...form, contributors: form.contributors.filter((_, itemIndex) => itemIndex !== index) })} className="flex h-11 w-11 items-center justify-center text-danger"><X size={17} /></button></div>)}<button type="button" disabled={!(schedule.contributors?.some((item) => !form.contributors.some((assignment) => assignment.contributor_id === item.id)))} onClick={() => { const contributor = schedule.contributors?.find((item) => !form.contributors.some((assignment) => assignment.contributor_id === item.id)); if (contributor) setForm({ ...form, contributors: [...form.contributors, { contributor_id: contributor.id, role: 'instructor', position: form.contributors.length }] }); }} className="flex min-h-11 items-center gap-2 text-sm font-semibold text-action disabled:text-muted"><Plus size={16} />Add artist or instructor</button></div></Field>
        <div className="grid grid-cols-2 gap-3"><Field label="Start"><input required type="datetime-local" value={form.start} onChange={(event) => setForm({ ...form, start: event.target.value })} className={FIELD_CLASS} /></Field><Field label="End"><input required type="datetime-local" value={form.end} onChange={(event) => setForm({ ...form, end: event.target.value })} className={FIELD_CLASS} /></Field></div>
        <fieldset><legend className="text-sm font-semibold text-ink">Rooms</legend><div className="mt-1 flex flex-wrap gap-2">{schedule.rooms.map((room) => <label key={room.id} className="flex min-h-9 items-center gap-2 rounded-field border border-line px-3 text-sm text-ink"><input type="checkbox" checked={form.room_ids.includes(room.id)} onChange={(event) => toggleRoom(room.id, event.target.checked)} />{room.name}</label>)}</div><p className="mt-1 text-xs text-ink-soft">No room selected means event-wide. Several rooms make the session span those columns.</p></fieldset>
        <Field label="Venue"><select value={form.venue_id} onChange={(event) => setForm({ ...form, venue_id: event.target.value })} className={FIELD_CLASS}><option value="">No venue</option>{schedule.venues.map((venue) => <option key={venue.id} value={venue.id}>{venue.name}</option>)}</select></Field>
        <div className="grid grid-cols-2 gap-3"><Field label="Level"><select value={form.level_id} onChange={(event) => setForm({ ...form, level_id: event.target.value })} className={FIELD_CLASS}><option value="">No level</option>{schedule.levels.map((level) => <option key={level.id} value={level.id}>{level.label}</option>)}</select></Field><Field label="Activity type"><select value={form.activity_type_id} onChange={(event) => setForm({ ...form, activity_type_id: event.target.value })} className={FIELD_CLASS}><option value="">No type</option>{schedule.activity_types.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select></Field></div>
        <Field label="Description"><textarea maxLength={2000} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} className={`${FIELD_CLASS} min-h-24`} placeholder="What attendees will learn or experience" /></Field>
        <Field label="Attendee note"><textarea maxLength={500} value={form.attendee_note} onChange={(event) => setForm({ ...form, attendee_note: event.target.value })} className={`${FIELD_CLASS} min-h-20`} /></Field>
        <label className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" checked={form.allow_plan} onChange={(event) => setForm({ ...form, allow_plan: event.target.checked })} />Attendees may add this to My Plan</label>
        {session ? <label className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" checked={form.is_cancelled} onChange={(event) => setForm({ ...form, is_cancelled: event.target.checked })} />Mark session cancelled</label> : null}
    </form></Modal>;
}

function OverviewItemEditor({ schedule, day, item, parent, eventId, onClose, onSaved, onError }: { schedule: AdminEventSchedule; day: string; item: ScheduleOverviewItem | null; parent?: ScheduleOverviewItem; eventId: string; onClose: () => void; onSaved: () => void; onError: (message: string | null) => void }) {
    const tz = schedule.timezone;
    const momentDefaultEnd = parent ? new Date(Math.min(Date.parse(parent.end), Date.parse(parent.start) + 60 * 60 * 1000)).toISOString() : '';
    const [form, setForm] = useState({
        title: item?.title ?? '',
        subtitle: item?.subtitle ?? '',
        description: item?.description ?? '',
        url: item?.url ?? '',
        url_label: item?.url_label ?? '',
        start: item ? toZonedInput(item.start, tz) : parent ? toZonedInput(parent.start, tz) : `${day}T10:00`,
        end: item ? toZonedInput(item.end, tz) : parent ? toZonedInput(momentDefaultEnd, tz) : `${day}T12:00`,
        parent_id: item?.parent_id ?? parent?.id ?? '',
        activity_type_id: item?.activity_type_id?.toString() ?? '',
        venue_id: item?.venue_id?.toString() ?? '',
        room_ids: item?.room_ids ?? [] as number[],
        opens_detail: item?.opens_detail ?? false,
        allow_plan: item?.allow_plan ?? false,
        is_cancelled: item?.is_cancelled ?? false,
    });
    const [busy, setBusy] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const startIso = form.start ? zonedInputToIso(form.start, tz) : '';
    const endIso = form.end ? zonedInputToIso(form.end, tz) : '';
    const formDay = startIso ? programDayOf(startIso, tz, schedule.day_start_hour) : day;
    const formId = useId();
    const allItems = schedule.overview_items ?? [];
    const moments = item ? allItems.filter((row) => row.parent_id === item.id) : [];
    const parentOptions = allItems.filter((row) => !row.parent_id && row.id !== item?.id && programDayOf(row.start, tz, schedule.day_start_hour) === formDay);
    const isMoment = Boolean(form.parent_id);
    const windowCount = startIso && endIso ? sessionsInOverviewWindow(schedule.sessions, { start: startIso, end: endIso }).length : 0;
    const submit = async (event: React.FormEvent) => {
        event.preventDefault(); setBusy(true); onError(null);
        const body: ScheduleOverviewItemInput = {
            parent_id: form.parent_id || null,
            title: form.title,
            subtitle: form.subtitle.trim() || null,
            description: form.description.trim() || null,
            url: form.url.trim() || null,
            url_label: form.url_label.trim() || null,
            start: startIso,
            end: endIso,
            activity_type_id: form.activity_type_id ? Number(form.activity_type_id) : null,
            venue_id: form.venue_id ? Number(form.venue_id) : null,
            room_ids: schedule.rooms.filter((room) => form.room_ids.includes(room.id)).map((room) => room.id),
            opens_detail: !isMoment && form.opens_detail,
            allow_plan: !isMoment && form.allow_plan,
            is_cancelled: form.is_cancelled,
            sort_order: item?.sort_order ?? 0,
        };
        try { if (item) await updateScheduleOverviewItem(eventId, item.id, body); else await createScheduleOverviewItem(eventId, body); await onSaved(); } catch (reason) { onError(reason instanceof Error ? reason.message : 'Could not save overview item'); } finally { setBusy(false); }
    };
    const remove = async () => {
        if (!item) return;
        try { await deleteScheduleOverviewItem(eventId, item.id); await onSaved(); } catch (reason) { onError(reason instanceof Error ? reason.message : 'Could not delete overview item'); }
    };
    const footer = <div className="flex flex-wrap justify-between gap-2">{item ? <button type="button" onClick={async () => { if (!confirmDelete) { setConfirmDelete(true); return; } await remove(); }} className="rounded-field px-3 py-2 text-sm font-semibold text-danger">{confirmDelete ? (moments.length ? `Confirm delete (and ${moments.length} ${moments.length === 1 ? 'moment' : 'moments'})` : 'Confirm delete') : 'Delete'}</button> : <span />}<div className="flex gap-2"><button type="button" onClick={onClose} className="rounded-field border border-line bg-surface px-3 py-2 text-sm font-semibold text-ink hover:bg-canvas">Cancel</button><button type="submit" form={formId} disabled={busy} className="rounded-field bg-action px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50">{busy ? 'Saving…' : 'Save'}</button></div></div>;
    return <Modal title={item ? (isMoment ? 'Edit moment' : 'Edit overview item') : isMoment ? 'Add moment' : 'Add overview item'} onClose={onClose} footer={footer}><form id={formId} onSubmit={submit} className="space-y-4">
        <Field label="Title"><input required maxLength={200} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} className={FIELD_CLASS} placeholder={isMoment ? 'Show performances' : 'Workshops'} /></Field>
        <Field label="Subtitle"><input maxLength={200} value={form.subtitle} onChange={(event) => setForm({ ...form, subtitle: event.target.value })} className={FIELD_CLASS} placeholder="Tagline shown under the title" /></Field>
        <Field label="Part of"><select value={form.parent_id} disabled={moments.length > 0} onChange={(event) => setForm({ ...form, parent_id: event.target.value, opens_detail: event.target.value ? false : form.opens_detail, allow_plan: event.target.value ? false : form.allow_plan })} className={FIELD_CLASS}><option value="">Top-level item</option>{parentOptions.map((row) => <option key={row.id} value={row.id}>{row.title} · {formatTimeRange(row, tz)}</option>)}</select>{moments.length ? <p className="mt-1 text-xs font-normal text-ink-soft">This item has moments, so it stays top-level.</p> : null}</Field>
        <div className="grid grid-cols-2 gap-3"><Field label="Start"><input required type="datetime-local" value={form.start} onChange={(event) => setForm({ ...form, start: event.target.value })} className={FIELD_CLASS} /></Field><Field label="End"><input required type="datetime-local" value={form.end} onChange={(event) => setForm({ ...form, end: event.target.value })} className={FIELD_CLASS} /></Field></div>
        <div className="grid grid-cols-2 gap-3"><Field label="Activity type"><select value={form.activity_type_id} onChange={(event) => setForm({ ...form, activity_type_id: event.target.value })} className={FIELD_CLASS}><option value="">No type</option>{schedule.activity_types.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select></Field><Field label="Venue"><select value={form.venue_id} onChange={(event) => setForm({ ...form, venue_id: event.target.value })} className={FIELD_CLASS}><option value="">{isMoment ? 'Same as parent' : 'No venue'}</option>{schedule.venues.map((venue) => <option key={venue.id} value={venue.id}>{venue.name}</option>)}</select></Field></div>
        {schedule.rooms.length ? <fieldset><legend className="text-sm font-semibold text-ink">Rooms</legend><div className="mt-1 flex flex-wrap gap-2">{schedule.rooms.map((room) => <label key={room.id} className="flex min-h-9 items-center gap-2 rounded-field border border-line px-3 text-sm text-ink"><input type="checkbox" checked={form.room_ids.includes(room.id)} onChange={(event) => setForm({ ...form, room_ids: event.target.checked ? [...form.room_ids, room.id] : form.room_ids.filter((id) => id !== room.id) })} />{room.name}</label>)}</div>{isMoment ? <p className="mt-1 text-xs text-ink-soft">Leave empty to use the parent's rooms.</p> : null}</fieldset> : null}
        {!isMoment ? <div><label className="flex items-center gap-2 text-sm font-semibold text-ink"><input type="checkbox" checked={form.opens_detail} onChange={(event) => setForm({ ...form, opens_detail: event.target.checked })} />Has detailed schedule</label><p className={`mt-1 text-xs ${form.opens_detail && !windowCount ? 'text-amber-800' : 'text-ink-soft'}`}>{windowCount} {windowCount === 1 ? 'session starts' : 'sessions start'} in this window.{form.opens_detail ? ' Attendees tapping this item jump to the full schedule at its start time.' : ''}</p></div> : null}
        {!isMoment ? <div><label className="flex items-center gap-2 text-sm font-semibold text-ink"><input type="checkbox" checked={form.allow_plan} onChange={(event) => setForm({ ...form, allow_plan: event.target.checked })} />Attendees can add to My Plan</label><p className="mt-1 text-xs text-ink-soft">For blocks booked as a whole, like a bootcamp or a separate-ticket class.</p></div> : null}
        <Field label="Description"><textarea maxLength={2000} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} className={`${FIELD_CLASS} min-h-24`} /></Field>
        <div className="grid grid-cols-[2fr_1fr] gap-3"><Field label="Link"><input type="url" maxLength={500} value={form.url} onChange={(event) => setForm({ ...form, url: event.target.value })} className={FIELD_CLASS} placeholder="https://" /></Field><Field label="Link label"><input maxLength={80} value={form.url_label} onChange={(event) => setForm({ ...form, url_label: event.target.value })} className={FIELD_CLASS} placeholder="More info" /></Field></div>
        {item ? <label className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" checked={form.is_cancelled} onChange={(event) => setForm({ ...form, is_cancelled: event.target.checked })} />Mark cancelled</label> : null}
    </form></Modal>;
}

function ConfigEditor({ schedule, eventId, kind, item, onClose, onSaved, onError }: { schedule: AdminEventSchedule; eventId: string; kind: ConfigKind; item?: ConfigEntity; onClose: () => void; onSaved: () => void; onError: (message: string | null) => void }) {
    const label = item && 'display_name' in item ? item.display_name : item && 'label' in item ? item.label : item && 'name' in item ? item.name : '';
    const [name, setName] = useState(label);
    const [secondary, setSecondary] = useState(item && 'address' in item ? item.address ?? '' : item && 'notation' in item ? item.notation ?? '' : '');
    const [color, setColor] = useState(item && 'color' in item ? item.color : 'blue');
    const [venueId, setVenueId] = useState(item && 'venue_id' in item ? item.venue_id?.toString() ?? '' : '');
    const [details, setDetails] = useState(item && 'venue_id' in item ? item.details ?? '' : '');
    const [confirmDelete, setConfirmDelete] = useState(false);
    const save = async () => {
        try {
            if (kind === 'venue') { const body = { name, address: secondary || null, sort_order: item?.sort_order ?? schedule.venues.length }; if (item) await updateScheduleVenue(eventId, item.id, body); else await createScheduleVenue(eventId, body); }
            if (kind === 'room') { const body = { name, details: details.trim() || null, venue_id: venueId ? Number(venueId) : null, color, sort_order: item?.sort_order ?? schedule.rooms.length }; if (item) await updateScheduleRoom(eventId, item.id, body); else await createScheduleRoom(eventId, body); }
            if (kind === 'level') { const body = { label: name, notation: secondary || null, sort_order: item?.sort_order ?? schedule.levels.length }; if (item) await updateScheduleLevel(eventId, item.id, body); else await createScheduleLevel(eventId, body); }
            if (kind === 'activity') { const body = { name, color, sort_order: item?.sort_order ?? schedule.activity_types.length }; if (item) await updateScheduleActivityType(eventId, item.id, body); else await createScheduleActivityType(eventId, body); }
            if (kind === 'contributor') { const body = { display_name: name, sort_order: item?.sort_order ?? schedule.contributors?.length ?? 0 }; if (item) await updateScheduleContributor(eventId, item.id, body); else await createScheduleContributor(eventId, body); }
            await onSaved();
        } catch (reason) { onError(reason instanceof Error ? reason.message : 'Could not save item'); }
    };
    const remove = async () => { if (!item) return; try { if (kind === 'venue') await deleteScheduleVenue(eventId, item.id); if (kind === 'room') await deleteScheduleRoom(eventId, item.id); if (kind === 'level') await deleteScheduleLevel(eventId, item.id); if (kind === 'activity') await deleteScheduleActivityType(eventId, item.id); if (kind === 'contributor') await deleteScheduleContributor(eventId, item.id); await onSaved(); } catch (reason) { onError(reason instanceof Error ? reason.message : 'Could not delete item'); } };
    const footer = <div className="flex justify-between gap-2">{item ? <button type="button" onClick={async () => { if (!confirmDelete) { setConfirmDelete(true); return; } await remove(); }} className="flex items-center gap-2 px-3 py-2 text-sm font-semibold text-danger"><Trash2 size={16} />{confirmDelete ? 'Confirm delete' : 'Delete'}</button> : <span />}<div className="flex gap-2"><button type="button" onClick={onClose} className="rounded-field border border-line bg-surface px-3 py-2 text-sm font-semibold text-ink hover:bg-canvas">Cancel</button><button type="button" onClick={save} disabled={!name.trim()} className="rounded-field bg-action px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50">Save</button></div></div>;
    return <Modal title={`${item ? 'Edit' : 'Add'} ${kind === 'activity' ? 'activity type' : kind}`} onClose={onClose} footer={footer}><div className="space-y-4"><Field label={kind === 'level' ? 'Label' : 'Name'}><input value={name} onChange={(event) => setName(event.target.value)} className={FIELD_CLASS} /></Field>{kind === 'venue' ? <Field label="Address"><input value={secondary} onChange={(event) => setSecondary(event.target.value)} className={FIELD_CLASS} /></Field> : null}{kind === 'level' ? <Field label="Notation"><input value={secondary} onChange={(event) => setSecondary(event.target.value)} className={FIELD_CLASS} placeholder="*, **, ***" /></Field> : null}{kind === 'room' ? <Field label="Details"><input maxLength={160} value={details} onChange={(event) => setDetails(event.target.value)} className={FIELD_CLASS} placeholder="Ground floor · Grand Pass only" /></Field> : null}{kind === 'room' ? <Field label="Venue"><select value={venueId} onChange={(event) => setVenueId(event.target.value)} className={FIELD_CLASS}><option value="">No venue</option>{schedule.venues.map((venue) => <option key={venue.id} value={venue.id}>{venue.name}</option>)}</select></Field> : null}{kind === 'room' || kind === 'activity' ? <Field label="Color"><div className="flex flex-wrap gap-2">{Object.keys(SCHEDULE_COLORS).map((value) => <button key={value} type="button" aria-label={value} onClick={() => setColor(value)} className={`h-9 w-9 border-2 ${scheduleColor(value).header} ${color === value ? 'border-action' : 'border-transparent'}`} />)}</div></Field> : null}</div></Modal>;
}

function PublishDialog({ schedule: current, eventId, eventTitle, onClose, onPublished, onReverted }: { schedule: AdminEventSchedule; eventId: string; eventTitle: string; onClose: () => void; onPublished: () => Promise<void>; onReverted: (next: AdminEventSchedule) => void }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [revertingKey, setRevertingKey] = useState<string | null>(null);
    const [revertError, setRevertError] = useState<string | null>(null);
    const [preview, setPreview] = useState<SchedulePublishPreview | null>(null);
    const [published, setPublished] = useState<SchedulePublishResponse | null>(null);
    const [pending, setPending] = useState<NotifyJob | null>(null);
    const [result, setResult] = useState<{ version: number; personal: number; totals: NotifyTotals | null } | null>(null);
    // Keep showing the reviewed draft after publish reloads the (now empty) diff.
    const [frozen, setFrozen] = useState<AdminEventSchedule | null>(null);
    const schedule = frozen ?? current;
    const firstPublish = schedule.version == null;
    const changes = schedule.diff.changes;
    const countOf = (operation: ScheduleChange['operation'], fallback: number) => changes
        ? changes.filter((change) => change.operation === operation && (change.entity_type === 'session' || change.entity_type === 'overview_item')).length
        : fallback;
    const liveSessions = schedule.sessions.filter((session) => !session.is_cancelled).length;
    const defaultMessage = firstPublish
        ? liveSessions ? `${liveSessions} ${liveSessions === 1 ? 'session' : 'sessions'} over ${schedule.days.length} ${schedule.days.length === 1 ? 'day' : 'days'}. Build your plan.` : 'Browse the program and build your plan.'
        : programUpdateMessage(changes ?? [], schedule.timezone);
    const draft = useNotifyDraft(eventId, firstPublish ? 'available' : 'updated', defaultMessage, firstPublish ? [] : preview?.impacted_user_ids ?? null);
    useEffect(() => {
        if (firstPublish || published) return;
        let cancelled = false;
        fetchSchedulePublishPreview(eventId)
            .then((value) => { if (!cancelled) setPreview(value); })
            .catch(() => { if (!cancelled) setPreview({ impacted_user_ids: [], sample_message: null }); });
        return () => { cancelled = true; };
    }, [eventId, firstPublish, published, changes]);
    const revert = async (change: ScheduleChange) => {
        setRevertingKey(changeKey(change)); setRevertError(null);
        try { onReverted(await revertScheduleChange(eventId, change)); }
        catch (reason) { setRevertError(reason instanceof Error ? reason.message : 'Could not revert this change'); }
        finally { setRevertingKey(null); }
    };
    const publish = async () => {
        const job = pending ?? notifyJob(draft);
        setPending(job); setBusy(true); setError(null);
        let value = published;
        try {
            if (!value) {
                setFrozen(schedule);
                value = await publishEventSchedule(eventId, { notifyImpactedPlanners: job.personal > 0 });
                setPublished(value);
                await onPublished();
            }
            const totals = job.userIds.length ? await sendProgramNotification(eventId, job) : null;
            setResult({ version: value.version ?? 1, personal: value.notification_summary.impacted_planners, totals });
        } catch (reason) {
            if (!value) setFrozen(null);
            setError(reason instanceof Error ? reason.message : published ? 'Could not send the notification' : 'Publish failed');
        } finally {
            setBusy(false);
        }
    };
    if (result) return <Modal title={`Version ${result.version} published`} onClose={onClose} footer={<DoneFooter onClose={onClose} />}><NotifyResult totals={result.totals} personal={result.personal} /></Modal>;
    const notifying = draft.enabled && draft.total > 0;
    const label = published ? (busy ? 'Sending…' : 'Retry sending') : busy ? 'Publishing…' : notifying ? `Publish & notify ${draft.total}` : 'Publish';
    const footer = <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded-field border border-line bg-surface px-3 py-2 text-sm font-semibold text-ink hover:bg-canvas">{published ? 'Close' : 'Cancel'}</button>
        <button type="button" disabled={busy || (!published && !draft.canSend)} onClick={() => void publish()} className="rounded-field bg-action px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50">{label}</button>
    </div>;
    return <Modal title="Publish program" onClose={onClose} footer={footer}><div className="space-y-4">
        <p className="text-sm text-ink-soft">{firstPublish ? 'Publishing makes this program visible to attendees.' : 'Publishing replaces the attendee program with this reviewed draft.'}</p>
        <div className="grid grid-cols-3 gap-2 text-center"><DiffCount value={countOf('create', schedule.diff.added_session_ids.length)} label="Added" /><DiffCount value={countOf('remove', schedule.diff.removed_session_ids.length)} label="Removed" /><DiffCount value={countOf('update', Object.keys(schedule.diff.changed_sessions).length)} label="Changed" /></div>
        <ChangeDetails changes={changes ?? []} onRevert={firstPublish || published ? undefined : (change) => void revert(change)} revertingKey={revertingKey} />
        {revertError ? <p className="text-sm text-danger">{revertError}</p> : null}
        {schedule.issues.length ? <div><h3 className="text-sm font-bold text-ink">Warnings</h3><ul className="mt-2 space-y-2">{schedule.issues.map((issue, index) => <li key={`${issue.code}-${index}`} className="border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{issue.message}</li>)}</ul></div> : <p className="text-sm font-medium text-success">No schedule warnings.</p>}
        {published ? <p className="text-sm font-medium text-success">Version {published.version} published.</p> : <NotifyRow draft={draft} eventTitle={eventTitle} sample={preview?.sample_message} />}
        {error ? <p className="text-sm text-danger">{error}</p> : null}
    </div></Modal>;
}

type NotifyTotals = { delivered: number; emailed: number; pushed: number; skipped: number };
type NotifyJob = { userIds: string[]; personal: number; reason: ProgramNotifyReason; title: string; message: string };

const NOTIFY_MAX_MESSAGE = 255;
const NOTIFY_BATCH = 200;
const NOTIFY_TITLES: Record<ProgramNotifyReason, string> = {
    available: 'Program now available',
    updated: 'Program updated',
    under_work: 'Program under work',
    back: 'Program is back',
    custom: 'Program update',
};
const VISIBILITY_COPY = {
    unpublish: { reason: 'under_work', heading: 'Unpublish program?', done: 'Program unpublished', verb: 'Unpublish', busy: 'Unpublishing…', intro: 'Attendees will see "Program under work" on the event page until you republish. Your draft and published versions are kept.', message: "The program is being updated. We'll let you know when it's back." },
    republish: { reason: 'back', heading: 'Republish program?', done: 'Program republished', verb: 'Republish', busy: 'Republishing…', intro: 'Attendees see the latest published version again. No new version is created.', message: "The program is available again. Check what's new." },
} as const;

async function sendProgramNotification(eventId: string, job: NotifyJob): Promise<NotifyTotals> {
    const totals = { delivered: 0, emailed: 0, pushed: 0, skipped: 0 };
    for (let index = 0; index < job.userIds.length; index += NOTIFY_BATCH) {
        const value = await notifyProgram(eventId, { user_ids: job.userIds.slice(index, index + NOTIFY_BATCH), reason: job.reason, title: job.title.trim(), message: job.message.trim() });
        const skipped = value.results.filter((row) => row.status.startsWith('skipped')).length;
        totals.skipped += skipped;
        totals.delivered += value.results.length - skipped;
        totals.emailed += value.emailed;
        totals.pushed += value.pushed;
    }
    return totals;
}

/** Audience and copy for a program notification. `impactedIds` is null while still loading. */
function useNotifyDraft(eventId: string, reason: ProgramNotifyReason, defaultMessage: string, impactedIds: string[] | null) {
    const [candidates, setCandidates] = useState<ProgramNotifyCandidate[] | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [enabled, setEnabled] = useState(true);
    const [customTitle, setCustomTitle] = useState<string | null>(null);
    const [customMessage, setCustomMessage] = useState<string | null>(null);
    useEffect(() => {
        let cancelled = false;
        fetchProgramNotifyCandidates(eventId)
            .then((value) => { if (!cancelled) setCandidates(value); })
            .catch((error: unknown) => { if (!cancelled) setLoadError(error instanceof Error ? error.message : 'Could not load recipients'); });
        return () => { cancelled = true; };
    }, [eventId]);
    const impacted = new Set(impactedIds ?? []);
    const [personalOn, setPersonalOn] = useState(true);
    const [broadcastOn, setBroadcastOn] = useState(true);
    const splitPersonal = personalOn && impacted.size > 0;
    // Planners whose sessions changed get a personal message instead of the broadcast.
    const audience = (candidates ?? []).filter((row) => !splitPersonal || !impacted.has(row.user_id));
    const recipients = enabled && broadcastOn ? audience : [];
    const personal = enabled && splitPersonal ? impacted.size : 0;
    const title = customTitle ?? NOTIFY_TITLES[reason];
    const message = (customMessage ?? defaultMessage).slice(0, NOTIFY_MAX_MESSAGE);
    const ready = Boolean(candidates) && impactedIds !== null;
    return {
        reason, loadError, ready, enabled, setEnabled,
        impactedCount: impacted.size, audienceCount: audience.length, personalOn, setPersonalOn, broadcastOn, setBroadcastOn,
        recipients, personal, total: recipients.length + personal,
        title, setTitle: setCustomTitle, message, setMessage: setCustomMessage,
        canSend: !enabled || (ready && (!recipients.length || Boolean(title.trim() && message.trim()))),
    };
}
type NotifyDraft = ReturnType<typeof useNotifyDraft>;

const notifyJob = (draft: NotifyDraft): NotifyJob => ({ userIds: draft.recipients.map((row) => row.user_id), personal: draft.personal, reason: draft.reason, title: draft.title, message: draft.message });

function NotifyRow({ draft, eventTitle, sample }: { draft: NotifyDraft; eventTitle: string; sample?: string | null }) {
    const [open, setOpen] = useState(false);
    const summary = !draft.enabled
        ? 'Nobody will be notified'
        : draft.loadError ?? (!draft.ready
            ? 'Loading recipients…'
            : `${draft.total} ${draft.total === 1 ? 'person' : 'people'}${draft.personal ? ` · ${draft.personal} personal plan ${draft.personal === 1 ? 'update' : 'updates'}` : ''}`);
    return <section className="border-t border-line pt-4">
        <div className="flex items-center gap-3">
            <Switch checked={draft.enabled} onChange={draft.setEnabled} label="Notify attendees" />
            <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-ink">Notify attendees</p>
                <p className={`truncate text-xs ${draft.loadError && draft.enabled ? 'text-danger' : 'text-ink-soft'}`}>{summary}</p>
            </div>
            <button type="button" disabled={!draft.enabled || !draft.ready} onClick={() => setOpen(!open)} aria-expanded={open} className="flex shrink-0 items-center gap-1 rounded-field px-2 py-2 text-sm font-semibold text-action hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50">
                Customize<ChevronDown size={16} aria-hidden="true" className={`transition-transform ${open ? 'rotate-180' : ''}`} />
            </button>
        </div>
        {open && draft.enabled && draft.ready ? <NotifyComposer draft={draft} eventTitle={eventTitle} sample={sample} /> : null}
    </section>;
}

function NotifyComposer({ draft, eventTitle, sample }: { draft: NotifyDraft; eventTitle: string; sample?: string | null }) {
    const [showOptedOut, setShowOptedOut] = useState(false);
    const optedOut = draft.recipients.filter((row) => !row.email_enabled && !row.push_enabled).length;
    const everyoneLabel = `${draft.personalOn && draft.impactedCount ? 'Everyone else going' : 'Everyone going'} · ${draft.audienceCount}`;
    return <div className="mt-4 space-y-4">
        <div>
            <div className="flex items-center justify-between gap-2">
                {draft.impactedCount ? <div className="flex flex-wrap gap-2">
                    <AudienceChip label={`Plan changed · ${draft.impactedCount}`} pressed={draft.personalOn} onToggle={() => draft.setPersonalOn(!draft.personalOn)} />
                    <AudienceChip label={everyoneLabel} pressed={draft.broadcastOn} onToggle={() => draft.setBroadcastOn(!draft.broadcastOn)} />
                </div> : <p className="text-sm font-semibold text-ink">{everyoneLabel}</p>}
                {optedOut ? <button type="button" aria-expanded={showOptedOut} onClick={() => setShowOptedOut(!showOptedOut)} className="flex min-h-9 shrink-0 items-center gap-1 rounded-field px-2 text-xs font-semibold text-ink-soft hover:bg-canvas"><Info size={14} aria-hidden="true" />{optedOut} in-app only</button> : null}
            </div>
            {showOptedOut ? <p className="mt-1 text-xs text-ink-soft">{optedOut} turned off program emails and push, so they only get the in-app notification.</p> : null}
        </div>
        {draft.recipients.length ? <>
            <Field label="Title"><input required maxLength={120} value={draft.title} onChange={(event) => draft.setTitle(event.target.value)} className={FIELD_CLASS} /></Field>
            <Field label="Message"><textarea required maxLength={NOTIFY_MAX_MESSAGE} rows={6} value={draft.message} onChange={(event) => draft.setMessage(event.target.value)} className={`${FIELD_CLASS} min-h-32`} placeholder="What should attendees know?" /></Field>
            <p className="-mt-3 text-right text-xs text-ink-soft">{draft.message.length}/{NOTIFY_MAX_MESSAGE}</p>
            <div className="rounded-card bg-canvas p-3" data-testid="notify-preview">
                <p className="text-xs font-semibold uppercase text-ink-soft">Preview</p>
                <p className="mt-2 text-sm font-semibold text-ink">{eventTitle}</p>
                <p className="text-sm font-semibold text-ink">{draft.title || NOTIFY_TITLES[draft.reason]}</p>
                <p className="whitespace-pre-line text-sm text-ink-soft">{draft.message}</p>
                <p className="mt-2 text-xs text-ink-soft">Email subject: {eventTitle}: {draft.title}</p>
                {draft.personal && sample ? <p className="mt-2 text-xs text-ink-soft">Plan changed: “{sample}”</p> : null}
            </div>
        </> : draft.personal && sample ? <p className="rounded-card bg-canvas p-3 text-xs text-ink-soft" data-testid="notify-preview">Plan changed: “{sample}”</p> : null}
    </div>;
}

function AudienceChip({ label, pressed, onToggle }: { label: string; pressed: boolean; onToggle: () => void }) {
    return <button type="button" aria-pressed={pressed} onClick={onToggle} className={`flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-sm font-semibold ${pressed ? 'border-action bg-action/10 text-action' : 'border-line bg-surface text-ink-soft hover:bg-canvas'}`}>
        {pressed ? <Check size={15} aria-hidden="true" /> : null}{label}
    </button>;
}

function NotifyResult({ totals, personal }: { totals: NotifyTotals | null; personal: number }) {
    const sent = (totals?.delivered ?? 0) + personal;
    return <div className="space-y-4">
        {sent ? <p className="text-sm text-success"> {sent} {sent === 1 ? 'person' : 'people'} notified {personal ? ` · ${personal} plan update` : ''}.</p> : <p className="text-sm text-ink-soft">Nobody was notified.</p>}
        {totals ? <p className="text-sm text-ink-soft">{totals.emailed} {totals.emailed === 1 ? 'email' : 'emails'} · {totals.pushed} push · {totals.delivered} in-app.{totals.skipped ? ` ${totals.skipped} skipped.` : ''}</p> : null}
    </div>;
}

function DoneFooter({ onClose }: { onClose: () => void }) {
    return <div className="flex justify-end"><button type="button" onClick={onClose} className="rounded-field border border-line bg-surface px-3 py-2 text-sm font-semibold text-ink hover:bg-canvas">Done</button></div>;
}

function ProgramNotifyDialog({ eventId, eventTitle, onClose }: { eventId: string; eventTitle: string; onClose: () => void }) {
    const draft = useNotifyDraft(eventId, 'custom', '', []);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [sent, setSent] = useState<NotifyTotals | null>(null);
    const send = async () => {
        setBusy(true); setError(null);
        try {
            setSent(await sendProgramNotification(eventId, notifyJob(draft)));
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : 'Could not send the notification');
        } finally {
            setBusy(false);
        }
    };
    if (sent) return <Modal title="Notify attendees" onClose={onClose} footer={<DoneFooter onClose={onClose} />}><NotifyResult totals={sent} personal={0} /></Modal>;
    const footer = <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded-field border border-line bg-surface px-3 py-2 text-sm font-semibold text-ink hover:bg-canvas">Cancel</button>
        <button type="button" disabled={busy || !draft.recipients.length || !draft.title.trim() || !draft.message.trim()} onClick={() => void send()} className="rounded-field bg-action px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50">{busy ? 'Sending…' : `Send to ${draft.recipients.length}`}</button>
    </div>;
    return <Modal title="Notify attendees" onClose={onClose} footer={footer}><div className="space-y-4">
        <p className="text-sm text-ink-soft">Send a message to people who plan to attend.</p>
        {draft.loadError ? <p className="text-sm text-danger">{draft.loadError}</p> : null}
        {!draft.ready && !draft.loadError ? <p className="text-sm text-ink-soft">Loading recipients…</p> : null}
        {draft.ready ? <NotifyComposer draft={draft} eventTitle={eventTitle} /> : null}
        {error ? <p className="text-sm text-danger">{error}</p> : null}
    </div></Modal>;
}

function VisibilityDialog({ action, eventId, eventTitle, onClose, onChange }: { action: 'unpublish' | 'republish'; eventId: string; eventTitle: string; onClose: () => void; onChange: () => Promise<void> }) {
    const copy = VISIBILITY_COPY[action];
    const draft = useNotifyDraft(eventId, copy.reason, copy.message, []);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [changed, setChanged] = useState(false);
    const [pending, setPending] = useState<NotifyJob | null>(null);
    const [result, setResult] = useState<{ totals: NotifyTotals | null } | null>(null);
    const confirm = async () => {
        const job = pending ?? notifyJob(draft);
        setPending(job); setBusy(true); setError(null);
        try {
            if (!changed) {
                await onChange();
                setChanged(true);
            }
            setResult({ totals: job.userIds.length ? await sendProgramNotification(eventId, job) : null });
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : changed ? 'Could not send the notification' : 'Could not change program visibility');
        } finally {
            setBusy(false);
        }
    };
    if (result) return <Modal title={copy.done} onClose={onClose} footer={<DoneFooter onClose={onClose} />}><NotifyResult totals={result.totals} personal={0} /></Modal>;
    const label = changed ? (busy ? 'Sending…' : 'Retry sending') : busy ? copy.busy : draft.enabled && draft.total ? `${copy.verb} & notify ${draft.total}` : copy.verb;
    const footer = <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded-field border border-line bg-surface px-3 py-2 text-sm font-semibold text-ink hover:bg-canvas">{changed ? 'Close' : 'Cancel'}</button>
        <button type="button" disabled={busy || (!changed && !draft.canSend)} onClick={() => void confirm()} className="rounded-field bg-action px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50">{label}</button>
    </div>;
    return <Modal title={copy.heading} onClose={onClose} footer={footer}><div className="space-y-4">
        <p className="text-sm text-ink-soft">{copy.intro}</p>
        {changed ? <p className="text-sm font-medium text-success">{copy.done}.</p> : <NotifyRow draft={draft} eventTitle={eventTitle} />}
        {error ? <p className="text-sm text-danger">{error}</p> : null}
    </div></Modal>;
}

function PreviewDialog({ eventId, onClose }: { eventId: string; onClose: () => void }) {
    const url = `/event/${eventId}/program?preview=draft&embed=program`;
    return <Modal title="Preview as attendee" onClose={onClose} wide footer={<a href={`/event/${eventId}/program?preview=draft`} target="_blank" rel="noreferrer" className="flex items-center justify-center gap-2 py-1 text-sm font-semibold text-action">Open in new tab <ExternalLink size={15} /></a>}>
        <div className="flex justify-center"><iframe title="Draft attendee preview" src={url} className="h-[70dvh] w-[390px] max-w-full rounded-card border-4 border-ink bg-surface sm:h-[72vh]" /></div>
    </Modal>;
}

function OverflowMenu({ label, items }: { label: string; items: Array<{ label: string; onSelect: () => void; danger?: boolean; icon?: React.ReactNode }> }) {
    const [open, setOpen] = useState(false);
    return <div className="relative">
        <button type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} className="flex h-11 w-11 items-center justify-center rounded-field text-ink-soft hover:bg-canvas"><MoreHorizontal size={20} /></button>
        {open ? <>
            <button type="button" aria-hidden="true" tabIndex={-1} className="fixed inset-0 z-[11001] cursor-default" onClick={() => setOpen(false)} />
            <div role="menu" aria-label={label} className="absolute right-0 top-full z-[11002] mt-1 min-w-48 overflow-hidden rounded-card border border-card-line bg-surface py-1 shadow-xl">
                {items.map((item) => <button key={item.label} type="button" role="menuitem" onClick={() => { setOpen(false); item.onSelect(); }} className={`flex min-h-11 w-full items-center gap-2 px-4 text-left text-sm font-semibold hover:bg-canvas ${item.danger ? 'text-danger' : 'text-ink'}`}>{item.icon}{item.label}</button>)}
            </div>
        </> : null}
    </div>;
}

const changeKey = (change: ScheduleChange) => `${change.entity_type}-${change.operation}-${change.entity_id}`;

function ChangeDetails({ changes, onRevert, revertingKey, excluded, onToggle }: { changes: ScheduleChange[]; onRevert?: (change: ScheduleChange) => void; revertingKey?: string | null; excluded?: Set<string>; onToggle?: (change: ScheduleChange) => void }) {
    if (!changes.length) return <p className="mt-3 text-sm text-ink-soft">No content changes.</p>;
    const formatValue = (value: unknown) => value == null ? 'None' : Array.isArray(value) ? value.join(', ') || 'None' : typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value);
    return <details className="mt-3 border-t border-line pt-3"><summary className="cursor-pointer text-sm font-semibold text-action">View {changes.length} change {changes.length === 1 ? 'detail' : 'details'}</summary><ul className="mt-3 max-h-72 space-y-3 overflow-y-auto">{changes.map((change) => {
        const key = changeKey(change);
        const skipped = excluded?.has(key) ?? false;
        return <li key={key} className={`bg-surface p-3 text-sm ${skipped ? 'opacity-60' : ''}`}><div className="flex items-start justify-between gap-3">{onToggle ? <label className="flex min-w-0 items-start gap-2"><input type="checkbox" checked={!skipped} onChange={() => onToggle(change)} aria-label={`Apply ${change.operation} ${change.label}`} className="mt-0.5" /><span className={`font-semibold text-ink ${skipped ? 'line-through' : ''}`}>{change.label}</span></label> : <span className="font-semibold text-ink">{change.label}</span>}<span className="flex shrink-0 items-center gap-3"><span className={change.operation === 'remove' ? 'text-danger' : 'text-ink-soft'}>{change.operation} {change.entity_type.replace('_', ' ')}</span>{onRevert ? <button type="button" disabled={Boolean(revertingKey)} onClick={() => onRevert(change)} aria-label={`Revert ${change.label}`} className="font-semibold text-action disabled:cursor-not-allowed disabled:opacity-50">{revertingKey === key ? 'Reverting…' : 'Revert'}</button> : null}</span></div>{change.fields.length ? <dl className="mt-2 space-y-1 text-xs">{change.fields.map((field) => <div key={field.field} className="grid grid-cols-[minmax(6rem,0.4fr)_1fr] gap-2"><dt className="font-medium text-ink-soft">{field.field.replaceAll('_', ' ')}</dt><dd className="break-words text-ink"><span className="text-ink-soft line-through">{formatValue(field.before)}</span> → {formatValue(field.after)}</dd></div>)}</dl> : null}</li>;
    })}</ul></details>;
}

function supportedTimezones(current: string): string[] {
    const values = (Intl as typeof Intl & { supportedValuesOf?: (key: 'timeZone') => string[] }).supportedValuesOf?.('timeZone') ?? [];
    return [...new Set(['UTC', current, ...values])].sort((left, right) => left.localeCompare(right));
}

function Modal({ title, onClose, wide = false, sheetOnMobile = true, headerAction, footer, children }: { title: string; onClose: () => void; wide?: boolean; sheetOnMobile?: boolean; headerAction?: React.ReactNode; footer?: React.ReactNode; children: React.ReactNode }) {
    useBackToClose(onClose);
    return <div className={`fixed inset-0 z-[11000] flex bg-black/50 ${sheetOnMobile ? 'items-end justify-center p-0 sm:items-center sm:p-4' : 'items-center justify-center p-4'}`} onClick={onClose}>
        <div role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()} className={`flex flex-col overflow-hidden bg-surface shadow-2xl ${sheetOnMobile ? 'max-h-[92dvh] rounded-t-card sm:max-h-[92vh] sm:rounded-card' : 'max-h-[92vh] rounded-card'} ${wide ? 'w-full max-w-4xl sm:w-auto' : 'w-full max-w-xl'}`}>
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line py-2 pl-5 pr-2">
                <h2 className="min-w-0 truncate text-lg font-bold text-ink">{title}</h2>
                <div className="flex shrink-0 items-center">{headerAction}<button type="button" onClick={onClose} className="flex h-11 w-11 items-center justify-center text-ink-soft" aria-label="Close"><X size={20} /></button></div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
            {footer ? <div className="shrink-0 border-t border-line bg-surface px-5 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:pb-3">{footer}</div> : null}
        </div>
    </div>;
}
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block text-sm font-semibold text-ink">{label}<div className="mt-1">{children}</div></label>; }
function DiffCount({ value, label }: { value: number; label: string }) { return <div className="bg-canvas px-3 py-2 text-sm text-ink-soft"><span className="font-bold text-ink">{value}</span> {label}</div>; }
function AdminState({ text }: { text: string }) { return <div className="flex min-h-full items-center justify-center bg-canvas p-6 text-sm text-ink-soft">{text}</div>; }
function ProgramEditorAccessDenied({ onBack }: { onBack: () => void }) { return <div className="flex min-h-full flex-col items-center justify-center gap-3 bg-canvas p-6 text-center"><h1 className="text-lg font-bold text-ink">Program editor access required</h1><p className="text-sm text-ink-soft">You no longer have permission to edit this event program.</p><button type="button" onClick={onBack} className="text-sm font-semibold text-action">Back to program</button></div>; }
