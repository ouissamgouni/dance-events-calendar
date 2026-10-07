import { useCallback, useEffect, useState } from 'react';
import { Repeat } from 'lucide-react';
import useBackToClose from '../hooks/useBackToClose';
import type { CalendarSetting, ChangeScope, EventRevisionKind, EventRevisionSource } from '../types';
import type { AdminChange, ChangeDecision, FilterOption } from '../api';
import { decideAdminChange, fetchAdminCalendars, fetchAdminChanges } from '../api';
import { notifyAdminDataChanged } from '../hooks/useAdminCounters';
import { describeRevisionValue, revisionFieldLabel } from '../utils/eventRevisions';
import { formatCompactDateRange } from '../utils/eventDates';
import { ADMIN_EVENT_STATUS_CHIP_CLASSES, ADMIN_EVENT_STATUS_LABELS } from '../utils/adminEventStatus';
import AdminEventDetailPanel from './AdminEventDetailPanel';
import { NotifyToggle, ScopeChoice } from './AdminEventModerationSection';

interface Props {
    isOpen: boolean;
    onClose: () => void;
}

const PAGE_SIZE = 25;

const KIND_META: Record<EventRevisionKind, { label: string; cls: string; accept: string; reject: string }> = {
    create: { label: 'New event', cls: 'bg-blue-100 text-action', accept: 'Publish', reject: 'Reject' },
    go_public: { label: 'Go public', cls: 'bg-amber-100 text-amber-800', accept: 'Make public', reject: 'Keep private' },
    edit: { label: 'Edit', cls: 'bg-orange-100 text-orange-800', accept: 'Apply', reject: 'Discard' },
    cancel: { label: 'Cancellation', cls: 'bg-red-50 text-danger', accept: 'Mark cancelled', reject: 'Keep' },
    remove: { label: 'Removal', cls: 'bg-slate-200 text-ink', accept: 'Remove', reject: 'Keep' },
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

function Pills({ label, options, selected, onToggle }: {
    label: string;
    options: FilterOption[];
    selected: string[];
    onToggle: (value: string) => void;
}) {
    return (
        <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1">
            <span className="text-[10px] uppercase tracking-wide text-muted">{label}</span>
            {options.map((option) => {
                const active = selected.includes(option.value);
                return (
                    <button
                        key={option.value}
                        type="button"
                        aria-pressed={active}
                        onClick={() => onToggle(option.value)}
                        className={`border px-2 py-0.5 text-[10px] font-medium transition ${active
                            ? 'border-blue-300 bg-blue-50 text-action'
                            : 'border-line bg-surface text-ink-soft hover:bg-canvas'}`}
                    >
                        {option.label} ({option.count})
                    </button>
                );
            })}
        </div>
    );
}

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
        <aside className="absolute inset-0 z-20 flex h-full w-full flex-col border-l border-line bg-surface sm:static sm:z-auto sm:w-[420px] sm:max-w-full sm:shrink-0" aria-label="Change detail">
            <div className="flex items-start justify-between gap-2 border-b border-line px-4 py-3">
                <div className="min-w-0">
                    <span className={`inline-block px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${meta.cls}`}>{meta.label}</span>
                    <p className="mt-1 truncate text-sm font-semibold text-ink">{change.event?.title ?? 'Event'}</p>
                    <p className="text-[11px] text-muted">{SOURCE_LABELS[change.source]} · {proposer(change)} · {age(change.created_at)} ago</p>
                </div>
                <button type="button" onClick={onClose} aria-label="Close change" className="p-1 text-sm text-muted hover:text-ink-soft">✕</button>
            </div>
            <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3 text-xs">
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
                <div className="flex gap-2 border-t border-line px-4 py-3">
                    <button
                        type="button"
                        onClick={() => decide('accept')}
                        disabled={busy !== null || (change.kind === 'go_public' && !calendarId)}
                        className="bg-action px-3 py-1 text-xs font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {busy === 'accept' ? 'Saving…' : meta.accept}
                    </button>
                    <button
                        type="button"
                        onClick={() => decide('reject')}
                        disabled={busy !== null}
                        className="border border-line bg-surface px-3 py-1 text-xs font-semibold text-ink hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50"
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

    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const res = await fetchAdminChanges({ kind: kinds, source: sources, state, limit: PAGE_SIZE, offset: page * PAGE_SIZE });
            setItems(res.items);
            setTotal(res.total);
            setKindOptions(res.kinds);
            setSourceOptions(res.sources);
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : 'Failed to load changes');
        } finally {
            setLoading(false);
        }
    }, [kinds, sources, state, page]);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch lifecycle
        if (isOpen) load();
    }, [isOpen, load]);

    const close = () => {
        setSelected(null);
        setPage(0);
        onClose();
    };
    useBackToClose(close, isOpen);

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
                    <div className="flex shrink-0 items-center justify-between border-b border-line bg-canvas px-4 py-2.5">
                        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink">
                            Review
                            {!loading && <span className="ml-2 text-[10px] font-normal normal-case text-muted">{total} change{total !== 1 ? 's' : ''}</span>}
                        </h2>
                        <button type="button" onClick={close} className="p-1 text-sm leading-none text-muted hover:text-ink-soft" aria-label="Close">✕</button>
                    </div>
                    <div className="shrink-0 space-y-2 border-b border-card-line px-4 py-2">
                        <div role="tablist" className="flex gap-1">
                            {(['open', 'decided'] as const).map((value) => (
                                <button
                                    key={value}
                                    type="button"
                                    role="tab"
                                    aria-selected={state === value}
                                    onClick={() => { setState(value); setPage(0); setSelected(null); }}
                                    className={`border px-3 py-1 text-[11px] font-semibold transition ${state === value ? 'border-action bg-action text-white' : 'border-line bg-surface text-ink-soft hover:bg-canvas'}`}
                                >
                                    {value === 'open' ? 'Open' : 'Closed'}
                                </button>
                            ))}
                        </div>
                        <div className="flex flex-wrap gap-3">
                            <Pills
                                label="Kind"
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
                        </div>
                    </div>
                    {error && <p role="alert" className="border-b border-danger/20 bg-danger/10 px-4 py-1.5 text-[11px] text-danger">{error}</p>}
                    <div className="flex-1 overflow-y-auto">
                        {loading && items.length === 0 ? (
                            <p className="mt-8 text-center text-xs text-muted">Loading…</p>
                        ) : items.length === 0 ? (
                            <p className="mt-8 text-center text-xs text-muted">{state === 'open' ? 'Nothing to review.' : 'No closed changes.'}</p>
                        ) : (
                            <table className="w-full table-fixed text-[11px]">
                                <thead className="sticky top-0 z-10 border-b border-line bg-canvas">
                                    <tr className="text-left uppercase tracking-wide text-ink-soft">
                                        <th className="w-24 px-2 py-2 font-semibold">Change</th>
                                        <th className="px-2 py-2 font-semibold">Event</th>
                                        <th className="hidden w-32 px-2 py-2 font-semibold sm:table-cell">Date</th>
                                        <th className="hidden w-28 px-2 py-2 font-semibold md:table-cell">Source</th>
                                        <th className="hidden w-32 px-2 py-2 font-semibold sm:table-cell">By</th>
                                        <th className="hidden w-20 px-2 py-2 font-semibold sm:table-cell">{state === 'open' ? 'Age' : 'Outcome'}</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-100">
                                    {items.map((change) => (
                                        <tr
                                            key={change.id}
                                            onClick={() => setSelected(change)}
                                            className={`cursor-pointer transition hover:bg-canvas ${selected?.id === change.id ? 'bg-blue-50' : ''}`}
                                        >
                                            <td className="whitespace-nowrap px-2 py-1.5">
                                                <span className={`inline-block px-1.5 py-0.5 text-[10px] font-medium ${KIND_META[change.kind].cls}`}>{KIND_META[change.kind].label}</span>
                                            </td>
                                            <td className="px-2 py-1.5">
                                                <p className="flex min-w-0 items-center gap-1 font-medium text-ink">
                                                    {change.event && (change.event.occurrences > 1 || change.series_dates > 1) && (
                                                        <Repeat className="h-3 w-3 shrink-0 text-ink-soft" aria-label="Series" role="img" />
                                                    )}
                                                    <span className="truncate">{change.event?.title ?? '—'}</span>
                                                </p>
                                                <p className="truncate text-[10px] text-muted">{summary(change)}</p>
                                                <p className="truncate text-[10px] text-ink-soft sm:hidden">
                                                    {[
                                                        change.event ? formatCompactDateRange(change.event) : null,
                                                        SOURCE_LABELS[change.source],
                                                        proposer(change),
                                                        state === 'open' ? age(change.created_at) : STATUS_LABELS[change.status] ?? change.status,
                                                    ].filter(Boolean).join(' · ')}
                                                </p>
                                            </td>
                                            <td className="hidden whitespace-nowrap px-2 py-1.5 text-ink-soft sm:table-cell">
                                                {change.event ? formatCompactDateRange(change.event) : '—'}
                                                {change.event && change.event.occurrences > 1 && <span className="ml-1 text-muted">×{change.event.occurrences}</span>}
                                            </td>
                                            <td className="hidden truncate px-2 py-1.5 text-ink-soft md:table-cell">{SOURCE_LABELS[change.source]}</td>
                                            <td className="hidden truncate px-2 py-1.5 text-ink-soft sm:table-cell" title={proposer(change)}>{proposer(change)}</td>
                                            <td className="hidden whitespace-nowrap px-2 py-1.5 text-ink-soft sm:table-cell">
                                                {state === 'open' ? age(change.created_at) : STATUS_LABELS[change.status] ?? change.status}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </div>
                    {totalPages > 1 && (
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
        </>
    );
}
