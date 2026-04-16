import { useState } from 'react';
import type { EventSuggestion, CalendarSetting } from '../types';
import { syncSuggestionToGoogle } from '../api';
import SuggestionReviewModal from './SuggestionReviewModal';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    suggestions: EventSuggestion[];
    calendars: CalendarSetting[];
    onUpdated: (s: EventSuggestion) => void;
}

export default function UnsyncedSuggestionsPanel({ isOpen, onClose, suggestions, calendars, onUpdated }: Props) {
    const [syncingId, setSyncingId] = useState<string | null>(null);
    const [error, setError] = useState('');
    const [reviewingSuggestion, setReviewingSuggestion] = useState<EventSuggestion | null>(null);

    const unsynced = suggestions.filter((s) => s.status === 'approved' && !s.synced_to_google);

    const handleSync = async (s: EventSuggestion) => {
        setSyncingId(s.id);
        setError('');
        try {
            const updated = await syncSuggestionToGoogle(s.id);
            onUpdated(updated);
        } catch (err: any) {
            setError(err.message || 'Sync failed');
        } finally {
            setSyncingId(null);
        }
    };

    const fmtDate = (iso: string) => {
        try { return new Date(iso).toLocaleDateString(); } catch { return iso; }
    };

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
                        <h2 className="text-xs font-semibold text-gray-800 uppercase tracking-wide">Unsynced to Google</h2>
                        {unsynced.length > 0 && (
                            <span className="inline-flex items-center justify-center bg-orange-500 text-white text-[10px] font-semibold px-1.5 py-0.5 min-w-[18px]">
                                {unsynced.length}
                            </span>
                        )}
                    </div>
                    <button
                        onClick={onClose}
                        className="text-gray-400 hover:text-gray-600 text-sm leading-none p-1"
                        aria-label="Close"
                    >
                        ✕
                    </button>
                </div>

                {error && (
                    <div className="px-4 py-2 bg-red-50 border-b border-red-100 text-[11px] text-red-600">{error}</div>
                )}

                <div className="overflow-y-auto" style={{ height: 'calc(100% - 48px)' }}>
                    {unsynced.length === 0 ? (
                        <div className="text-center mt-12 px-4">
                            <p className="text-[11px] text-gray-400">All approved suggestions are synced</p>
                        </div>
                    ) : (
                        <ul className="divide-y divide-gray-100">
                            {unsynced.map((s) => (
                                <li key={s.id} className="px-4 py-3 hover:bg-gray-50 transition">
                                    <div className="flex items-start justify-between gap-2">
                                        <div
                                            className="min-w-0 cursor-pointer flex-1"
                                            onClick={() => setReviewingSuggestion(s)}
                                        >
                                            <p className="text-[12px] font-medium text-gray-800 truncate">{s.title}</p>
                                            <p className="text-[10px] text-gray-400 mt-0.5">
                                                {fmtDate(s.start)}
                                                {s.assigned_calendar_id && ` • ${s.assigned_calendar_id}`}
                                            </p>
                                        </div>
                                        <button
                                            onClick={() => handleSync(s)}
                                            disabled={syncingId === s.id}
                                            className="shrink-0 bg-blue-600 text-white text-[10px] font-medium px-2.5 py-1 hover:bg-blue-700 disabled:opacity-50 transition"
                                        >
                                            {syncingId === s.id ? 'Syncing…' : 'Sync'}
                                        </button>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </div>

            {reviewingSuggestion && (
                <SuggestionReviewModal
                    suggestion={reviewingSuggestion}
                    calendars={calendars}
                    onClose={() => setReviewingSuggestion(null)}
                    onUpdated={(updated) => {
                        setReviewingSuggestion(updated);
                        onUpdated(updated);
                    }}
                />
            )}
        </>
    );
}
