import { useEffect, useId, useState } from 'react';
import { ChevronLeft, ExternalLink, Eye, Plus, Search, Send, Trash2, Users, X } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import {
    createAdminEventSchedule,
    createScheduleActivityType,
    createScheduleLevel,
    createScheduleRoom,
    createScheduleSession,
    createScheduleVenue,
    deleteScheduleActivityType,
    deleteScheduleLevel,
    deleteScheduleRoom,
    deleteScheduleSession,
    deleteScheduleVenue,
    applyScheduleImport,
    duplicateScheduleSession,
    exportEventSchedule,
    fetchAdminEventSchedule,
    fetchEvent,
    fetchOptionalAdminEventSchedule,
    fetchSchedulePlanners,
    publishEventSchedule,
    fetchScheduleImportSchema,
    previewScheduleImport,
    updateAdminEventSchedule,
    updateScheduleActivityType,
    updateScheduleLevel,
    updateScheduleRoom,
    updateScheduleSession,
    updateScheduleVenue,
    type ScheduleSessionInput,
    type SchedulePlanner,
    type SchedulePublishResponse,
} from '../api';
import ScheduleGrid from '../components/program/ScheduleGrid';
import { ProgramDayPicker, ProgramFilters } from '../components/program/ProgramControls';
import { ROOM_COLORS, roomColor } from '../components/program/RoomPill';
import type { AdminEventSchedule, CalendarEvent, ScheduleActivityType, ScheduleImportDocument, ScheduleImportPreview, ScheduleLevel, ScheduleRoom, ScheduleSession, ScheduleVenue } from '../types';
import { filterScheduleSessions, firstDayWithSessions, formatDayDateLabel, formatTimeRange, programDayOf, sessionsForDay, sessionsOverlap, toZonedInput, zonedInputToIso, type ScheduleFilters } from '../utils/schedule';

type Section = 'schedule' | 'sessions' | 'locations' | 'taxonomy' | 'settings';
type ConfigEntity = ScheduleVenue | ScheduleRoom | ScheduleLevel | ScheduleActivityType;
type ConfigKind = 'venue' | 'room' | 'level' | 'activity';
const FIELD_CLASS = 'w-full rounded-field border border-line bg-surface px-3 py-2 font-normal text-ink focus:border-action focus:outline-none';
const EMPTY_FILTERS: ScheduleFilters = { instructor: '', levelIds: [], activityTypeIds: [] };
const defaultScheduleDay = (value: AdminEventSchedule, eventStart?: string) => firstDayWithSessions(value.days, value.sessions, value.timezone, value.day_start_hour)
    ?? value.days[0]
    ?? (eventStart ? programDayOf(eventStart, value.timezone, value.day_start_hour) : '');

