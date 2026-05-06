import { useState } from 'react';
import type { EventSuggestion, CalendarSetting } from '../types';
import { syncSuggestionToGoogle } from '../api';
import SuggestionReviewModal from './SuggestionReviewModal';
import AdminEventDetailPanel from './AdminEventDetailPanel';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    suggestions: EventSuggestion[];
    calendars: CalendarSetting[];
    onUpdated: (s: EventSuggestion) => void;
    onRefresh?: () => void;
}

const TABS = ['all', 'pending', 'approved', 'rejected'] as const;
type Tab = typeof TABS[number];

export default function SuggestionsPanel({ isOpen, onClose, suggestions, calendars, onUpdated, onRefresh }: Props) {
    const [activeTab, setActiveTab] = useState<Tab>('pending');
    const [reviewingSuggestion, setReviewingSuggestion] = useState<EventSuggestion | null>(null);
    const [adminDetailEventId, setAdminDetailEventId] = useState<string | null>(null);
    const [syncingId, setSyncingId] = useState<string | null>(null);

    const handleSync = async (s: EventSuggestion) => {
        setSyncingId(s.id);
        try {
            const updated = await syncSuggestionToGoogle(s.id);
            onUpdated(updated);
        } catch {
            // surface via badge — no red
        } finally {
            setSyncingId(null);
        }
    };

    const filtered = activeTab === 'all'
        ? suggestions
        : suggestions.filter((s) => s.status === activeTab);

    const counts: Record<Tab, number> = {
        all: suggestions.length,
        pending: suggestions.filter((s) => s.status === 'pending').length,
        approved: suggestions.filter((s) => s.status === 'approved').length,
        rejected: suggestions.filter((s) => s.status === 'rejected').length,
    };

    const statusBadge = (status: string) => {
        const colors: Record<string, string> = {
            pending: 'bg-amber-100 text-amber-700',
            approved: 'bg-emerald-100 text-emerald-700',
            rejected: 'bg-slate-200 text-slate-700',
        };
        return (
            <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 ${colors[status] ?? 'bg-gray-100 text-gray-600'}`}>
                {status}
            </span>
        );
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
                        {onRefresh && (
                            <button
                                onClick={onRefresh}
                                className="text-gray-400 hover:text-gray-600 p-1"
                                title="Refresh"
                                aria-label="Refresh"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                    <polyline points="23 4 23 10 17 10" />
                                    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                                </svg>
                            </button>
                        )}
                        <h2 className="text-xs font-semibold text-gray-800 uppercase tracking-wide">Suggestions</h2>
                        {counts.pending > 0 && (
                            <span className="inline-flex items-center justify-center bg-blue-600 text-white text-[10px] font-semibold px-1.5 py-0.5 min-w-[18px]">
                                {counts.pending}
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

                {/* Tabs */}
                <div className="flex border-b border-gray-200">
                    {TABS.map((tab) => (
                        <button
                            key={tab}
                            onClick={() => setActiveTab(tab)}
                            className={`flex-1 py-2 text-[11px] font-medium capitalize transition border-b-2 ${activeTab === tab
                                ? 'border-blue-600 text-blue-700'
                                : 'border-transparent text-gray-400 hover:text-gray-600'
                                }`}
                        >
                            {tab} ({counts[tab]})
                        </button>
                    ))}
                </div>

                {/* List */}
                <div className="overflow-y-auto" style={{ height: 'calc(100% - 90px)' }}>
                    {filtered.length === 0 ? (
                        <p className="text-center text-[11px] text-gray-400 mt-8">No suggestions</p>
                    ) : (
                        <ul className="divide-y divide-gray-100">
                            {filtered.map((s) => {
                                const isApproved = s.status === 'approved';
                                const needsSync = isApproved && !s.synced_to_google;
                                return (
                                    <li
                                        key={s.id}
                                        className="px-4 py-3 hover:bg-gray-50 cursor-pointer transition"
                                        onClick={() => setReviewingSuggestion(s)}
                                    >
                                        <div className="flex items-start justify-between gap-2">
                                            <div className="min-w-0 flex-1">
                                                <p className="text-[12px] font-medium text-gray-800 truncate">{s.title}</p>
                                                <p className="text-[10px] text-gray-400 mt-0.5">
                                                    {fmtDate(s.start)}
                                                    {s.submitter_name && ` • ${s.submitter_name}`}
                                                </p>
                                            </div>
                                            <div className="flex items-center gap-1.5 shrink-0">
                                                {statusBadge(s.status)}
                                            </div>
                                        </div>
                                        {isApproved && s.created_event_id && (
                                            <div className="mt-2 flex items-center gap-2">
                                                <button
                                                    onClick={(e) => { e.stopPropagation(); setAdminDetailEventId(s.created_event_id!); }}
                                                    className="text-[10px] font-medium text-blue-700 hover:text-blue-900 hover:underline"
                                                    title="View linked event"
                                                >
                                                    Open created event →
                                                </button>
                                                {needsSync && (
                                                    <button
                                                        onClick={(e) => { e.stopPropagation(); handleSync(s); }}
                                                        disabled={syncingId === s.id}
                                                        className="bg-blue-600 text-white text-[10px] font-medium px-2 py-0.5 hover:bg-blue-700 disabled:opacity-50 transition"
                                                        title="Sync this event back to Google Calendar"
                                                    >
                                                        {syncingId === s.id ? 'Syncing…' : 'Sync to Google'}
                                                    </button>
                                                )}
                                                {isApproved && s.synced_to_google && (
                                                    <span className="text-[10px] text-emerald-600">✓ Synced</span>
                                                )}
                                            </div>
                                        )}
                                    </li>
                                );
                            })}
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
            <AdminEventDetailPanel
                eventId={adminDetailEventId}
                onClose={() => setAdminDetailEventId(null)}
            />
        </>
    );
}
