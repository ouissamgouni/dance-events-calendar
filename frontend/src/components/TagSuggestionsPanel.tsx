import { useState, useEffect, useCallback } from 'react';
import type { TagSuggestionResponse, TagGroup } from '../types';
import { fetchAdminTagSuggestions, fetchTagGroups } from '../api';
import TagSuggestionReviewModal from './TagSuggestionReviewModal';
import AdminEventDetailPanel from './AdminEventDetailPanel';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    onCountChange: (count: number) => void;
}

const TABS = ['all', 'pending', 'approved', 'rejected'] as const;
type Tab = typeof TABS[number];

export default function TagSuggestionsPanel({ isOpen, onClose, onCountChange }: Props) {
    const [suggestions, setSuggestions] = useState<TagSuggestionResponse[]>([]);
    const [tagGroups, setTagGroups] = useState<TagGroup[]>([]);
    const [activeTab, setActiveTab] = useState<Tab>('pending');
    const [loading, setLoading] = useState(false);
    const [reviewing, setReviewing] = useState<TagSuggestionResponse | null>(null);
    const [adminDetailEventId, setAdminDetailEventId] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const [s, g] = await Promise.all([
                fetchAdminTagSuggestions(),
                fetchTagGroups(),
            ]);
            setSuggestions(s);
            setTagGroups(g);
            onCountChange(s.filter((x) => x.status === 'pending').length);
        } catch {
            // silently fail
        } finally {
            setLoading(false);
        }
    }, [onCountChange]);

    useEffect(() => {
        if (isOpen) load();
    }, [isOpen, load]);

    const counts: Record<Tab, number> = {
        all: suggestions.length,
        pending: suggestions.filter((s) => s.status === 'pending').length,
        approved: suggestions.filter((s) => s.status === 'approved').length,
        rejected: suggestions.filter((s) => s.status === 'rejected').length,
    };

    const filtered = activeTab === 'all'
        ? suggestions
        : suggestions.filter((s) => s.status === activeTab);

    const statusBadge = (status: string) => {
        const colors: Record<string, string> = {
            pending: 'bg-amber-100 text-amber-700',
            approved: 'bg-emerald-100 text-emerald-700',
            rejected: 'bg-red-100 text-red-700',
        };
        return (
            <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded ${colors[status] ?? 'bg-gray-100 text-gray-600'}`}>
                {status}
            </span>
        );
    };

    const allTags = tagGroups.flatMap((g) =>
        g.tags.map((t) => ({ ...t, groupLabel: g.label, groupId: g.id }))
    );

    return (
        <>
            {isOpen && (
                <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} />
            )}

            <div
                className={`fixed top-0 right-0 h-full w-[420px] bg-white shadow-lg border-l border-gray-200 z-50 transform transition-transform duration-200 ease-in-out ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-200 bg-gray-50">
                    <div className="flex items-center gap-2">
                        <button
                            onClick={load}
                            className={`text-gray-400 hover:text-gray-600 p-1 transition-transform ${loading ? 'animate-spin' : ''}`}
                            title="Refresh"
                            aria-label="Refresh"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="23 4 23 10 17 10" />
                                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                            </svg>
                        </button>
                        <h2 className="text-xs font-semibold text-gray-800 uppercase tracking-wide">Tag Suggestions</h2>
                        {counts.pending > 0 && (
                            <span className="inline-flex items-center justify-center bg-violet-500 text-white text-[10px] font-semibold px-1.5 py-0.5 min-w-[18px] rounded">
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
                                ? 'border-violet-500 text-violet-600'
                                : 'border-transparent text-gray-400 hover:text-gray-600'
                                }`}
                        >
                            {tab} ({counts[tab]})
                        </button>
                    ))}
                </div>

                {/* List */}
                <div className="overflow-y-auto" style={{ height: 'calc(100% - 90px)' }}>
                    {loading ? (
                        <p className="text-center text-[11px] text-gray-400 mt-8">Loading…</p>
                    ) : filtered.length === 0 ? (
                        <p className="text-center text-[11px] text-gray-400 mt-8">No suggestions</p>
                    ) : (
                        <ul className="divide-y divide-gray-100">
                            {filtered.map((s) => (
                                <li
                                    key={s.id}
                                    className="px-4 py-3 hover:bg-gray-50 cursor-pointer transition"
                                    onClick={() => setReviewing(s)}
                                >
                                    <div className="flex items-start justify-between gap-2">
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-center gap-1.5">
                                                <p className="text-[12px] font-medium text-gray-800 truncate">
                                                    {s.event_title || s.event_id}
                                                </p>
                                                <button
                                                    onClick={(e) => { e.stopPropagation(); setAdminDetailEventId(s.event_id); }}
                                                    className="text-[10px] font-mono text-rose-500 hover:text-rose-700 hover:underline shrink-0"
                                                    title="View event details"
                                                >
                                                    #{s.event_id.slice(0, 8)}
                                                </button>
                                            </div>
                                            {s.tag ? (
                                                <span
                                                    className="inline-block rounded-full px-2 py-0.5 text-[10px] mt-1"
                                                    style={{
                                                        backgroundColor: `${s.tag.group_color ?? s.tag.color ?? '#6b7280'}20`,
                                                        color: s.tag.group_color ?? s.tag.color ?? '#6b7280',
                                                    }}
                                                >
                                                    {s.tag.group_label}: {s.tag.label}
                                                </span>
                                            ) : s.free_text ? (
                                                <p className="text-gray-400 text-[10px] mt-1 italic">&ldquo;{s.free_text}&rdquo;</p>
                                            ) : null}
                                            <p className="text-gray-400 text-[10px] mt-1">
                                                {new Date(s.created_at).toLocaleDateString()}
                                            </p>
                                        </div>
                                        {statusBadge(s.status)}
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </div>

            {reviewing && (
                <TagSuggestionReviewModal
                    suggestion={reviewing}
                    allTags={allTags}
                    tagGroups={tagGroups}
                    onClose={() => setReviewing(null)}
                    onUpdated={(updated) => {
                        setSuggestions((prev) =>
                            prev.map((s) => (s.id === updated.id ? updated : s)),
                        );
                        setReviewing(updated);
                        onCountChange(
                            suggestions
                                .map((s) => (s.id === updated.id ? updated : s))
                                .filter((s) => s.status === 'pending').length
                        );
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