export default function AdminEventSchedulePage() {
    const { eventId } = useParams<{ eventId: string }>();
    const navigate = useNavigate();
    const [event, setEvent] = useState<CalendarEvent | null>(null);
    const [schedule, setSchedule] = useState<AdminEventSchedule | null>(null);
    const [section, setSection] = useState<Section>('schedule');
    const [selectedDay, setSelectedDay] = useState('');
    const [sessionsDay, setSessionsDay] = useState('');
    const [editingSession, setEditingSession] = useState<ScheduleSession | 'new' | null>(null);
    const [editingConfig, setEditingConfig] = useState<{ kind: ConfigKind; item?: ConfigEntity } | null>(null);
    const [showPublish, setShowPublish] = useState(false);
    const [showPreview, setShowPreview] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [filters, setFilters] = useState<ScheduleFilters>(EMPTY_FILTERS);
    const [positionRequest, setPositionRequest] = useState(0);

    const reload = async () => {
        if (!eventId) return;
        const next = await fetchAdminEventSchedule(eventId);
        setSchedule(next);
        setSelectedDay((current) => next.days.includes(current) ? current : defaultScheduleDay(next, event?.start));
    };

    useEffect(() => {
        if (!eventId) return;
        Promise.all([fetchEvent(eventId, { fresh: true }), fetchOptionalAdminEventSchedule(eventId)])
            .then(([eventValue, scheduleValue]) => {
                setEvent(eventValue);
                setSchedule(scheduleValue);
                if (scheduleValue) setSelectedDay(defaultScheduleDay(scheduleValue, eventValue.start));
            })
            .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Schedule unavailable'))
            .finally(() => setLoading(false));
    }, [eventId]);

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

    const changeCount = schedule.diff.added_session_ids.length + schedule.diff.removed_session_ids.length + Object.keys(schedule.diff.changed_sessions).length + (schedule.diff.configuration_changed ? 1 : 0);
    const filteredSessions = filterScheduleSessions(schedule.sessions, filters);
    const filteredSchedule = { ...schedule, sessions: filteredSessions };
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
            <header className="shrink-0 border-b border-line bg-surface px-4 py-3">
                <div className="flex items-center gap-3">
                    <button type="button" onClick={() => navigate('/admin')} aria-label="Back to admin" className="flex h-11 w-11 items-center justify-center text-ink-soft"><ChevronLeft /></button>
                    <div className="min-w-0 flex-1">
                        <p className="text-xs font-semibold uppercase text-ink-soft">Event schedule</p>
                        <h1 className="truncate text-lg font-bold text-ink">{event.title}</h1>
                    </div>
                    <button type="button" onClick={() => setShowPreview(true)} className="hidden items-center gap-2 rounded-field border border-line bg-surface px-3 py-2 text-sm font-semibold text-ink sm:flex"><Eye size={17} />Preview</button>
                    <button type="button" onClick={() => setShowPublish(true)} className="flex items-center gap-2 rounded-field bg-action px-3 py-2 text-sm font-semibold text-white"><Send size={17} />Publish{changeCount ? ` (${changeCount})` : ''}</button>
                </div>
            </header>
            <div className="flex min-h-0 flex-1 flex-col md:flex-row">
                <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-line bg-surface p-2 md:w-48 md:flex-col md:border-b-0 md:border-r md:p-3">
                    {(['schedule', 'sessions', 'locations', 'taxonomy', 'settings'] as Section[]).map((item) => (
                        <button key={item} type="button" onClick={() => setSection(item)} className={`shrink-0 rounded-field px-3 py-2 text-left text-sm font-semibold capitalize ${section === item ? 'bg-action/10 text-action' : 'text-ink-soft hover:bg-canvas'}`}>{item}</button>
                    ))}
                </nav>
                <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
                    {error ? <div className="border-b border-line bg-rose-50 px-4 py-2 text-sm text-danger">{error}</div> : null}
                    {section === 'schedule' || section === 'sessions' ? (
                        <div className="shrink-0 border-b border-line bg-surface px-3">
                            <ProgramFilters schedule={schedule} filters={filters} onChange={updateFilters} />
                            <ProgramDayPicker schedule={schedule} sessions={filteredSessions} selectedDay={section === 'sessions' ? sessionsDay : selectedDay} includeAll={section === 'sessions'} filtersActive={Boolean(filters.instructor || filters.levelIds.length || filters.activityTypeIds.length)} onSelect={section === 'sessions' ? setSessionsDay : selectDay} endSlot={section === 'schedule' ? <button type="button" onClick={() => setEditingSession('new')} className="ml-auto flex shrink-0 items-center gap-2 rounded-field bg-action px-3 py-2 text-xs font-semibold text-white"><Plus size={15} />Add session</button> : undefined} />
                        </div>
                    ) : null}
                    {section === 'schedule' ? (
                        <>
                            <ScheduleGrid schedule={filteredSchedule} day={selectedDay} onSessionClick={setEditingSession} onTimeClick={() => setEditingSession('new')} positionRequest={positionRequest} />
                        </>
                    ) : null}
                    {section === 'sessions' ? <SessionsTable schedule={filteredSchedule} day={sessionsDay} onEdit={setEditingSession} /> : null}
                    {section === 'locations' ? <ConfigLists schedule={schedule} kinds={['venue', 'room']} onEdit={(kind, item) => setEditingConfig({ kind, item })} /> : null}
                    {section === 'taxonomy' ? <ConfigLists schedule={schedule} kinds={['level', 'activity']} onEdit={(kind, item) => setEditingConfig({ kind, item })} /> : null}
                    {section === 'settings' ? <SettingsPanel schedule={schedule} eventId={event.event_id} onSaved={setSchedule} /> : null}
                </main>
            </div>

            {editingSession ? <SessionEditor schedule={schedule} day={selectedDay} session={editingSession === 'new' ? null : editingSession} eventId={event.event_id} onClose={() => setEditingSession(null)} onSaved={async () => { setEditingSession(null); await reload(); }} onError={setError} /> : null}
            {editingConfig ? <ConfigEditor schedule={schedule} eventId={event.event_id} kind={editingConfig.kind} item={editingConfig.item} onClose={() => setEditingConfig(null)} onSaved={async () => { setEditingConfig(null); await reload(); }} onError={setError} /> : null}
            {(section === 'locations' || section === 'taxonomy') ? <button type="button" onClick={() => setEditingConfig({ kind: section === 'locations' ? 'venue' : 'level' })} className="fixed bottom-6 right-6 z-40 flex h-12 items-center gap-2 rounded-field bg-action px-4 text-sm font-semibold text-white shadow-lg"><Plus size={18} />Add</button> : null}
            {showPublish ? <PublishDialog schedule={schedule} eventId={event.event_id} onClose={() => setShowPublish(false)} onPublished={reload} onError={setError} /> : null}
            {showPreview ? <PreviewDialog eventId={event.event_id} onClose={() => setShowPreview(false)} /> : null}
        </div>
    );
}

