import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Repeat, SlidersHorizontal } from 'lucide-react';
import { createColumnHelper } from '@tanstack/react-table';
import useBackToClose from '../hooks/useBackToClose';
import useMediaQuery from '../hooks/useMediaQuery';
import BottomSheet from './BottomSheet';
import AdminLoadMore from './AdminLoadMore';
import type { CalendarSetting, ChangeScope, EventRevisionKind, EventRevisionSource } from '../types';
import type { AdminChange, ChangeDecision, FilterOption } from '../api';
import { decideAdminChange, fetchAdminCalendars, fetchAdminChanges } from '../api';
import { notifyAdminDataChanged } from '../hooks/useAdminCounters';
import { CHANGE_KIND_META, describeRevisionValue, revisionFieldLabel } from '../utils/eventRevisions';
import { formatCompactDateRange } from '../utils/eventDates';
import { ADMIN_EVENT_STATUS_CHIP_CLASSES, ADMIN_EVENT_STATUS_LABELS } from '../utils/adminEventStatus';
import AdminEventDetailPanel from './AdminEventDetailPanel';
import { NotifyToggle, ScopeChoice } from './AdminEventModerationSection';
import AdminDataTable from './admin-events/AdminDataTable';
import AdminEventsColumnsMenu from './admin-events/AdminEventsColumnsMenu';
import { adminTableFeatures } from './admin-events/adminEventColumns';
import { useAdminTablePrefs } from './admin-events/useAdminEventsTablePrefs';

interface Props {
    isOpen: boolean;
    onClose: () => void;
}

const PAGE_SIZE = 25;

const KIND_META: Record<EventRevisionKind, { label: string; cls: string; accept: string; reject: string }> = {
    create: { label: 'New event', cls: CHANGE_KIND_META.create.pill, accept: 'Publish', reject: 'Reject' },
    go_public: { label: 'Go public', cls: CHANGE_KIND_META.go_public.pill, accept: 'Make public', reject: 'Keep private' },
    edit: { label: 'Edit', cls: CHANGE_KIND_META.edit.pill, accept: 'Apply', reject: 'Discard' },
    cancel: { label: 'Cancellation', cls: CHANGE_KIND_META.cancel.pill, accept: 'Mark cancelled', reject: 'Keep' },
    remove: { label: 'Removal', cls: CHANGE_KIND_META.remove.pill, accept: 'Remove', reject: 'Keep' },
};

const SOURCE_LABELS: Record<EventRevisionSource, string> = {
    sync: 'Google Calendar',
    submitter: 'Submitter',
    user: 'User',
    organizer: 'Organizer',
    admin: 'Admin',
};

const STATUS_LABELS: Record<string, string> = {
    accepted: 'Accepted',
    rejected: 'Rejected',
    withdrawn: 'Withdrawn',
    superseded: 'Replaced',
    reverted: 'Reverted',
    closed: 'Closed',
};

