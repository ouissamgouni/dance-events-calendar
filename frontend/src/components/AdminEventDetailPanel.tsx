import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { blockEvent, dismissDuplicateGroup, fetchAdminEvent, fetchEventDuplicateCandidates, keepDuplicateEvent, unblockEvent, updateEvent, fetchEventSeriesCandidates, splitSeriesMember, addEventsToSeries, fetchSeriesGroups } from '../api';
import { notifyAdminDataChanged } from '../hooks/useAdminCounters';
import AdminEventDetailContent from './AdminEventDetailContent';
import EventReviewsSection from './EventReviewsSection';
import EventMessagesSection from './EventMessagesSection';
import EventMap from './EventMap';
import type { CalendarEvent, DuplicateGroup, SeriesGroup } from '../types';

interface Props {
    eventId: string | null;
    onClose: () => void;
    onEventUpdated?: (eventId: string) => void;
}

export default function AdminEventDetailPanel({ eventId, onClose, onEventUpdated }: Props) {
    const [event, setEvent] = useState<CalendarEvent | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(false);

    // Title inline editing
    const [editingTitle, setEditingTitle] = useState(false);
    const [titleValue, setTitleValue] = useState('');
    const [savingTitle, setSavingTitle] = useState(false);
    const titleCancelledRef = useRef(false);

    // Hide / block confirm state
    const [confirmAction, setConfirmAction] = useState<'block' | 'restore' | null>(null);
    const [actionLoading, setActionLoading] = useState(false);

    // Potential duplicates
    const [duplicateGroups, setDuplicateGroups] = useState<DuplicateGroup[]>([]);
    const [duplicatesLoading, setDuplicatesLoading] = useState(false);
    const [duplicateActing, setDuplicateActing] = useState<number | null>(null);

    // Series membership
    const [seriesGroups, setSeriesGroups] = useState<SeriesGroup[]>([]);
    const [seriesLoading, setSeriesLoading] = useState(false);
    const [seriesActing, setSeriesActing] = useState(false);
    const [addSeriesOpen, setAddSeriesOpen] = useState(false);
    const [seriesSearch, setSeriesSearch] = useState('');
    const [seriesSearchResults, setSeriesSearchResults] = useState<SeriesGroup[]>([]);
    const [seriesSearchLoading, setSeriesSearchLoading] = useState(false);
    const [communityExpanded, setCommunityExpanded] = useState(false);
    const [messagesExpanded, setMessagesExpanded] = useState(false);

    const isOpen = eventId !== null;

    useEffect(() => {
        if (!eventId) {
            setEvent(null);
            setError(false);
            setEditingTitle(false);
            return;
        }
        setLoading(true);
        setError(false);
        setEvent(null);
        fetchAdminEvent(eventId)
            .then((e) => { setEvent(e); setTitleValue(e.title); })
            .catch(() => setError(true))
            .finally(() => setLoading(false));
    }, [eventId]);

    useEffect(() => {
        if (!eventId) {
            setDuplicateGroups([]);
            return;
        }
        setDuplicatesLoading(true);
        fetchEventDuplicateCandidates(eventId)
            .then((res) => setDuplicateGroups(res.items))
            .catch(() => setDuplicateGroups([]))
            .finally(() => setDuplicatesLoading(false));
    }, [eventId]);

    useEffect(() => {
        if (!eventId) {
            setSeriesGroups([]);
            setAddSeriesOpen(false);
            setSeriesSearch('');
            setSeriesSearchResults([]);
            return;
        }
        setSeriesLoading(true);
        fetchEventSeriesCandidates(eventId)
            .then((res) => setSeriesGroups(res.items))
            .catch(() => setSeriesGroups([]))
            .finally(() => setSeriesLoading(false));
    }, [eventId]);

    // Keyboard close
    useEffect(() => {
        if (!isOpen) return;
        const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [isOpen, onClose]);

    const handleFieldSave = async (changes: Partial<CalendarEvent>) => {
        if (!event) return;
        const updated = await updateEvent(event.event_id, changes);
        setEvent(updated);
        setTitleValue(updated.title);
        onEventUpdated?.(updated.event_id);
        // Refresh badge counters — e.g. flipping review_status from
        // "pending" to "reviewed" needs to update the Pending Review badge.
        notifyAdminDataChanged();
    };

    const handleTagsUpdated = () => {
        if (!eventId) return;
        fetchAdminEvent(eventId)
            .then((e) => { setEvent(e); setTitleValue(e.title); })
            .catch(() => { });
        notifyAdminDataChanged();
    };

    const handleManualRefresh = () => {
        if (!eventId) return;
        setLoading(true);
        fetchAdminEvent(eventId)
            .then((e) => { setEvent(e); setTitleValue(e.title); })
            .catch(() => setError(true))
            .finally(() => setLoading(false));
    };

    const handleHide = async () => {
        if (!event) return;
        setActionLoading(true);
        try {
            const updated = await updateEvent(event.event_id, { is_hidden: true });
            setEvent(updated);
            onEventUpdated?.(updated.event_id);
            notifyAdminDataChanged();
        } finally { setActionLoading(false); }
    };

    const handleUnhide = async () => {
        if (!event) return;
        setActionLoading(true);
        try {
            const updated = await updateEvent(event.event_id, { is_hidden: false });
            setEvent(updated);
            onEventUpdated?.(updated.event_id);
            notifyAdminDataChanged();
        } finally { setActionLoading(false); }
    };

    const handleBlock = async () => {
        if (!event) return;
        setActionLoading(true);
        try {
            const updated = await blockEvent(event.event_id);
            setEvent(updated);
            onEventUpdated?.(updated.event_id);
            notifyAdminDataChanged();
        } finally { setActionLoading(false); setConfirmAction(null); }
    };

    const handleRestore = async () => {
        if (!event) return;
        setActionLoading(true);
        try {
            const updated = await unblockEvent(event.event_id);
            setEvent(updated);
            onEventUpdated?.(updated.event_id);
            notifyAdminDataChanged();
        } finally { setActionLoading(false); setConfirmAction(null); }
    };

    const handleKeepDuplicate = async (groupId: number, keepEventId: string) => {
        setDuplicateActing(groupId);
        try {
            const updated = await keepDuplicateEvent(groupId, keepEventId);
            setDuplicateGroups((prev) => prev.map((g) => (g.id === groupId ? updated : g)));
            notifyAdminDataChanged();
        } finally {
            setDuplicateActing(null);
        }
    };

    const handleDismissDuplicateGroup = async (groupId: number) => {
        setDuplicateActing(groupId);
        try {
            const updated = await dismissDuplicateGroup(groupId);
            setDuplicateGroups((prev) => prev.map((g) => (g.id === groupId ? updated : g)));
            notifyAdminDataChanged();
        } finally {
            setDuplicateActing(null);
        }
    };

    const handleRemoveFromSeries = async (seriesId: number) => {
        if (!eventId) return;
        setSeriesActing(true);
        try {
            await splitSeriesMember(seriesId, eventId);
            setSeriesGroups((prev) => prev.filter((g) => g.id !== seriesId));
            notifyAdminDataChanged();
        } finally {
            setSeriesActing(false);
        }
    };

    const runSeriesSearch = async () => {
        setSeriesSearchLoading(true);
        try {
            const res = await fetchSeriesGroups('all', { q: seriesSearch.trim() || undefined, limit: 20 });
            const memberSeriesIds = new Set(seriesGroups.map((g) => g.id));
            setSeriesSearchResults(res.items.filter((s) => !memberSeriesIds.has(s.id)));
        } finally {
            setSeriesSearchLoading(false);
        }
    };

    const handleAddToSeries = async (seriesId: number) => {
        if (!eventId) return;
        setSeriesActing(true);
        try {
            const updated = await addEventsToSeries(seriesId, [eventId]);
            setSeriesGroups([updated]);
            setAddSeriesOpen(false);
            setSeriesSearch('');
            setSeriesSearchResults([]);
            notifyAdminDataChanged();
        } finally {
            setSeriesActing(false);
        }
    };

    const handleTitleBlur = async () => {
        if (titleCancelledRef.current) { titleCancelledRef.current = false; return; }
        if (!event || titleValue === event.title) { setEditingTitle(false); return; }
        setSavingTitle(true);
        try {
            const updated = await updateEvent(event.event_id, { title: titleValue });
            setEvent(updated);
            onEventUpdated?.(updated.event_id);
        } finally {
            setSavingTitle(false);
            setEditingTitle(false);
        }
    };

    const handleTitleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') { e.preventDefault(); handleTitleBlur(); }
        if (e.key === 'Escape') {
            titleCancelledRef.current = true;
            setTitleValue(event?.title ?? '');
            setEditingTitle(false);
        }
    };

    return (
        <>
            {/* Backdrop — click closes only this panel, not the parent */}
            {isOpen && (
                <div className="fixed inset-0 z-[59]" onClick={onClose} />
            )}

            {/* Panel */}
            <div
                className={`fixed top-0 right-0 h-full w-[520px] max-w-full bg-surface shadow-xl border-l border-line z-[60] flex flex-col transform transition-transform duration-200 ease-in-out ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}
            >
                {/* Header */}
                <div className="flex items-start justify-between px-5 py-3 border-b border-line bg-canvas shrink-0">
                    <div className="flex-1 min-w-0 mr-3">
                        {editingTitle ? (
                            <input
                                autoFocus
                                type="text"
                                value={titleValue}
                                onChange={(e) => setTitleValue(e.target.value)}
                                onBlur={handleTitleBlur}
                                onKeyDown={handleTitleKeyDown}
                                disabled={savingTitle}
                                className="w-full text-sm font-semibold text-ink border-b border-rose-300 bg-transparent focus:outline-none"
                            />
                        ) : (
                            <p
                                className="text-sm font-semibold text-ink leading-snug truncate cursor-text hover:bg-canvas -mx-1 px-1 rounded transition"
                                onClick={() => event && setEditingTitle(true)}
                                title="Click to edit title"
                            >
                                {loading ? 'Loading…' : (event?.title ?? '—')}
                            </p>
                        )}
                        <p className="text-[10px] text-muted mt-0.5 uppercase tracking-wide">Event detail · admin</p>
                        {event && (
                            <p className="text-[10px] text-muted mt-0.5 font-mono truncate" title={event.event_id}>
                                ID: {event.event_id}
                            </p>
                        )}
                        {event && (
                            <div className="flex gap-1 mt-1">
                                {event.is_blocked && (
                                    <span className="text-[10px] bg-slate-200 text-ink px-1.5 py-0.5 font-medium uppercase tracking-wide">Blocked</span>
                                )}
                                {event.is_hidden && !event.is_blocked && (
                                    <span className="text-[10px] bg-amber-100 text-amber-700 px-1.5 py-0.5 font-medium uppercase tracking-wide">Hidden</span>
                                )}
                            </div>
                        )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                        <button
                            onClick={handleManualRefresh}
                            disabled={loading || !event}
                            className="text-muted hover:text-ink-soft disabled:opacity-40 p-1"
                            title="Refresh event"
                            aria-label="Refresh event"
                        >
                            <svg
                                xmlns="http://www.w3.org/2000/svg"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`}
                            >
                                <polyline points="23 4 23 10 17 10" />
                                <polyline points="1 20 1 14 7 14" />
                                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                            </svg>
                        </button>
                        <button
                            onClick={onClose}
                            className="text-muted hover:text-ink-soft text-sm leading-none p-1"
                            aria-label="Close"
                        >
                            ✕
                        </button>
                    </div>
                </div>

                {/* Body */}
                <div className="flex-1 overflow-y-auto px-5 py-4">
                    {loading && (
                        <p className="text-xs text-muted text-center mt-8">Loading event…</p>
                    )}
                    {error && (
                        <p className="text-xs text-danger text-center mt-8">Failed to load event.</p>
                    )}
                    {event && (
                        <>
                            <AdminEventDetailContent
                                event={event}
                                onFieldSave={handleFieldSave}
                                onTagsUpdated={handleTagsUpdated}
                                compact
                            />
                            {!duplicatesLoading && duplicateGroups.length > 0 && (
                                <div className="mt-4 border border-amber-200 bg-amber-50 overflow-hidden">
                                    <p className="px-3 py-2 text-[10px] font-semibold text-amber-800 uppercase tracking-wide">
                                        Potential duplicates
                                    </p>
                                    <ul className="divide-y divide-amber-100">
                                        {duplicateGroups.map((g) => (
                                            <li key={g.id} className="px-3 py-2">
                                                <div className="flex items-center gap-2 flex-wrap mb-1">
                                                    <span className="text-[10px] font-semibold uppercase px-1.5 py-0.5 bg-amber-100 text-amber-700">
                                                        {g.status}
                                                    </span>
                                                    <span className="text-[10px] uppercase text-amber-600">{g.source}</span>
                                                </div>
                                                <ul className="space-y-1">
                                                    {g.events
                                                        .filter((ev) => ev.event_id !== event.event_id)
                                                        .map((ev) => (
                                                            <li key={ev.event_id} className="text-xs text-ink">
                                                                {ev.title} — {new Date(ev.start).toLocaleString()}
                                                            </li>
                                                        ))}
                                                </ul>
                                                {g.status === 'pending' && (
                                                    <div className="mt-1.5 flex items-center gap-2">
                                                        <button
                                                            disabled={duplicateActing === g.id}
                                                            onClick={() => handleKeepDuplicate(g.id, event.event_id)}
                                                            className="text-[11px] bg-action text-white px-2 py-1 hover:bg-action disabled:opacity-50"
                                                        >
                                                            Keep this event
                                                        </button>
                                                        <button
                                                            disabled={duplicateActing === g.id}
                                                            onClick={() => handleDismissDuplicateGroup(g.id)}
                                                            className="text-[11px] text-amber-700 hover:text-amber-900 px-2 py-1 disabled:opacity-50"
                                                        >
                                                            Not duplicates
                                                        </button>
                                                    </div>
                                                )}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                            {!seriesLoading && (
                                <div className="mt-4 border border-teal-200 bg-teal-50 overflow-hidden">
                                    <p className="px-3 py-2 text-[10px] font-semibold text-teal-800 uppercase tracking-wide">
                                        Series
                                    </p>
                                    {seriesGroups.length > 0 ? (
                                        <ul className="divide-y divide-teal-100">
                                            {seriesGroups.map((g) => (
                                                <li key={g.id} className="px-3 py-2">
                                                    <div className="flex items-center gap-2 flex-wrap mb-1">
                                                        <span className="text-[10px] font-semibold uppercase px-1.5 py-0.5 bg-teal-100 text-teal-700">
                                                            {g.status}
                                                        </span>
                                                        <span className="font-medium text-xs text-ink">{g.canonical_title}</span>
                                                        <span className="text-[10px] text-ink-soft">{g.events.length} event(s)</span>
                                                    </div>
                                                    <button
                                                        disabled={seriesActing}
                                                        onClick={() => handleRemoveFromSeries(g.id)}
                                                        className="text-[11px] text-teal-700 hover:text-teal-900 px-2 py-1 disabled:opacity-50"
                                                    >
                                                        Remove from series
                                                    </button>
                                                </li>
                                            ))}
                                        </ul>
                                    ) : (
                                        <div className="px-3 py-2">
                                            {!addSeriesOpen ? (
                                                <button
                                                    onClick={() => { setAddSeriesOpen(true); setSeriesSearch(''); setSeriesSearchResults([]); }}
                                                    className="text-[11px] bg-teal-600 text-white px-2 py-1 hover:bg-teal-700"
                                                >
                                                    Add to series
                                                </button>
                                            ) : (
                                                <div className="space-y-2">
                                                    <div className="flex gap-2">
                                                        <input
                                                            type="text"
                                                            value={seriesSearch}
                                                            onChange={(e) => setSeriesSearch(e.target.value)}
                                                            onKeyDown={(e) => { if (e.key === 'Enter') runSeriesSearch(); }}
                                                            placeholder="Search series by title…"
                                                            className="flex-1 text-xs border border-line px-2 py-1"
                                                        />
                                                        <button
                                                            onClick={runSeriesSearch}
                                                            disabled={seriesSearchLoading}
                                                            className="text-[11px] bg-teal-600 text-white px-2.5 py-1 hover:bg-teal-700 disabled:opacity-50"
                                                        >
                                                            {seriesSearchLoading ? 'Searching…' : 'Search'}
                                                        </button>
                                                    </div>
                                                    {seriesSearchResults.length > 0 && (
                                                        <div className="max-h-40 overflow-y-auto border border-line bg-surface">
                                                            {seriesSearchResults.map((s) => (
                                                                <button
                                                                    key={s.id}
                                                                    onClick={() => handleAddToSeries(s.id)}
                                                                    disabled={seriesActing}
                                                                    className="flex w-full items-center justify-between gap-2 border-b border-card-line px-2 py-1.5 text-left last:border-b-0 hover:bg-teal-50 disabled:opacity-50"
                                                                >
                                                                    <span className="min-w-0 flex-1 truncate text-[11px] text-ink">{s.canonical_title}</span>
                                                                    <span className="text-[10px] text-muted">{s.events.length} · {s.status}</span>
                                                                </button>
                                                            ))}
                                                        </div>
                                                    )}
                                                    <button
                                                        onClick={() => { setAddSeriesOpen(false); setSeriesSearch(''); setSeriesSearchResults([]); }}
                                                        className="text-[10px] text-ink-soft hover:text-ink"
                                                    >
                                                        Cancel
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            )}
                            <div className="mt-4 border border-line overflow-hidden">
                                {event.latitude != null && event.longitude != null ? (
                                    <div className="h-[300px]">
                                        <EventMap events={[event]} />
                                    </div>
                                ) : (
                                    <div className="px-3 py-4 bg-canvas">
                                        <p className="text-xs font-medium text-ink">Map unavailable</p>
                                        <p className="mt-1 text-xs text-ink-soft">
                                            {event.location
                                                ? 'This event has a location text but is not geocoded yet.'
                                                : 'This event has no location set yet.'}
                                        </p>
                                    </div>
                                )}
                            </div>
                            <div className="mt-4 border border-line overflow-hidden">
                                <button
                                    type="button"
                                    onClick={() => setCommunityExpanded((v) => !v)}
                                    className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-canvas transition"
                                >
                                    <span className="text-muted text-[10px]">{communityExpanded ? '▾' : '▸'}</span>
                                    <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-soft">Community Experience</span>
                                </button>
                                {communityExpanded && (
                                    <div className="border-t border-line px-3 pb-3">
                                        <EventReviewsSection
                                            eventId={event.event_id}
                                            isPast={new Date(event.end).getTime() < Date.now()}
                                        />
                                    </div>
                                )}
                            </div>
                            <div className="mt-4 border border-line overflow-hidden">
                                <button
                                    type="button"
                                    onClick={() => setMessagesExpanded((v) => !v)}
                                    className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-canvas transition"
                                >
                                    <span className="text-muted text-[10px]">{messagesExpanded ? '▾' : '▸'}</span>
                                    <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-soft">Messages</span>
                                </button>
                                {messagesExpanded && (
                                    <div className="border-t border-line px-3 pb-3">
                                        <EventMessagesSection
                                            eventId={event.event_id}
                                            isPast={new Date(event.end).getTime() < Date.now()}
                                        />
                                    </div>
                                )}
                            </div>
                        </>
                    )}
                </div>

                {/* Footer */}
                {event && (
                    <div className="shrink-0 border-t border-line bg-canvas px-5 py-2.5 flex flex-col gap-2">
                        <div className="flex items-center gap-3">
                            <Link
                                to={`/event/${event.event_id}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs text-rose-500 hover:text-rose-700 hover:underline"
                            >
                                See full details ↗
                            </Link>
                        </div>
                        {/* Admin visibility actions */}
                        {event.is_blocked ? (
                            /* Blocked state — only restore */
                            confirmAction === 'restore' ? (
                                <div className="flex items-center gap-2">
                                    <span className="text-xs text-ink-soft">Restore this event?</span>
                                    <button
                                        onClick={handleRestore}
                                        disabled={actionLoading}
                                        className="text-xs px-2 py-1 bg-surface border border-line text-ink hover:bg-canvas disabled:opacity-50"
                                    >
                                        Yes, restore
                                    </button>
                                    <button
                                        onClick={() => setConfirmAction(null)}
                                        className="text-xs px-2 py-1 text-muted hover:text-ink-soft"
                                    >
                                        Cancel
                                    </button>
                                </div>
                            ) : (
                                <button
                                    onClick={() => setConfirmAction('restore')}
                                    className="text-xs px-2 py-1 border border-line bg-surface text-ink hover:bg-canvas self-start"
                                >
                                    Restore
                                </button>
                            )
                        ) : event.is_hidden ? (
                            /* Hidden (not blocked) — unhide or permanently remove */
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={handleUnhide}
                                    disabled={actionLoading}
                                    className="text-xs px-2 py-1 border border-line bg-surface text-ink hover:bg-canvas disabled:opacity-50"
                                >
                                    Unhide
                                </button>
                                {confirmAction === 'block' ? (
                                    <div className="flex items-center gap-2">
                                        <span className="text-xs text-ink-soft">Permanently remove?</span>
                                        <button
                                            onClick={handleBlock}
                                            disabled={actionLoading}
                                            className="text-xs px-2 py-1 bg-danger hover:bg-danger/90 text-white disabled:opacity-50"
                                        >
                                            Yes, remove
                                        </button>
                                        <button
                                            onClick={() => setConfirmAction(null)}
                                            className="text-xs px-2 py-1 text-muted hover:text-ink-soft"
                                        >
                                            Cancel
                                        </button>
                                    </div>
                                ) : (
                                    <button
                                        onClick={() => setConfirmAction('block')}
                                        className="text-xs px-2 py-1 bg-danger hover:bg-danger/90 text-white"
                                    >
                                        Permanently Remove
                                    </button>
                                )}
                            </div>
                        ) : (
                            /* Normal state — hide or permanently remove */
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={handleHide}
                                    disabled={actionLoading}
                                    className="text-xs px-2 py-1 border border-line bg-surface text-ink hover:bg-canvas disabled:opacity-50"
                                >
                                    Hide
                                </button>
                                {confirmAction === 'block' ? (
                                    <div className="flex items-center gap-2">
                                        <span className="text-xs text-ink-soft">Permanently remove?</span>
                                        <button
                                            onClick={handleBlock}
                                            disabled={actionLoading}
                                            className="text-xs px-2 py-1 bg-danger hover:bg-danger/90 text-white disabled:opacity-50"
                                        >
                                            Yes, remove
                                        </button>
                                        <button
                                            onClick={() => setConfirmAction(null)}
                                            className="text-xs px-2 py-1 text-muted hover:text-ink-soft"
                                        >
                                            Cancel
                                        </button>
                                    </div>
                                ) : (
                                    <button
                                        onClick={() => setConfirmAction('block')}
                                        className="text-xs px-2 py-1 bg-danger hover:bg-danger/90 text-white"
                                    >
                                        Permanently Remove
                                    </button>
                                )}
                            </div>
                        )}
                    </div>
                )}
            </div>

        </>
    );
}
