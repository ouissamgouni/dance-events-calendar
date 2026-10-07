import { useState } from 'react';
import useBackToClose from '../hooks/useBackToClose';
import type { EventSuggestion } from '../types';
import { syncSuggestionToGoogle } from '../api';
import AdminEventDetailPanel from './AdminEventDetailPanel';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    suggestions: EventSuggestion[];
    onUpdated: (s: EventSuggestion) => void;
    onRefresh?: () => void;
}

export default function UnsyncedSuggestionsPanel({ isOpen, onClose, suggestions, onUpdated, onRefresh }: Props) {
    useBackToClose(onClose, isOpen);
    const [syncingId, setSyncingId] = useState<string | null>(null);
    const [error, setError] = useState('');
    const [adminDetailEventId, setAdminDetailEventId] = useState<string | null>(null);

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
                className={`fixed top-0 right-0 h-full w-full sm:w-[420px] bg-surface shadow-lg sm:border-l border-line z-50 flex flex-col transform transition-transform duration-200 ease-in-out ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}
            >
                <div className="flex shrink-0 items-center justify-between px-4 py-2.5 border-b border-line bg-canvas" style={{ paddingTop: 'max(0.625rem, env(safe-area-inset-top))' }}>
                    <div className="flex items-center gap-2">
                        {onRefresh && (
                            <button
                                onClick={onRefresh}
                                className="text-muted hover:text-ink-soft p-1"
                                title="Refresh"
                                aria-label="Refresh"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                    <polyline points="23 4 23 10 17 10" />
                                    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                                </svg>
                            </button>
                        )}
                        <h2 className="text-xs font-semibold text-ink uppercase tracking-wide">Unsynced to Google</h2>
                        {unsynced.length > 0 && (
                            <span className="inline-flex items-center justify-center bg-orange-500 text-white text-[10px] font-semibold px-1.5 py-0.5 min-w-[18px]">
                                {unsynced.length}
                            </span>
                        )}
                    </div>
                    <button
                        onClick={onClose}
                        className="min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 text-muted hover:text-ink-soft text-sm leading-none p-1"
                        aria-label="Close"
                    >
                        ✕
                    </button>
                </div>

                {error && (
                    <div className="shrink-0 px-4 py-2 bg-red-50 border-b border-red-100 text-[11px] text-danger">{error}</div>
                )}

                <div className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
                    {unsynced.length === 0 ? (
                        <div className="text-center mt-12 px-4">
                            <p className="text-[11px] text-muted">All approved suggestions are synced</p>
                        </div>
                    ) : (
                        <ul className="divide-y divide-gray-100">
                            {unsynced.map((s) => (
                                <li key={s.id} className="px-4 py-3 hover:bg-canvas transition">
                                    <div className="flex items-start justify-between gap-2">
                                        <div
                                            className="min-w-0 cursor-pointer flex-1"
                                            onClick={() => s.created_event_id && setAdminDetailEventId(s.created_event_id)}
                                        >
                                            <p className="text-[12px] font-medium text-ink truncate">{s.title}</p>
                                            <p className="text-[10px] text-muted mt-0.5">
                                                {fmtDate(s.start)}
                                                {s.assigned_calendar_id && ` • ${s.assigned_calendar_id}`}
                                            </p>
                                        </div>
                                        <button
                                            onClick={() => handleSync(s)}
                                            disabled={syncingId === s.id}
                                            className="shrink-0 bg-action text-white text-[10px] font-medium px-2.5 py-1 hover:bg-action-strong disabled:opacity-50 transition"
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

            <AdminEventDetailPanel
                eventId={adminDetailEventId}
                onClose={() => setAdminDetailEventId(null)}
                onEventUpdated={() => onRefresh?.()}
            />
        </>
    );
}