function SessionsTable({ schedule, day, onEdit }: { schedule: AdminEventSchedule; day: string; onEdit: (session: ScheduleSession) => void }) {
    const sessions = (day ? sessionsForDay(schedule.sessions, day, schedule.timezone, schedule.day_start_hour) : [...schedule.sessions])
        .sort((left, right) => left.start.localeCompare(right.start));
    return (
        <div className="overflow-auto p-4">
            <div className="mx-auto max-w-5xl overflow-hidden rounded-card border border-card-line bg-surface">
                <table className="w-full min-w-[720px] text-left text-sm">
                    <thead className="bg-canvas text-xs uppercase text-ink-soft"><tr><th className="p-3">Date</th><th className="p-3">Time</th><th className="p-3">Room</th><th className="p-3">Title</th><th className="p-3">Instructor</th><th className="p-3">Type</th></tr></thead>
                    <tbody>{sessions.map((session) => (
                        <tr key={session.id} onClick={() => onEdit(session)} className="cursor-pointer border-t border-card-line hover:bg-canvas">
                            <td className="p-3 text-ink-soft">{formatDayDateLabel(programDayOf(session.start, schedule.timezone, schedule.day_start_hour))}</td>
                            <td className="p-3 font-medium text-ink">{formatTimeRange(session, schedule.timezone)}</td>
                            <td className="p-3 text-ink-soft">{schedule.rooms.find((room) => room.id === session.room_id)?.name ?? 'Event-wide'}</td>
                            <td className="p-3 font-semibold text-ink">{session.title}</td>
                            <td className="p-3 text-ink-soft">{session.instructors ?? '—'}</td>
                            <td className="p-3 text-ink-soft">{schedule.activity_types.find((type) => type.id === session.activity_type_id)?.name ?? '—'}</td>
                        </tr>
                    ))}{!sessions.length ? <tr><td colSpan={6} className="p-8 text-center text-sm text-ink-soft">No sessions match this date and filter.</td></tr> : null}</tbody>
                </table>
            </div>
        </div>
    );
}

function ConfigLists({ schedule, kinds, onEdit }: { schedule: AdminEventSchedule; kinds: ConfigKind[]; onEdit: (kind: ConfigKind, item?: ConfigEntity) => void }) {
    const rows = (kind: ConfigKind): ConfigEntity[] => kind === 'venue' ? schedule.venues : kind === 'room' ? schedule.rooms : kind === 'level' ? schedule.levels : schedule.activity_types;
    return <div className="overflow-y-auto p-4"><div className="mx-auto max-w-3xl space-y-6">{kinds.map((kind) => (
        <section key={kind}>
            <div className="mb-3 flex items-center justify-between"><h2 className="text-lg font-bold capitalize text-ink">{kind === 'activity' ? 'Activity types' : `${kind}s`}</h2><button type="button" onClick={() => onEdit(kind)} className="flex items-center gap-1 text-sm font-semibold text-action"><Plus size={16} />Add</button></div>
            <div className="overflow-hidden rounded-card border border-card-line bg-surface">{rows(kind).map((item) => (
                <button key={item.id} type="button" onClick={() => onEdit(kind, item)} className="flex w-full items-center gap-3 border-b border-card-line px-4 py-3 text-left last:border-b-0 hover:bg-canvas">
                    {'color' in item ? <span className={`h-4 w-4 shrink-0 ${roomColor(item.color).header}`} /> : null}
                    <span className="flex-1 font-medium text-ink">{'name' in item ? item.name : item.label}</span>
                    {'notation' in item && item.notation ? <span className="text-sm text-ink-soft">{item.notation}</span> : null}
                </button>
            ))}{!rows(kind).length ? <p className="p-4 text-sm text-ink-soft">No items yet.</p> : null}</div>
        </section>
    ))}</div></div>;
}

