import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { blockEvent, fetchAdminEvent, unblockEvent, updateEvent } from '../api';
import { notifyAdminDataChanged } from '../hooks/useAdminCounters';
import AdminEventDetailContent from './AdminEventDetailContent';
import EventMap from './EventMap';
import type { CalendarEvent } from '../types';

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
                className={`fixed top-0 right-0 h-full w-[520px] max-w-full bg-white shadow-xl border-l border-gray-200 z-[60] flex flex-col transform transition-transform duration-200 ease-in-out ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}
            >
                {/* Header */}
                <div className="flex items-start justify-between px-5 py-3 border-b border-gray-200 bg-gray-50 shrink-0">
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
                                className="w-full text-sm font-semibold text-gray-900 border-b border-rose-300 bg-transparent focus:outline-none"
                            />
                        ) : (
                            <p
                                className="text-sm font-semibold text-gray-900 leading-snug truncate cursor-text hover:bg-gray-100 -mx-1 px-1 rounded transition"
                                onClick={() => event && setEditingTitle(true)}
                                title="Click to edit title"
                            >
                                {loading ? 'Loading…' : (event?.title ?? '—')}
                            </p>
                        )}
                        <p className="text-[10px] text-gray-400 mt-0.5 uppercase tracking-wide">Event detail · admin</p>
                        {event && (
                            <div className="flex gap-1 mt-1">
                                {event.is_blocked && (
                                    <span className="text-[10px] bg-slate-200 text-slate-700 px-1.5 py-0.5 font-medium uppercase tracking-wide">Blocked</span>
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
                            className="text-gray-400 hover:text-gray-600 disabled:opacity-40 p-1"
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
                            className="text-gray-400 hover:text-gray-600 text-sm leading-none p-1"
                            aria-label="Close"
                        >
                            ✕
                        </button>
                    </div>
                </div>

                {/* Body */}
                <div className="flex-1 overflow-y-auto px-5 py-4">
                    {loading && (
                        <p className="text-xs text-gray-400 text-center mt-8">Loading event…</p>
                    )}
                    {error && (
                        <p className="text-xs text-red-500 text-center mt-8">Failed to load event.</p>
                    )}
                    {event && (
                        <>
                            <AdminEventDetailContent
                                event={event}
                                onFieldSave={handleFieldSave}
                                onTagsUpdated={handleTagsUpdated}
                                compact
                            />
                            <div className="mt-4 border border-gray-200 overflow-hidden">
                                {event.latitude != null && event.longitude != null ? (
                                    <div className="h-[300px]">
                                        <EventMap events={[event]} />
                                    </div>
                                ) : (
                                    <div className="px-3 py-4 bg-slate-50">
                                        <p className="text-xs font-medium text-slate-700">Map unavailable</p>
                                        <p className="mt-1 text-xs text-slate-500">
                                            {event.location
                                                ? 'This event has a location text but is not geocoded yet.'
                                                : 'This event has no location set yet.'}
                                        </p>
                                    </div>
                                )}
                            </div>
                        </>
                    )}
                </div>

                {/* Footer */}
                {event && (
                    <div className="shrink-0 border-t border-gray-200 bg-gray-50 px-5 py-2.5 flex flex-col gap-2">
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
                                    <span className="text-xs text-gray-600">Restore this event?</span>
                                    <button
                                        onClick={handleRestore}
                                        disabled={actionLoading}
                                        className="text-xs px-2 py-1 bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                                    >
                                        Yes, restore
                                    </button>
                                    <button
                                        onClick={() => setConfirmAction(null)}
                                        className="text-xs px-2 py-1 text-gray-400 hover:text-gray-600"
                                    >
                                        Cancel
                                    </button>
                                </div>
                            ) : (
                                <button
                                    onClick={() => setConfirmAction('restore')}
                                    className="text-xs px-2 py-1 border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 self-start"
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
                                    className="text-xs px-2 py-1 border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                                >
                                    Unhide
                                </button>
                                {confirmAction === 'block' ? (
                                    <div className="flex items-center gap-2">
                                        <span className="text-xs text-gray-600">Permanently remove?</span>
                                        <button
                                            onClick={handleBlock}
                                            disabled={actionLoading}
                                            className="text-xs px-2 py-1 bg-red-600 hover:bg-red-700 text-white disabled:opacity-50"
                                        >
                                            Yes, remove
                                        </button>
                                        <button
                                            onClick={() => setConfirmAction(null)}
                                            className="text-xs px-2 py-1 text-gray-400 hover:text-gray-600"
                                        >
                                            Cancel
                                        </button>
                                    </div>
                                ) : (
                                    <button
                                        onClick={() => setConfirmAction('block')}
                                        className="text-xs px-2 py-1 bg-red-600 hover:bg-red-700 text-white"
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
                                    className="text-xs px-2 py-1 border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                                >
                                    Hide
                                </button>
                                {confirmAction === 'block' ? (
                                    <div className="flex items-center gap-2">
                                        <span className="text-xs text-gray-600">Permanently remove?</span>
                                        <button
                                            onClick={handleBlock}
                                            disabled={actionLoading}
                                            className="text-xs px-2 py-1 bg-red-600 hover:bg-red-700 text-white disabled:opacity-50"
                                        >
                                            Yes, remove
                                        </button>
                                        <button
                                            onClick={() => setConfirmAction(null)}
                                            className="text-xs px-2 py-1 text-gray-400 hover:text-gray-600"
                                        >
                                            Cancel
                                        </button>
                                    </div>
                                ) : (
                                    <button
                                        onClick={() => setConfirmAction('block')}
                                        className="text-xs px-2 py-1 bg-red-600 hover:bg-red-700 text-white"
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