function toggled<T>(list: T[], value: T): T[] {
    return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

function proposer(change: AdminChange): string {
    if (change.proposed_by) return change.proposed_by.handle ? `@${change.proposed_by.handle}` : change.proposed_by.display_name ?? 'User';
    if (change.submitter_name) return change.submitter_name;
    if (change.proposed_by_admin_email) return change.proposed_by_admin_email;
    return SOURCE_LABELS[change.source];
}

function age(iso: string): string {
    const hours = Math.max(0, (Date.now() - new Date(iso).getTime()) / 36e5);
    if (hours < 1) return 'now';
    if (hours < 24) return `${Math.floor(hours)}h`;
    return `${Math.floor(hours / 24)}d`;
}

function summary(change: AdminChange): string {
    if (change.kind === 'create') return 'First review';
    if (change.kind === 'go_public') return 'Private → public';
    const fields = Object.keys(change.changes).map(revisionFieldLabel).join(', ');
    return change.group_size > 1 ? `${fields} · on ${change.group_size} dates` : fields;
}

function Pills({ label, options, selected, onToggle, kinds = false }: {
    label: string;
    options: FilterOption[];
    selected: string[];
    onToggle: (value: string) => void;
    /** Options are change kinds: show each kind's icon and colour. */
    kinds?: boolean;
}) {
    return (
        <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1">
            <span className="text-[10px] uppercase tracking-wide text-muted">{label}</span>
            {options.map((option) => {
                const active = selected.includes(option.value);
                const meta = kinds ? CHANGE_KIND_META[option.value as EventRevisionKind] : undefined;
                const Icon = meta?.icon;
                return (
                    <button
                        key={option.value}
                        type="button"
                        aria-pressed={active}
                        onClick={() => onToggle(option.value)}
                        className={`inline-flex items-center gap-1 border px-2 py-0.5 text-[10px] font-medium transition ${active
                            ? 'border-action bg-action text-white'
                            : meta ? `border-transparent ${meta.pill} hover:brightness-95` : 'border-line bg-surface text-ink-soft hover:bg-canvas'}`}
                    >
                        {Icon && <Icon className="h-3 w-3" aria-hidden="true" />}
                        {option.label} ({option.count})
                    </button>
                );
            })}
        </div>
    );
}

const changeColumn = createColumnHelper<typeof adminTableFeatures, AdminChange>();

const CHANGE_COLUMNS = [
    changeColumn.display({
        id: 'kind',
        size: 110,
        meta: { label: 'Change' },
        cell: ({ row: { original: change } }) => (
            <span className={`inline-block whitespace-nowrap px-1.5 py-0.5 text-[10px] font-medium ${KIND_META[change.kind].cls}`}>{KIND_META[change.kind].label}</span>
        ),
    }),
    changeColumn.display({
        id: 'event',
        size: 300,
        minSize: 160,
        meta: { label: 'Event' },
        cell: ({ row: { original: change } }) => (
            <>
                <p className="flex min-w-0 items-center gap-1 font-medium text-ink">
                    {change.event && (change.event.occurrences > 1 || change.series_dates > 1) && (
                        <Repeat className="h-3 w-3 shrink-0 text-ink-soft" aria-label="Series" role="img" />
                    )}
                    <span className="truncate">{change.event?.title ?? '—'}</span>
                </p>
                <p className="truncate text-[10px] text-muted">{summary(change)}</p>
            </>
        ),
    }),
    changeColumn.display({
        id: 'date',
        size: 140,
        meta: { label: 'Date' },
        cell: ({ row: { original: change } }) => (
            <span className="whitespace-nowrap text-ink-soft">
                {change.event ? formatCompactDateRange(change.event) : '—'}
                {change.event && change.event.occurrences > 1 && <span className="ml-1 text-muted">×{change.event.occurrences}</span>}
            </span>
        ),
    }),
    changeColumn.display({
        id: 'initiator',
        size: 140,
        meta: { label: 'Initiator' },
        cell: ({ row: { original: change } }) => (
            <span className="block truncate text-ink-soft" title={proposer(change)}>{proposer(change)}</span>
        ),
    }),
    changeColumn.display({
        id: 'source',
        size: 110,
        meta: { label: 'Source' },
        cell: ({ row: { original: change } }) => <span className="block truncate text-ink-soft">{SOURCE_LABELS[change.source]}</span>,
    }),
    changeColumn.display({
        id: 'outcome',
        size: 90,
        meta: { label: 'Age / Outcome' },
        cell: ({ row: { original: change } }) => (
            <span className="whitespace-nowrap text-ink-soft">
                {change.status === 'pending' ? age(change.created_at) : STATUS_LABELS[change.status] ?? change.status}
            </span>
        ),
    }),
    changeColumn.display({
        id: 'proposed',
        size: 130,
        meta: { label: 'Proposed', defaultHidden: true },
        cell: ({ row: { original: change } }) => (
            <span className="whitespace-nowrap text-ink-soft">{new Date(change.created_at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}</span>
        ),
    }),
    changeColumn.display({
        id: 'decided',
        size: 160,
        meta: { label: 'Decided', defaultHidden: true },
        cell: ({ row: { original: change } }) => (
            <span className="block truncate text-ink-soft">
                {change.decided_at ? new Date(change.decided_at).toLocaleDateString() : '—'}
                {change.decided_by && ` · ${change.decided_by}`}
            </span>
        ),
    }),
];

const CHANGE_CONFIGURABLE = CHANGE_COLUMNS.map((c) => ({ id: c.id as string, label: c.meta?.label ?? '', defaultHidden: Boolean(c.meta?.defaultHidden) }));

function ChangeDetail({ change, onDecided, onOpenEvent, onClose }: {
    change: AdminChange;
    onDecided: () => void;
    onOpenEvent: (eventId: string) => void;
    onClose: () => void;
}) {
    const meta = KIND_META[change.kind];
    const open = change.status === 'pending';
    const [note, setNote] = useState('');
    const [notify, setNotify] = useState(change.material_fields.length > 0);
    const [scope, setScope] = useState<ChangeScope>('date');
    const [calendars, setCalendars] = useState<CalendarSetting[]>([]);
    const [calendarId, setCalendarId] = useState('');
    const [busy, setBusy] = useState<'accept' | 'reject' | null>(null);
    const [error, setError] = useState('');

    useEffect(() => {
        if (change.kind !== 'go_public' || !open) return;
        fetchAdminCalendars()
            .then((rows) => {
                const choices = rows.filter((c) => c.calendar_id !== 'user-submissions');
                setCalendars(choices);
                setCalendarId((prev) => prev || choices[0]?.calendar_id || '');
            })
            .catch(() => setCalendars([]));
    }, [change.kind, open]);

    const editKind = change.kind === 'edit' || change.kind === 'cancel' || change.kind === 'remove';
    const attendees = scope === 'series' ? change.series_affected_attendees : change.affected_attendees;

    const decide = async (decision: ChangeDecision['decision']) => {
        setBusy(decision);
        setError('');
        try {
            await decideAdminChange(change.id, {
                decision,
                note: note.trim() || undefined,
                notify: attendees > 0 ? notify : false,
                calendar_id: change.kind === 'go_public' ? calendarId || undefined : undefined,
                scope: editKind ? scope : undefined,
            });
            notifyAdminDataChanged();
            onDecided();
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : 'Could not decide the change');
        } finally {
            setBusy(null);
        }
    };

    return (
        <aside className="absolute inset-0 z-20 flex h-full w-full flex-col border-l border-line bg-surface pt-[env(safe-area-inset-top)] sm:static sm:z-auto sm:w-[420px] sm:max-w-full sm:shrink-0 sm:pt-0" aria-label="Change detail">
            <div className="flex items-start justify-between gap-2 border-b border-line px-4 py-3">
                <div className="min-w-0">
                    <span className={`inline-block px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${meta.cls}`}>{meta.label}</span>
                    <p className="mt-1 truncate text-sm font-semibold text-ink">{change.event?.title ?? 'Event'}</p>
                    <p className="text-[11px] text-muted">{SOURCE_LABELS[change.source]} · {proposer(change)} · {age(change.created_at)} ago</p>
                </div>
                <button type="button" onClick={onClose} aria-label="Close change" className="-ml-3 order-first inline-flex h-11 w-11 shrink-0 items-center justify-center text-sm text-ink sm:order-none sm:ml-0 sm:h-auto sm:w-auto sm:p-1 sm:text-muted sm:hover:text-ink-soft">
                    <ArrowLeft className="h-5 w-5 sm:hidden" aria-hidden="true" />
                    <span className="hidden sm:inline">✕</span>
                </button>
            </div>
            <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3 text-sm sm:text-xs">
                {change.event && (
                    <div className="space-y-1">
                        <p className="text-ink-soft">
                            {formatCompactDateRange(change.event)}
                            {change.event.occurrences > 1 && ` · ${change.event.occurrences} dates`}
                            {change.event.location && ` · ${change.event.location}`}
                        </p>
                        <div className="flex flex-wrap items-center gap-1">
                            <span className={`px-1.5 py-0.5 text-[10px] font-medium ${ADMIN_EVENT_STATUS_CHIP_CLASSES[change.event.status]}`}>
                                {ADMIN_EVENT_STATUS_LABELS[change.event.status]}
                            </span>
                            <button
                                type="button"
                                onClick={() => change.event && onOpenEvent(change.event.event_id)}
                                className="text-[11px] font-medium text-action hover:underline"
                            >
                                Open event
                            </button>
                        </div>
                    </div>
                )}
                {Object.keys(change.changes).length > 0 && (
                    <ul className="space-y-1">
                        {Object.entries(change.changes).map(([field, diff]) => (
                            <li key={field} className="text-ink">
                                <span className="font-medium">{revisionFieldLabel(field)}:</span>{' '}
                                <span className="text-ink-soft line-through">{describeRevisionValue(field, diff.old)}</span>{' '}
                                → <span>{describeRevisionValue(field, diff.new)}</span>
                            </li>
                        ))}
                    </ul>
                )}
                {change.kind === 'create' && (
                    <p className="text-ink-soft">Publishing lists it for everyone. Rejecting removes it and keeps it from coming back on the next sync.</p>
                )}
                {!open && (
                    <p className="text-ink-soft">
                        {STATUS_LABELS[change.status] ?? change.status}
                        {change.decided_by && ` by ${change.decided_by}`}
                        {change.decided_at && ` · ${new Date(change.decided_at).toLocaleString()}`}
                    </p>
                )}
                {open && change.kind === 'go_public' && (
                    <label className="block space-y-1">
                        <span className="text-[11px] font-medium uppercase tracking-wide text-ink-soft">Publish in</span>
                        <select
                            value={calendarId}
                            onChange={(e) => setCalendarId(e.target.value)}
                            className="w-full border border-line bg-surface px-2 py-1 text-xs"
                        >
                            {calendars.map((c) => <option key={c.calendar_id} value={c.calendar_id}>{c.name}</option>)}
                        </select>
                    </label>
                )}
                {open && editKind && (
                    <>
                        <ScopeChoice revision={change} value={scope} onChange={setScope} submissionDate={change.event?.is_submission} />
                        <NotifyToggle revision={change} count={attendees} checked={notify} onChange={setNotify} />
                    </>
                )}
                {open && (change.kind === 'create' || change.kind === 'go_public') && (
                    <label className="block space-y-1">
                        <span className="text-[11px] font-medium uppercase tracking-wide text-ink-soft">Note (shown if rejected)</span>
                        <textarea
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                            rows={2}
                            className="w-full border border-line px-2 py-1 text-xs"
                        />
                    </label>
                )}
                {error && <p role="alert" className="text-danger">{error}</p>}
            </div>
            {open && (
                <div className="flex gap-2 border-t border-line px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:pb-3">
                    <button
                        type="button"
                        onClick={() => decide('accept')}
                        disabled={busy !== null || (change.kind === 'go_public' && !calendarId)}
                        className="min-h-11 flex-1 bg-action px-3 py-1 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0 sm:flex-none sm:text-xs"
                    >
                        {busy === 'accept' ? 'Saving…' : meta.accept}
                    </button>
                    <button
                        type="button"
                        onClick={() => decide('reject')}
                        disabled={busy !== null}
                        className="min-h-11 flex-1 border border-line bg-surface px-3 py-1 text-sm font-semibold text-ink hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0 sm:flex-none sm:text-xs"
                    >
                        {busy === 'reject' ? 'Saving…' : meta.reject}
                    </button>
                </div>
            )}
        </aside>
    );
}

/** One queue for every change waiting on an admin: new events, go-public requests, edits, cancellations, removals. */
export default function ReviewPanel({ isOpen, onClose }: Props) {
    const [state, setState] = useState<'open' | 'decided'>('open');
    const [kinds, setKinds] = useState<EventRevisionKind[]>([]);
    const [sources, setSources] = useState<EventRevisionSource[]>([]);
    const [page, setPage] = useState(0);
    const [items, setItems] = useState<AdminChange[]>([]);
    const [total, setTotal] = useState(0);
    const [kindOptions, setKindOptions] = useState<FilterOption[]>([]);
    const [sourceOptions, setSourceOptions] = useState<FilterOption[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [selected, setSelected] = useState<AdminChange | null>(null);
    const [eventId, setEventId] = useState<string | null>(null);
    const isMobile = useMediaQuery('(max-width: 639px)');
    const [filtersOpen, setFiltersOpen] = useState(false);
    const tablePrefs = useAdminTablePrefs('admin:changes-table:v1', CHANGE_CONFIGURABLE);
    const byId = useMemo(() => new Map(items.map((c) => [String(c.id), c])), [items]);
    // Mobile appends pages; reloads refetch everything already loaded.
    const loadedRef = useRef(0);

    const load = useCallback(async (fresh = false) => {
        setLoading(true);
        setError('');
        try {
            const limit = isMobile ? (fresh ? PAGE_SIZE : Math.min(Math.max(loadedRef.current, PAGE_SIZE), 100)) : PAGE_SIZE;
            const offset = isMobile ? 0 : page * PAGE_SIZE;
            const res = await fetchAdminChanges({ kind: kinds, source: sources, state, limit, offset });
            setItems(res.items);
            loadedRef.current = res.items.length;
            setTotal(res.total);
            setKindOptions(res.kinds);
            setSourceOptions(res.sources);
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : 'Failed to load changes');
        } finally {
            setLoading(false);
        }
    }, [kinds, sources, state, page, isMobile]);

    const loadMore = async () => {
        setLoading(true);
        try {
            const res = await fetchAdminChanges({ kind: kinds, source: sources, state, limit: PAGE_SIZE, offset: loadedRef.current });
            const seen = new Set(items.map((c) => c.id));
            const next = [...items, ...res.items.filter((c) => !seen.has(c.id))];
            setItems(next);
            loadedRef.current = next.length;
            setTotal(res.total);
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : 'Failed to load changes');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch lifecycle
        if (isOpen) load(true);
    }, [isOpen, load]);

    const close = () => {
        setSelected(null);
        setPage(0);
        onClose();
    };
    useBackToClose(close, isOpen);
    // On phones the change detail covers the list, so back should return to it.
    useBackToClose(() => setSelected(null), isOpen && isMobile && selected !== null);

    const totalPages = Math.ceil(total / PAGE_SIZE);

    return (
        <>
            {isOpen && <div className="fixed inset-0 z-40 bg-black/20" onClick={close} />}
            <div
                className={`fixed top-0 right-0 z-50 flex h-full w-[1100px] max-w-full sm:max-w-[95vw] transform border-l border-line bg-surface shadow-lg transition-transform duration-200 ease-in-out ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}
                role="dialog"
                aria-label="Review"
            >
                <div className="flex min-w-0 flex-1 flex-col">
                    {isMobile ? (
                        <div className="flex min-h-14 shrink-0 items-center gap-1 border-b border-line bg-surface px-1 pt-[env(safe-area-inset-top)]">
                            <button type="button" onClick={close} aria-label="Close" className="inline-flex h-11 w-11 items-center justify-center text-ink">
                                <ArrowLeft className="h-5 w-5" aria-hidden="true" />
                            </button>
                            <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-ink">
                                Review
                                {!loading && <span className="ml-2 text-sm font-normal text-ink-soft">{total}</span>}
                            </h2>
                        </div>
                    ) : (
                        <div className="flex shrink-0 items-center justify-between border-b border-line bg-canvas px-4 py-2.5">
                            <h2 className="text-xs font-semibold uppercase tracking-wide text-ink">
                                Review
                                {!loading && <span className="ml-2 text-[10px] font-normal normal-case text-muted">{total} change{total !== 1 ? 's' : ''}</span>}
                            </h2>
                            <button type="button" onClick={close} className="p-1 text-sm leading-none text-muted hover:text-ink-soft" aria-label="Close">✕</button>
                        </div>
                    )}
                    <div className="shrink-0 space-y-2 border-b border-card-line px-4 py-2">
                        <div className="flex gap-2">
                            <div role="tablist" className="flex flex-1 gap-1 sm:flex-none">
                                {(['open', 'decided'] as const).map((value) => (
                                    <button
                                        key={value}
                                        type="button"
                                        role="tab"
                                        aria-selected={state === value}
                                        onClick={() => { setState(value); setPage(0); setSelected(null); }}
                                        className={`min-h-11 flex-1 border px-3 py-1 text-sm font-semibold transition sm:min-h-0 sm:flex-none sm:text-[11px] ${state === value ? 'border-action bg-action text-white' : 'border-line bg-surface text-ink-soft hover:bg-canvas'}`}
                                    >
                                        {value === 'open' ? 'Open' : 'Closed'}
                                    </button>
                                ))}
                            </div>
                            {isMobile && (
                                <button
                                    type="button"
                                    onClick={() => setFiltersOpen(true)}
                                    className="inline-flex min-h-11 shrink-0 items-center gap-1.5 border border-line bg-surface px-3 text-sm font-medium text-ink"
                                >
                                    <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
                                    Filters
                                    {kinds.length + sources.length > 0 && (
                                        <span className="inline-flex h-5 min-w-5 items-center justify-center bg-action px-1 text-[11px] font-semibold text-white">{kinds.length + sources.length}</span>
                                    )}
                                </button>
                            )}
                        </div>
                        {!isMobile && (
                            <div className="flex flex-wrap items-start gap-3">
                                <Pills
                                    label="Kind"
                                    kinds
                                    options={kindOptions}
                                    selected={kinds}
                                    onToggle={(v) => { setKinds((prev) => toggled(prev, v as EventRevisionKind)); setPage(0); }}
                                />
                                <Pills
                                    label="Source"
                                    options={sourceOptions}
                                    selected={sources}
                                    onToggle={(v) => { setSources((prev) => toggled(prev, v as EventRevisionSource)); setPage(0); }}
                                />
                                <div className="ml-auto">
                                    <AdminEventsColumnsMenu
                                        columns={CHANGE_CONFIGURABLE}
                                        prefs={tablePrefs.prefs}
                                        onChange={tablePrefs.setPrefs}
                                        onReset={tablePrefs.reset}
                                        onSaveAsDefault={tablePrefs.saveAsDefault}
                                        onFactoryReset={tablePrefs.factoryReset}
                                        hasUserDefault={tablePrefs.hasUserDefault}
                                        isDefault={tablePrefs.isDefault}
                                    />
                                </div>
                            </div>
                        )}
                    </div>
                    {error && <p role="alert" className="border-b border-danger/20 bg-danger/10 px-4 py-1.5 text-[11px] text-danger">{error}</p>}
                    <div className="flex-1 overflow-auto">
                        {loading && items.length === 0 ? (
                            <p className="mt-8 text-center text-xs text-muted">Loading…</p>
                        ) : items.length === 0 ? (
                            <p className="mt-8 text-center text-xs text-muted">{state === 'open' ? 'Nothing to review.' : 'No closed changes.'}</p>
                        ) : isMobile ? (
                            <>
                                <ul className="divide-y divide-line">
                                    {items.map((change) => (
                                        <li key={change.id}>
                                            <button
                                                type="button"
                                                onClick={() => setSelected(change)}
                                                className="flex w-full flex-col gap-1 px-4 py-3 text-left hover:bg-canvas"
                                            >
                                                <span className="flex items-center gap-2">
                                                    <span className={`inline-block px-1.5 py-0.5 text-[11px] font-medium ${KIND_META[change.kind].cls}`}>{KIND_META[change.kind].label}</span>
                                                    <span className="ml-auto text-xs text-ink-soft">
                                                        {state === 'open' ? age(change.created_at) : STATUS_LABELS[change.status] ?? change.status}
                                                    </span>
                                                </span>
                                                <span className="flex min-w-0 items-start gap-1 text-sm font-medium text-ink">
                                                    {change.event && (change.event.occurrences > 1 || change.series_dates > 1) && (
                                                        <Repeat className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-soft" aria-label="Series" role="img" />
                                                    )}
                                                    <span className="line-clamp-2">{change.event?.title ?? '—'}</span>
                                                </span>
                                                <span className="truncate text-xs text-ink-soft">{summary(change)}</span>
                                                <span className="truncate text-xs text-muted">
                                                    {[
                                                        change.event ? formatCompactDateRange(change.event) : null,
                                                        SOURCE_LABELS[change.source],
                                                        proposer(change),
                                                    ].filter(Boolean).join(' · ')}
                                                </span>
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                                <AdminLoadMore shown={items.length} total={total} loading={loading} onLoadMore={loadMore} />
                            </>
                        ) : (
                            <AdminDataTable
                                data={items}
                                columns={CHANGE_COLUMNS}
                                getRowId={(change) => String(change.id)}
                                prefs={tablePrefs.prefs}
                                setPrefs={tablePrefs.setPrefs}
                                rowClassName={(change) => `${CHANGE_KIND_META[change.kind].row} hover:brightness-95 ${selected?.id === change.id ? 'outline outline-2 -outline-offset-2 outline-action' : ''}`}
                                onRowClick={(id) => setSelected(byId.get(id) ?? null)}
                            />
                        )}
                    </div>
                    {!isMobile && totalPages > 1 && (
                        <div className="flex shrink-0 items-center justify-between border-t border-line bg-canvas px-4 py-2">
                            <span className="text-[10px] text-muted">{page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}</span>
                            <div className="flex gap-1">
                                <button type="button" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} className="border border-line px-2 py-1 text-[10px] text-ink-soft hover:bg-canvas disabled:opacity-40">← Prev</button>
                                <button type="button" onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} className="border border-line px-2 py-1 text-[10px] text-ink-soft hover:bg-canvas disabled:opacity-40">Next →</button>
                            </div>
                        </div>
                    )}
                </div>
                {selected && (
                    <ChangeDetail
                        key={selected.id}
                        change={selected}
                        onClose={() => setSelected(null)}
                        onOpenEvent={setEventId}
                        onDecided={() => { setSelected(null); load(); }}
                    />
                )}
            </div>
            <AdminEventDetailPanel
                eventId={eventId}
                onClose={() => setEventId(null)}
                onEventUpdated={() => load()}
            />
            {isMobile && isOpen && filtersOpen && (
                <BottomSheet
                    title="Filters"
                    onClose={() => setFiltersOpen(false)}
                    headerAction={kinds.length + sources.length > 0 ? (
                        <button type="button" onClick={() => { setKinds([]); setSources([]); setPage(0); }} className="min-h-11 px-2 text-sm font-medium text-action">Reset</button>
                    ) : undefined}
                    footer={
                        <button type="button" onClick={() => setFiltersOpen(false)} className="min-h-11 w-full bg-action text-sm font-semibold text-white hover:opacity-90">
                            {loading ? 'Loading…' : `Show ${total} change${total === 1 ? '' : 's'}`}
                        </button>
                    }
                >
                    <div className="space-y-5 pb-2">
                        {([
                            ['Kind', kindOptions, kinds as string[], (v: string) => setKinds((prev) => toggled(prev, v as EventRevisionKind))],
                            ['Source', sourceOptions, sources as string[], (v: string) => setSources((prev) => toggled(prev, v as EventRevisionSource))],
                        ] as const).map(([label, options, selectedValues, onToggle]) => (
                            <section key={label} className="space-y-2">
                                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-soft">{label}</h3>
                                <div className="flex flex-wrap gap-2">
                                    {options.map((o) => {
                                        const active = selectedValues.includes(o.value);
                                        return (
                                            <button
                                                key={o.value}
                                                type="button"
                                                aria-pressed={active}
                                                onClick={() => { onToggle(o.value); setPage(0); }}
                                                className={`inline-flex min-h-10 items-center gap-1.5 border px-3 text-sm transition ${active ? 'border-action bg-action text-white' : 'border-line bg-surface text-ink-soft hover:border-action hover:text-action'}`}
                                            >
                                                {o.label} <span className="opacity-70">{o.count}</span>
                                            </button>
                                        );
                                    })}
                                </div>
                            </section>
                        ))}
                    </div>
                </BottomSheet>
            )}
        </>
    );
}
