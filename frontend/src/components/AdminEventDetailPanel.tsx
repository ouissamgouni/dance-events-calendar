import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchEvent, updateEvent } from '../api';
import AdminEventDetailContent from './AdminEventDetailContent';
import type { CalendarEvent } from '../types';

interface Props {
    eventId: string | null;
    onClose: () => void;
}

export default function AdminEventDetailPanel({ eventId, onClose }: Props) {
    const [event, setEvent] = useState<CalendarEvent | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(false);

    // Title inline editing
    const [editingTitle, setEditingTitle] = useState(false);
    const [titleValue, setTitleValue] = useState('');
    const [savingTitle, setSavingTitle] = useState(false);
    const titleCancelledRef = useRef(false);

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
        fetchEvent(eventId)
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
    };

    const handleTagsUpdated = () => {
        if (!eventId) return;
        fetchEvent(eventId).then((e) => { setEvent(e); setTitleValue(e.title); }).catch(() => { });
    };

    const handleTitleBlur = async () => {
        if (titleCancelledRef.current) { titleCancelledRef.current = false; return; }
        if (!event || titleValue === event.title) { setEditingTitle(false); return; }
        setSavingTitle(true);
        try {
            const updated = await updateEvent(event.event_id, { title: titleValue });
            setEvent(updated);
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
                    </div>
                    <button
                        onClick={onClose}
                        className="text-gray-400 hover:text-gray-600 text-sm leading-none p-1 shrink-0"
                        aria-label="Close"
                    >
                        ✕
                    </button>
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
                        <AdminEventDetailContent
                            event={event}
                            onFieldSave={handleFieldSave}
                            onTagsUpdated={handleTagsUpdated}
                        />
                    )}
                </div>

                {/* Footer */}
                {event && (
                    <div className="shrink-0 border-t border-gray-200 bg-gray-50 px-5 py-2.5 flex items-center gap-3">
                        <Link
                            to={`/event/${event.event_id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-rose-500 hover:text-rose-700 hover:underline"
                        >
                            See full details ↗
                        </Link>
                    </div>
                )}
            </div>

        </>
    );
}