function SettingsPanel({ schedule, eventId, onSaved }: { schedule: AdminEventSchedule; eventId: string; onSaved: (value: AdminEventSchedule) => void }) {
    const [timezone, setTimezone] = useState(schedule.timezone);
    const [cutoff, setCutoff] = useState(schedule.day_start_hour);
    const [busy, setBusy] = useState(false);
    const timezoneOptions = supportedTimezones(schedule.timezone);
    return <div className="mx-auto w-full max-w-2xl space-y-8 overflow-y-auto p-6">
        <form className="space-y-5" onSubmit={async (event) => { event.preventDefault(); setBusy(true); try { onSaved(await updateAdminEventSchedule(eventId, { timezone, day_start_hour: cutoff })); } finally { setBusy(false); } }}>
            <h2 className="text-lg font-bold text-ink">Schedule settings</h2>
            <TimezoneCombobox value={timezone} options={timezoneOptions} onChange={setTimezone} />
            <label className="block text-sm font-semibold text-ink">Program day changes at<select value={cutoff} onChange={(event) => setCutoff(Number(event.target.value))} className="mt-2 w-full rounded-field border border-line bg-surface px-3 py-2 font-normal">{Array.from({ length: 12 }, (_, hour) => <option key={hour} value={hour}>{String(hour).padStart(2, '0')}:00</option>)}</select></label>
            <button disabled={busy} className="rounded-field bg-action px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy ? 'Saving…' : 'Save settings'}</button>
        </form>
        <PlannerRoster eventId={eventId} schedule={schedule} />
        <ScheduleImportPanel eventId={eventId} onApplied={async () => onSaved(await fetchAdminEventSchedule(eventId))} />
    </div>;
}

function TimezoneCombobox({ value, options, onChange }: { value: string; options: string[]; onChange: (value: string) => void }) {
    const inputId = useId();
    const listId = useId();
    const [open, setOpen] = useState(false);
    const [filtering, setFiltering] = useState(false);
    const [activeIndex, setActiveIndex] = useState(0);
    const query = value.trim().toLocaleLowerCase();
    const matches = filtering ? options.filter((option) => !query || option.toLocaleLowerCase().includes(query)) : options;
    const select = (option: string) => { onChange(option); setFiltering(false); setOpen(false); };
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
    return <section className="flex items-center gap-4 border-t border-line pt-6">
        <Users size={20} className="shrink-0 text-ink-soft" />
        <div className="min-w-0 flex-1"><h2 className="text-base font-bold text-ink">People with plans</h2><p className="mt-1 text-sm text-ink-soft">Review attendees who added sessions from this program.</p></div>
        <button type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" className="shrink-0 rounded-field border border-line bg-surface px-3 py-2 text-sm font-semibold text-ink hover:border-action hover:text-action">View people</button>
        {open ? <PlannerRosterDialog eventId={eventId} schedule={schedule} onClose={() => setOpen(false)} /> : null}
    </section>;
}

