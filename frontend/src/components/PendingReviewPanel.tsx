import type { CalendarEvent } from '../types';
import EventEditModal from './EventEditModal';
import LocationBadge from './LocationBadge';
import { useState } from 'react';

interface PendingReviewPanelProps {
    isOpen: boolean;
    onClose: () => void;
    pendingEvents: CalendarEvent[];
    onReview: (eventId: string) => void;
    onMarkAllReviewed: () => void;
    onEventSaved: (updated: CalendarEvent) => void;
    busy: string;
}

export default function PendingReviewPanel({
    isOpen,
    onClose,
    pendingEvents,
    onReview,
    onMarkAllReviewed,
    onEventSaved,
    busy,
}: PendingReviewPanelProps) {
    const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null);

    return (
        <>
            {isOpen && (
                <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} />
            )}

            <div
                className={`fixed top-0 right-0 h-full w-[420px] bg-white shadow-lg border-l border-gray-200 z-50 transform transition-transform duration-200 ease-in-out ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}
            >
                <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-200 bg-gray-50">
                    <div className="flex items-center gap-2">
                        <h2 className="text-xs font-semibold text-gray-800 uppercase tracking-wide">Pending Review</h2>
                        {pendingEvents.length > 0 && (
                            <span className="inline-flex items-center justify-center bg-amber-500 text-white text-[10px] font-semibold px-1.5 py-0.5 min-w-[18px]">
                                {pendingEvents.length}
                            </span>
                        )}
                    </div>
                    <div className="flex items-center gap-2">
                        {pendingEvents.length > 0 && (
                            <button
                                onClick={onMarkAllReviewed}
                                disabled={busy === 'review-all'}
                                className="bg-gray-800 text-white text-[11px] font-medium px-2.5 py-1 hover:bg-gray-700 disabled:opacity-50 transition"
                            >
                                {busy === 'review-all' ? 'Marking…' : 'Approve All'}
                            </button>
                        )}
                        <button
                            onClick={onClose}
                            className="text-gray-400 hover:text-gray-600 text-sm leading-none p-1"
                            aria-label="Close"
                        >
                            ✕
                        </button>
                    </div>
                </div>

                <div className="overflow-y-auto h-[calc(100%-41px)] divide-y divide-gray-100">
                    {pendingEvents.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-full text-gray-400">
                            <p className="text-xs">No events pending review</p>
                        </div>
                    ) : (
                        pendingEvents.map((evt) => (
                            <div key={evt.event_id} className="px-4 py-2.5 hover:bg-gray-50/50 transition">
                                <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0 flex-1">
                                        <p className="text-xs font-medium text-gray-800 truncate">{evt.title}</p>
                                        <div className="flex items-center gap-1 mt-0.5">
                                            <LocationBadge location={evt.location} latitude={evt.latitude} longitude={evt.longitude} />
                                            {evt.location && (
                                                <p className="text-[11px] text-gray-400 truncate">{evt.location}</p>
                                            )}
                                        </div>
                                        <p className="text-[11px] text-gray-400 mt-0.5">
                                            {new Date(evt.start).toLocaleDateString()} – {new Date(evt.end).toLocaleDateString()}
                                        </p>
                                    </div>
                                    <div className="flex gap-1 shrink-0 pt-0.5">
                                        <button
                                            onClick={() => setEditingEvent(evt)}
                                            className="bg-gray-100 text-gray-600 text-[11px] font-medium px-2 py-1 hover:bg-gray-200 transition"
                                        >
                                            Edit
                                        </button>
                                        <button
                                            onClick={() => onReview(evt.event_id)}
                                            className="bg-emerald-600 text-white text-[11px] font-medium px-2 py-1 hover:bg-emerald-700 transition"
                                        >
                                            ✓ OK
                                        </button>
                                    </div>
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </div>

            {editingEvent && (
                <EventEditModal
                    event={editingEvent}
                    onClose={() => setEditingEvent(null)}
                    onSaved={(updated) => {
                        onEventSaved(updated);
                        setEditingEvent(null);
                    }}
                />
            )}
        </>
    );
}
