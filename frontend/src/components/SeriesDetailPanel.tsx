import { useEffect, useRef, useState } from 'react';
import {
    addEventsToSeries,
    approveSeriesGroup,
    dismissSeriesGroup,
    fetchAdminEvents,
    renameSeries,
    splitSeriesMember,
} from '../api';
import { notifyAdminDataChanged } from '../hooks/useAdminCounters';
import type { CalendarEvent, SeriesGroup } from '../types';

interface Props {
    series: SeriesGroup | null;
    onClose: () => void;
    /** Called with the updated series, or null when the series was dissolved/removed. */
    onChanged: (updated: SeriesGroup | null) => void;
    onOpenEvent?: (eventId: string) => void;
}

function statusBadge(status: string) {
    const colors: Record<string, string> = {
        pending: 'bg-amber-100 text-amber-700',
        resolved: 'bg-emerald-100 text-success',
        dismissed: 'bg-slate-200 text-ink',
    };
    return (
        <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 ${colors[status] ?? 'bg-gray-100 text-ink-soft'}`}>
            {status}
        </span>
    );
}

export default function SeriesDetailPanel({ series, onClose, onChanged, onOpenEvent }: Props) {
    const [draft, setDraft] = useState<SeriesGroup | null>(series);
    const [title, setTitle] = useState(series?.canonical_title ?? '');
    const [acting, setActing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [memberSearch, setMemberSearch] = useState('');
    const [candidates, setCandidates] = useState<CalendarEvent[]>([]);
    const [searching, setSearching] = useState(false);
    const searchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

    useEffect(() => {
        setDraft(series);
        setTitle(series?.canonical_title ?? '');
        setError(null);
        setMemberSearch('');
        setCandidates([]);
    }, [series]);

    // Auto-suggest events as the admin types (>= 3 chars), debounced.
    useEffect(() => {
        const term = memberSearch.trim();
        if (term.length < 3) return;
        if (searchTimer.current) clearTimeout(searchTimer.current);
        searchTimer.current = setTimeout(() => {
            setSearching(true);
            fetchAdminEvents({ search: term, limit: 20, include_past: true })
                .then((res) => {
                    const ids = new Set((draft?.events ?? []).map((e) => e.event_id));
                    setCandidates(res.items.filter((e) => !ids.has(e.event_id)));
                })
                .catch(() => setCandidates([]))
                .finally(() => setSearching(false));
        }, 250);
        return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
    }, [memberSearch, draft]);

    if (!draft) return null;

    const apply = (updated: SeriesGroup | null) => {
        setDraft(updated);
        onChanged(updated);
        notifyAdminDataChanged();
    };

    const saveTitle = async () => {
        if (!title.trim() || title.trim() === draft.canonical_title) return;
        setActing(true);
        setError(null);
        try {
            apply(await renameSeries(draft.id, title.trim()));
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to rename series');
        } finally {
            setActing(false);
        }
    };

    const approve = async () => {
        setActing(true);
        setError(null);
        try {
            apply(await approveSeriesGroup(draft.id));
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to approve series');
        } finally {
            setActing(false);
        }
    };

    const dismiss = async () => {
        setActing(true);
        setError(null);
        try {
            apply(await dismissSeriesGroup(draft.id));
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to dismiss series');
        } finally {
            setActing(false);
        }
    };

    const remove = async (eventId: string) => {
        setActing(true);
        setError(null);
        try {
            const res = await splitSeriesMember(draft.id, eventId);
            if (res.dissolved || !res.series) {
                apply(null);
                onClose();
            } else {
                apply(res.series);
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to remove event from series');
        } finally {
            setActing(false);
        }
    };

    const addMember = async (eventId: string) => {
        setActing(true);
        setError(null);
        try {
            const updated = await addEventsToSeries(draft.id, [eventId]);
            apply(updated);
            setCandidates((prev) => prev.filter((e) => e.event_id !== eventId));
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to add event to series');
        } finally {
            setActing(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex">
            <div className="flex-1 bg-black/30" onClick={onClose} aria-hidden="true" />
            <div className="w-full max-w-xl bg-surface shadow-xl flex flex-col">
                <div className="flex items-center justify-between px-4 py-3 border-b border-line">
                    <div className="flex items-center gap-2">
                        {statusBadge(draft.status)}
                        <h2 className="text-sm font-semibold text-ink">Series details</h2>
                    </div>
                    <button onClick={onClose} className="text-muted hover:text-ink text-sm px-2">✕</button>
                </div>

                {error && (
                    <div className="px-4 py-2 text-xs text-danger border-b border-red-200 bg-red-50">{error}</div>
                )}

                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                    {/* Editable title */}
                    <div>
                        <label className="block text-[10px] font-semibold text-ink-soft uppercase tracking-wide mb-1">Title</label>
                        <div className="flex gap-2">
                            <input
                                type="text"
                                value={title}
                                onChange={(e) => setTitle(e.target.value)}
                                className="flex-1 text-xs border border-line px-2 py-1"
                            />
                            <button
                                onClick={saveTitle}
                                disabled={acting || !title.trim() || title.trim() === draft.canonical_title}
                                className="text-[11px] bg-action text-white px-2.5 py-1 hover:bg-action disabled:opacity-50"
                            >
                                Save
                            </button>
                        </div>
                    </div>

                    {/* Members */}
                    <div>
                        <p className="text-[10px] font-semibold text-ink-soft uppercase tracking-wide mb-2">
                            Members ({draft.events.length})
                        </p>
                        <ul className="space-y-1.5">
                            {draft.events.map((ev) => (
                                <li
                                    key={ev.event_id}
                                    className="flex items-start justify-between gap-3 border border-card-line bg-canvas px-2 py-1.5"
                                >
                                    <div className="flex-1 min-w-0">
                                        {onOpenEvent ? (
                                            <button
                                                type="button"
                                                onClick={() => onOpenEvent(ev.event_id)}
                                                className="font-medium text-action hover:underline text-left text-xs"
                                            >
                                                {ev.title}
                                            </button>
                                        ) : (
                                            <span className="font-medium text-xs">{ev.title}</span>
                                        )}
                                        <div className="mt-0.5 text-[10px] text-ink-soft">
                                            {new Date(ev.start).toLocaleString()} — {ev.event_id}
                                        </div>
                                    </div>
                                    <button
                                        disabled={acting}
                                        onClick={() => remove(ev.event_id)}
                                        className="text-[11px] text-ink-soft hover:text-ink px-2 py-1 disabled:opacity-50 shrink-0"
                                    >
                                        Remove
                                    </button>
                                </li>
                            ))}
                        </ul>
                        <p className="mt-1 text-[10px] text-muted">
                            Removing members below 2 dissolves the series.
                        </p>
                    </div>

                    {/* Add member */}
                    <div>
                        <p className="text-[10px] font-semibold text-ink-soft uppercase tracking-wide mb-2">Add event</p>
                        <input
                            type="text"
                            value={memberSearch}
                            onChange={(e) => setMemberSearch(e.target.value)}
                            placeholder="Search events by title…"
                            className="w-full text-xs border border-line px-2 py-1"
                        />
                        {memberSearch.trim().length >= 3 && (
                            searching && candidates.length === 0 ? (
                                <p className="mt-2 text-[11px] text-muted">Searching…</p>
                            ) : candidates.length > 0 ? (
                                <div className="mt-2 max-h-48 overflow-y-auto border border-line">
                                    {candidates.map((ev) => (
                                        <button
                                            key={ev.event_id}
                                            onClick={() => addMember(ev.event_id)}
                                            disabled={acting}
                                            className="flex w-full items-center justify-between gap-2 border-b border-card-line px-2 py-1.5 text-left last:border-b-0 hover:bg-blue-50 disabled:opacity-50"
                                        >
                                            <span className="min-w-0 flex-1 truncate text-[11px] text-ink">{ev.title}</span>
                                            <span className="text-[10px] text-muted">{new Date(ev.start).toLocaleDateString()}</span>
                                        </button>
                                    ))}
                                </div>
                            ) : (
                                <p className="mt-2 text-[11px] text-muted">No events found.</p>
                            )
                        )}
                    </div>

                    {/* Approve / dismiss */}
                    {draft.status === 'pending' && (
                        <div className="flex items-center gap-2 pt-2 border-t border-card-line">
                            <button
                                disabled={acting}
                                onClick={approve}
                                className="text-[11px] bg-action text-white px-2 py-1 hover:bg-action disabled:opacity-50"
                            >
                                Approve series
                            </button>
                            <button
                                disabled={acting}
                                onClick={dismiss}
                                className="text-[11px] text-ink-soft hover:text-ink px-2 py-1 disabled:opacity-50"
                            >
                                Not a series — dismiss
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