function PlannerRosterDialog({ eventId, schedule, onClose }: { eventId: string; schedule: AdminEventSchedule; onClose: () => void }) {
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
                <ul className="mt-3 space-y-2 pl-4">{planner.sessions.map((session) => <li key={session.session_id} className="text-sm text-ink"><span className={session.status !== 'active' ? 'line-through text-ink-soft' : ''}>{session.title}</span><span className="ml-2 text-xs text-ink-soft">{formatDayDateLabel(programDayOf(session.start, schedule.timezone, schedule.day_start_hour))} · {formatTimeRange(session, schedule.timezone)}</span></li>)}</ul>
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
        setBusy(true); setError(null); setPreview(null);
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
        try { await applyScheduleImport(eventId, mode, document); await onApplied(); setPreview(null); }
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
        <fieldset className="mt-4"><legend className="text-sm font-semibold text-ink">Import mode</legend><div className="mt-2 flex gap-4"><label className="flex items-center gap-2 text-sm text-ink"><input type="radio" name="import-mode" checked={mode === 'merge'} onChange={() => { setMode('merge'); setPreview(null); }} />Merge</label><label className="flex items-center gap-2 text-sm text-ink"><input type="radio" name="import-mode" checked={mode === 'replace'} onChange={() => { setMode('replace'); setPreview(null); }} />Replace missing sessions</label></div></fieldset>
        {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
        {preview ? <div className="mt-4 bg-canvas p-4"><h3 className="font-bold text-ink">Preview</h3><div className="mt-3 grid grid-cols-4 gap-2"><DiffCount value={preview.operations.created} label="Create" /><DiffCount value={preview.operations.updated} label="Update" /><DiffCount value={preview.operations.removed} label="Remove" /><DiffCount value={preview.operations.unchanged} label="Unchanged" /></div>{preview.issues.length ? <ul className="mt-3 space-y-2">{preview.issues.map((issue, index) => <li key={`${issue.code}-${index}`} className="text-sm text-amber-900">{issue.message}</li>)}</ul> : <p className="mt-3 text-sm text-success">No schedule warnings.</p>}</div> : null}
        <div className="mt-4 flex gap-2"><button type="button" disabled={busy || loadingDocument || !text.trim()} onClick={runPreview} className="rounded-field border border-action px-4 py-2 text-sm font-semibold text-action disabled:opacity-50">{busy ? 'Checking…' : 'Preview import'}</button><button type="button" disabled={busy || !preview} onClick={apply} className="rounded-field bg-action px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Apply to draft</button></div>
    </section>;
}

function SessionEditor({ schedule, day, session, eventId, onClose, onSaved, onError }: { schedule: AdminEventSchedule; day: string; session: ScheduleSession | null; eventId: string; onClose: () => void; onSaved: () => void; onError: (message: string | null) => void }) {
    const initialStart = session ? toZonedInput(session.start, schedule.timezone) : `${day}T10:00`;
    const initialEnd = session ? toZonedInput(session.end, schedule.timezone) : `${day}T11:00`;
    const [form, setForm] = useState({ title: session?.title ?? '', instructors: session?.instructors ?? '', start: initialStart, end: initialEnd, room_id: session?.room_id?.toString() ?? '', venue_id: session?.venue_id?.toString() ?? '', level_id: session?.level_id?.toString() ?? '', activity_type_id: session?.activity_type_id?.toString() ?? '', attendee_note: session?.attendee_note ?? '', allow_plan: session?.allow_plan ?? true, is_cancelled: session?.is_cancelled ?? false });
    const [busy, setBusy] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const startIso = form.start ? zonedInputToIso(form.start, schedule.timezone) : '';
    const endIso = form.end ? zonedInputToIso(form.end, schedule.timezone) : '';
    const draftSession = { ...session, id: session?.id ?? 'draft', start: startIso, end: endIso } as ScheduleSession;
    const conflicts = schedule.sessions.filter((row) => row.id !== session?.id && form.room_id && row.room_id === Number(form.room_id) && sessionsOverlap(draftSession, row));
    const submit = async (event: React.FormEvent) => {
        event.preventDefault(); setBusy(true); onError(null);
        const body: ScheduleSessionInput = { title: form.title, instructors: form.instructors || null, start: startIso, end: endIso, room_id: form.room_id ? Number(form.room_id) : null, venue_id: form.venue_id ? Number(form.venue_id) : null, level_id: form.level_id ? Number(form.level_id) : null, activity_type_id: form.activity_type_id ? Number(form.activity_type_id) : null, attendee_note: form.attendee_note || null, allow_plan: form.allow_plan, is_cancelled: form.is_cancelled };
        try { if (session) await updateScheduleSession(eventId, session.id, body); else await createScheduleSession(eventId, body); await onSaved(); } catch (reason) { onError(reason instanceof Error ? reason.message : 'Could not save session'); } finally { setBusy(false); }
    };
    return <Modal title={session ? 'Edit session' : 'Add session'} onClose={onClose}><form onSubmit={submit} className="space-y-4">
        <Field label="Title"><input required value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} className={FIELD_CLASS} /></Field>
        <Field label="Instructor(s)"><input value={form.instructors} onChange={(event) => setForm({ ...form, instructors: event.target.value })} className={FIELD_CLASS} /></Field>
        <div className="grid grid-cols-2 gap-3"><Field label="Start"><input required type="datetime-local" value={form.start} onChange={(event) => setForm({ ...form, start: event.target.value })} className={FIELD_CLASS} /></Field><Field label="End"><input required type="datetime-local" value={form.end} onChange={(event) => setForm({ ...form, end: event.target.value })} className={FIELD_CLASS} /></Field></div>
        <div className="grid grid-cols-2 gap-3"><Field label="Room"><select value={form.room_id} onChange={(event) => { const room = schedule.rooms.find((item) => item.id === Number(event.target.value)); setForm({ ...form, room_id: event.target.value, venue_id: room?.venue_id?.toString() ?? form.venue_id }); }} className={FIELD_CLASS}><option value="">Event-wide</option>{schedule.rooms.map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}</select></Field><Field label="Venue"><select value={form.venue_id} onChange={(event) => setForm({ ...form, venue_id: event.target.value })} className={FIELD_CLASS}><option value="">No venue</option>{schedule.venues.map((venue) => <option key={venue.id} value={venue.id}>{venue.name}</option>)}</select></Field></div>
        <div className="grid grid-cols-2 gap-3"><Field label="Level"><select value={form.level_id} onChange={(event) => setForm({ ...form, level_id: event.target.value })} className={FIELD_CLASS}><option value="">No level</option>{schedule.levels.map((level) => <option key={level.id} value={level.id}>{level.label}</option>)}</select></Field><Field label="Activity type"><select value={form.activity_type_id} onChange={(event) => setForm({ ...form, activity_type_id: event.target.value })} className={FIELD_CLASS}><option value="">No type</option>{schedule.activity_types.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select></Field></div>
        <Field label="Attendee note"><textarea maxLength={500} value={form.attendee_note} onChange={(event) => setForm({ ...form, attendee_note: event.target.value })} className={`${FIELD_CLASS} min-h-20`} /></Field>
        <label className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" checked={form.allow_plan} onChange={(event) => setForm({ ...form, allow_plan: event.target.checked })} />Attendees may add this to My Plan</label>
        {session ? <label className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" checked={form.is_cancelled} onChange={(event) => setForm({ ...form, is_cancelled: event.target.checked })} />Mark session cancelled</label> : null}
        {conflicts.length ? <div className="border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><strong>Scheduling conflict.</strong> This overlaps {conflicts.map((item) => item.title).join(', ')} in the same room. You may still save intentionally.</div> : null}
        <div className="flex flex-wrap justify-between gap-2 border-t border-line pt-4">{session ? <div className="flex gap-2"><button type="button" onClick={async () => { await duplicateScheduleSession(eventId, session.id); await onSaved(); }} className="rounded-field border border-line px-3 py-2 text-sm">Duplicate</button><button type="button" onClick={async () => { if (!confirmDelete) { setConfirmDelete(true); return; } await deleteScheduleSession(eventId, session.id); await onSaved(); }} className="rounded-field px-3 py-2 text-sm font-semibold text-danger">{confirmDelete ? 'Confirm delete' : 'Delete'}</button></div> : <span />}<div className="flex gap-2"><button type="button" onClick={onClose} className="rounded-field border border-line px-3 py-2 text-sm">Cancel</button><button disabled={busy} className="rounded-field bg-action px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy ? 'Saving…' : conflicts.length ? 'Save anyway' : 'Save'}</button></div></div>
    </form></Modal>;
}

function ConfigEditor({ schedule, eventId, kind, item, onClose, onSaved, onError }: { schedule: AdminEventSchedule; eventId: string; kind: ConfigKind; item?: ConfigEntity; onClose: () => void; onSaved: () => void; onError: (message: string | null) => void }) {
    const label = item && 'label' in item ? item.label : item && 'name' in item ? item.name : '';
    const [name, setName] = useState(label);
    const [secondary, setSecondary] = useState(item && 'address' in item ? item.address ?? '' : item && 'notation' in item ? item.notation ?? '' : '');
    const [color, setColor] = useState(item && 'color' in item ? item.color : 'blue');
    const [venueId, setVenueId] = useState(item && 'venue_id' in item ? item.venue_id?.toString() ?? '' : '');
    const [confirmDelete, setConfirmDelete] = useState(false);
    const save = async () => {
        try {
            if (kind === 'venue') { const body = { name, address: secondary || null, sort_order: item?.sort_order ?? schedule.venues.length }; if (item) await updateScheduleVenue(eventId, item.id, body); else await createScheduleVenue(eventId, body); }
            if (kind === 'room') { const body = { name, venue_id: venueId ? Number(venueId) : null, color, sort_order: item?.sort_order ?? schedule.rooms.length }; if (item) await updateScheduleRoom(eventId, item.id, body); else await createScheduleRoom(eventId, body); }
            if (kind === 'level') { const body = { label: name, notation: secondary || null, sort_order: item?.sort_order ?? schedule.levels.length }; if (item) await updateScheduleLevel(eventId, item.id, body); else await createScheduleLevel(eventId, body); }
            if (kind === 'activity') { const body = { name, color, sort_order: item?.sort_order ?? schedule.activity_types.length }; if (item) await updateScheduleActivityType(eventId, item.id, body); else await createScheduleActivityType(eventId, body); }
            await onSaved();
        } catch (reason) { onError(reason instanceof Error ? reason.message : 'Could not save item'); }
    };
    const remove = async () => { if (!item) return; try { if (kind === 'venue') await deleteScheduleVenue(eventId, item.id); if (kind === 'room') await deleteScheduleRoom(eventId, item.id); if (kind === 'level') await deleteScheduleLevel(eventId, item.id); if (kind === 'activity') await deleteScheduleActivityType(eventId, item.id); await onSaved(); } catch (reason) { onError(reason instanceof Error ? reason.message : 'Could not delete item'); } };
    return <Modal title={`${item ? 'Edit' : 'Add'} ${kind === 'activity' ? 'activity type' : kind}`} onClose={onClose}><div className="space-y-4"><Field label={kind === 'level' ? 'Label' : 'Name'}><input value={name} onChange={(event) => setName(event.target.value)} className={FIELD_CLASS} /></Field>{kind === 'venue' ? <Field label="Address"><input value={secondary} onChange={(event) => setSecondary(event.target.value)} className={FIELD_CLASS} /></Field> : null}{kind === 'level' ? <Field label="Notation"><input value={secondary} onChange={(event) => setSecondary(event.target.value)} className={FIELD_CLASS} placeholder="*, **, ***" /></Field> : null}{kind === 'room' ? <Field label="Venue"><select value={venueId} onChange={(event) => setVenueId(event.target.value)} className={FIELD_CLASS}><option value="">No venue</option>{schedule.venues.map((venue) => <option key={venue.id} value={venue.id}>{venue.name}</option>)}</select></Field> : null}{kind === 'room' || kind === 'activity' ? <Field label="Color"><div className="flex flex-wrap gap-2">{Object.keys(ROOM_COLORS).map((value) => <button key={value} type="button" aria-label={value} onClick={() => setColor(value)} className={`h-9 w-9 border-2 ${roomColor(value).header} ${color === value ? 'border-action' : 'border-transparent'}`} />)}</div></Field> : null}<div className="flex justify-between border-t border-line pt-4">{item ? <button type="button" onClick={async () => { if (!confirmDelete) { setConfirmDelete(true); return; } await remove(); }} className="flex items-center gap-2 px-3 py-2 text-sm font-semibold text-danger"><Trash2 size={16} />{confirmDelete ? 'Confirm delete' : 'Delete'}</button> : <span />}<div className="flex gap-2"><button type="button" onClick={onClose} className="rounded-field border border-line px-3 py-2 text-sm">Cancel</button><button type="button" onClick={save} disabled={!name.trim()} className="rounded-field bg-action px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Save</button></div></div></div></Modal>;
}

function PublishDialog({ schedule, eventId, onClose, onPublished, onError }: { schedule: AdminEventSchedule; eventId: string; onClose: () => void; onPublished: () => Promise<void>; onError: (message: string | null) => void }) {
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<SchedulePublishResponse | null>(null);
    const [notifyAllGoing, setNotifyAllGoing] = useState(false);
    const firstPublish = schedule.version == null;
    if (result) {
        const summary = result.notification_summary;
        return <Modal title="Schedule published" onClose={onClose}><div className="space-y-4">
            <p className="text-sm text-success">Version {result.version} is live.</p>
            <div className="bg-canvas p-4 text-sm text-ink"><p className="font-semibold">{result.version === 1 ? `${summary.going_attendees_notified} Going attendees announced` : `${summary.impacted_planners} impacted ${summary.impacted_planners === 1 ? 'planner' : 'planners'} notified`}</p>{result.version !== 1 && summary.going_attendees_notified ? <p className="mt-1 text-xs text-ink-soft">{summary.going_attendees_notified} additional Going {summary.going_attendees_notified === 1 ? 'attendee' : 'attendees'} notified</p> : null}<p className="mt-1 text-xs text-ink-soft">{summary.in_app_created} in-app · {summary.emailed} email · {summary.pushed} push</p></div>
            <div className="flex justify-end border-t border-line pt-4"><button type="button" onClick={onClose} className="rounded-field border border-line px-3 py-2 text-sm">Done</button></div>
        </div></Modal>;
    }
    return <Modal title="Publish schedule" onClose={onClose}><div className="space-y-4"><p className="text-sm text-ink-soft">{firstPublish ? 'Publishing makes this program visible and announces it to signed-in Going attendees.' : 'Publishing replaces the attendee program with this reviewed draft. People whose My Plan is affected will be notified automatically.'}</p><div className="grid grid-cols-3 gap-2 text-center"><DiffCount value={schedule.diff.added_session_ids.length} label="Added" /><DiffCount value={schedule.diff.removed_session_ids.length} label="Removed" /><DiffCount value={Object.keys(schedule.diff.changed_sessions).length} label="Changed" /></div>{schedule.issues.length ? <div><h3 className="text-sm font-bold text-ink">Warnings</h3><ul className="mt-2 space-y-2">{schedule.issues.map((issue, index) => <li key={`${issue.code}-${index}`} className="border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{issue.message}</li>)}</ul></div> : <p className="text-sm font-medium text-success">No schedule warnings.</p>}{!firstPublish ? <label className="flex items-start gap-3 bg-canvas p-3 text-sm text-ink"><input type="checkbox" checked={notifyAllGoing} onChange={(event) => setNotifyAllGoing(event.target.checked)} className="mt-0.5" /><span><span className="block font-semibold">Also notify all Going attendees</span><span className="mt-1 block text-xs text-ink-soft">Send a general Program updated message in addition to specific My Plan changes.</span></span></label> : null}<div className="flex justify-end gap-2 border-t border-line pt-4"><button type="button" onClick={onClose} className="rounded-field border border-line px-3 py-2 text-sm">Cancel</button><button type="button" disabled={busy} onClick={async () => { setBusy(true); try { const value = await publishEventSchedule(eventId, notifyAllGoing); await onPublished(); setResult(value); } catch (reason) { onError(reason instanceof Error ? reason.message : 'Publish failed'); } finally { setBusy(false); } }} className="rounded-field bg-action px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy ? 'Publishing…' : 'Publish'}</button></div></div></Modal>;
}

function PreviewDialog({ eventId, onClose }: { eventId: string; onClose: () => void }) { const url = `/event/${eventId}/program?preview=draft&embed=program`; return <Modal title="Preview as attendee" onClose={onClose} wide><div className="flex flex-col items-center gap-3"><iframe title="Draft attendee preview" src={url} className="h-[68vh] w-[390px] max-w-full border border-line bg-surface" /><a href={`/event/${eventId}/program?preview=draft`} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-sm font-semibold text-action">Open in new tab <ExternalLink size={15} /></a></div></Modal>; }

function supportedTimezones(current: string): string[] {
    const values = (Intl as typeof Intl & { supportedValuesOf?: (key: 'timeZone') => string[] }).supportedValuesOf?.('timeZone') ?? [];
    return [...new Set(['UTC', current, ...values])].sort((left, right) => left.localeCompare(right));
}

function Modal({ title, onClose, wide = false, sheetOnMobile = false, children }: { title: string; onClose: () => void; wide?: boolean; sheetOnMobile?: boolean; children: React.ReactNode }) { return <div className={`fixed inset-0 z-[11000] flex bg-black/50 ${sheetOnMobile ? 'items-end justify-center p-0 sm:items-center sm:p-4' : 'items-center justify-center p-4'}`} onClick={onClose}><div role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()} className={`${sheetOnMobile ? 'max-h-[85dvh] rounded-t-card sm:max-h-[92vh] sm:rounded-card' : 'max-h-[92vh] rounded-card'} overflow-y-auto bg-surface p-5 shadow-2xl ${wide ? 'w-auto max-w-4xl' : 'w-full max-w-xl'}`}><div className="mb-5 flex items-center justify-between"><h2 className="text-lg font-bold text-ink">{title}</h2><button type="button" onClick={onClose} className="h-11 w-11 text-ink-soft" aria-label="Close">×</button></div>{children}</div></div>; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block text-sm font-semibold text-ink">{label}<div className="mt-1">{children}</div></label>; }
function DiffCount({ value, label }: { value: number; label: string }) { return <div className="bg-canvas p-3"><p className="text-xl font-bold text-ink">{value}</p><p className="text-xs text-ink-soft">{label}</p></div>; }
function AdminState({ text }: { text: string }) { return <div className="flex min-h-full items-center justify-center bg-canvas p-6 text-sm text-ink-soft">{text}</div>; }
