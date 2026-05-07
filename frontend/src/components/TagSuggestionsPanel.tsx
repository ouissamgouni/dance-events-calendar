import { useState, useEffect, useCallback, useMemo } from 'react';
import type { TagSuggestionResponse, TagGroup } from '../types';
import {
    approveTagSuggestion,
    bulkReviewTagSuggestions,
    fetchAdminEventIds,
    fetchAdminTagSuggestions,
    fetchTagGroups,
    rejectTagSuggestion,
    runTagSuggestionsBulk,
} from '../api';
import TagSuggestionReviewModal from './TagSuggestionReviewModal';
import AdminEventDetailPanel from './AdminEventDetailPanel';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    onCountChange: (count: number) => void;
}

const TABS = ['all', 'pending', 'approved', 'rejected'] as const;
type Tab = typeof TABS[number];

const SOURCE_FILTERS = ['all', 'user', 'auto'] as const;
type SourceFilter = typeof SOURCE_FILTERS[number];

export default function TagSuggestionsPanel({ isOpen, onClose, onCountChange }: Props) {
    const [suggestions, setSuggestions] = useState<TagSuggestionResponse[]>([]);
    const [tagGroups, setTagGroups] = useState<TagGroup[]>([]);
    const [activeTab, setActiveTab] = useState<Tab>('pending');
    const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
    const [loading, setLoading] = useState(false);
    const [reviewing, setReviewing] = useState<TagSuggestionResponse | null>(null);
    const [adminDetailEventId, setAdminDetailEventId] = useState<string | null>(null);
    const [actionInFlight, setActionInFlight] = useState<number | null>(null);
    const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
    const [bulkBusy, setBulkBusy] = useState(false);
    const [runUpcomingBusy, setRunUpcomingBusy] = useState(false);
    const [banner, setBanner] = useState<string | null>(null);

    const applyStatusUpdate = useCallback((id: number, status: 'approved' | 'rejected') => {
        setSuggestions((prev) => {
            const next = prev.map((s) => (s.id === id ? { ...s, status } : s));
            onCountChange(next.filter((x) => x.status === 'pending').length);
            return next;
        });
    }, [onCountChange]);

    const handleQuickApprove = async (s: TagSuggestionResponse) => {
        if (actionInFlight) return;
        setActionInFlight(s.id);
        try {
            await approveTagSuggestion(s.id);
            applyStatusUpdate(s.id, 'approved');
        } catch {
            // surface via list refresh
            load();
        } finally {
            setActionInFlight(null);
        }
    };

    const handleQuickReject = async (s: TagSuggestionResponse) => {
        if (actionInFlight) return;
        setActionInFlight(s.id);
        try {
            await rejectTagSuggestion(s.id);
            applyStatusUpdate(s.id, 'rejected');
        } catch {
            load();
        } finally {
            setActionInFlight(null);
        }
    };

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

    const filtered = suggestions.filter((s) => {
        if (activeTab !== 'all' && s.status !== activeTab) return false;
        if (sourceFilter === 'user' && s.source && s.source !== 'user') return false;
        if (sourceFilter === 'auto' && s.source !== 'heuristic') return false;
        return true;
    });

    // Only pending rows are bulk-selectable.
    const bulkable = useMemo(
        () => filtered.filter((s) => s.status === 'pending'),
        [filtered],
    );
    const allBulkableSelected = bulkable.length > 0 && bulkable.every((s) => selectedIds.has(s.id));

    // Reset selection when filters change.
    useEffect(() => {
        setSelectedIds(new Set());
    }, [activeTab, sourceFilter, isOpen]);

    const toggleSelect = (id: number) => {
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const toggleSelectAll = () => {
        setSelectedIds((prev) => {
            if (allBulkableSelected) return new Set();
            const next = new Set(prev);
            bulkable.forEach((s) => next.add(s.id));
            return next;
        });
    };

    const handleBulk = async (action: 'approve' | 'reject') => {
        const ids = Array.from(selectedIds);
        if (ids.length === 0 || bulkBusy) return;
        setBulkBusy(true);
        setBanner(null);
        const status = action === 'approve' ? 'approved' : 'rejected';
        try {
            const { ok, skipped } = await bulkReviewTagSuggestions(ids, action);
            // Apply optimistic update for the ids that weren't skipped.
            // We don't know exactly which ones were skipped (free-text), so
            // update all selected and let a refresh correct any discrepancy.
            ids.forEach((id) => applyStatusUpdate(id, status));
            setSelectedIds(new Set());
            setBanner(
                skipped > 0
                    ? `${action === 'approve' ? 'Approved' : 'Rejected'} ${ok} suggestion${ok === 1 ? '' : 's'} (${skipped} skipped — need manual review).`
                    : `${action === 'approve' ? 'Approved' : 'Rejected'} ${ok} suggestion${ok === 1 ? '' : 's'}.`,
            );
            if (skipped > 0) load();
        } catch {
            setBanner(`Failed to ${action} suggestions.`);
            load();
        } finally {
            setBulkBusy(false);
        }
    };

    const handleRunOnUpcoming = async () => {
        if (runUpcomingBusy) return;
        setRunUpcomingBusy(true);
        setBanner(null);
        try {
            const { ids } = await fetchAdminEventIds({ future_only: true });
            if (ids.length === 0) {
                setBanner('No upcoming events to process.');
                return;
            }
            // Backend caps at 200 per call — chunk if larger.
            const CHUNK = 200;
            let totalGenerated = 0;
            let totalProcessed = 0;
            for (let i = 0; i < ids.length; i += CHUNK) {
                const chunk = ids.slice(i, i + CHUNK);
                const res = await runTagSuggestionsBulk(chunk, { replaceExistingPending: false });
                totalGenerated += res.generated;
                totalProcessed += res.events_processed;
            }
            setBanner(
                `Ran on ${totalProcessed} upcoming event${totalProcessed === 1 ? '' : 's'} — ${totalGenerated} new suggestion${totalGenerated === 1 ? '' : 's'} generated.`,
            );
            await load();
        } catch (e) {
            setBanner((e as Error).message || 'Failed to run on upcoming events.');
        } finally {
            setRunUpcomingBusy(false);
        }
    };

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
                className={`fixed top-0 right-0 h-full w-[680px] max-w-[95vw] bg-white shadow-lg border-l border-gray-200 z-50 flex flex-col transform transition-transform duration-200 ease-in-out ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}
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
                    <div className="flex items-center gap-1">
                        <button
                            onClick={handleRunOnUpcoming}
                            disabled={runUpcomingBusy}
                            className="text-[10px] font-semibold uppercase tracking-wide bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-40 px-2 py-1"
                            title="Run heuristic auto-suggester on all upcoming events"
                        >
                            {runUpcomingBusy ? 'Running…' : 'Run on upcoming'}
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

                {/* Source filter chips: separates user-submitted suggestions
                    from those generated by the heuristic stage. */}
                <div className="flex items-center gap-1 px-3 py-1.5 border-b border-gray-100 bg-gray-50">
                    <span className="text-[10px] uppercase tracking-wide text-gray-400 mr-1">Source</span>
                    {SOURCE_FILTERS.map((sf) => (
                        <button
                            key={sf}
                            onClick={() => setSourceFilter(sf)}
                            className={`text-[10px] uppercase font-medium px-2 py-0.5 transition ${sourceFilter === sf
                                ? 'bg-violet-100 text-violet-700'
                                : 'text-gray-400 hover:text-gray-600'
                                }`}
                        >
                            {sf}
                        </button>
                    ))}
                </div>

                {/* Bulk-action bar — only when there are pending rows visible. */}
                {bulkable.length > 0 && (
                    <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-gray-100 bg-white">
                        <label className="flex items-center gap-1.5 text-[10px] text-slate-600 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={allBulkableSelected}
                                onChange={toggleSelectAll}
                                className="accent-sky-600"
                            />
                            {selectedIds.size > 0 ? `${selectedIds.size} selected` : 'Select all'}
                        </label>
                        <div className="flex items-center gap-1">
                            <button
                                onClick={() => handleBulk('approve')}
                                disabled={selectedIds.size === 0 || bulkBusy}
                                className="text-[10px] font-semibold uppercase px-2 py-0.5 bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-40"
                            >
                                {bulkBusy ? '…' : 'Approve'}
                            </button>
                            <button
                                onClick={() => handleBulk('reject')}
                                disabled={selectedIds.size === 0 || bulkBusy}
                                className="text-[10px] font-semibold uppercase px-2 py-0.5 bg-slate-200 text-slate-700 hover:bg-slate-300 disabled:opacity-40"
                            >
                                {bulkBusy ? '…' : 'Reject'}
                            </button>
                        </div>
                    </div>
                )}

                {banner && (
                    <p className="px-3 py-1.5 text-[10px] text-slate-600 bg-sky-50 border-b border-sky-100">
                        {banner}
                    </p>
                )}

                {/* List */}
                <div className="overflow-y-auto flex-1">
                    {loading ? (
                        <p className="text-center text-[11px] text-gray-400 mt-8">Loading…</p>
                    ) : filtered.length === 0 ? (
                        <p className="text-center text-[11px] text-gray-400 mt-8">No suggestions</p>
                    ) : (
                        <table className="w-full text-[12px] table-fixed">
                            <colgroup>
                                <col className="w-7" />
                                <col className="w-[68px]" />
                                <col />
                                <col className="w-[88px]" />
                                <col className="w-[140px]" />
                                <col className="w-[64px]" />
                                <col className="w-[56px]" />
                            </colgroup>
                            <thead className="sticky top-0 bg-gray-50 text-[10px] uppercase text-gray-400 tracking-wide">
                                <tr>
                                    <th className="px-2 py-1.5"></th>
                                    <th className="px-2 py-1.5 text-left font-medium">ID</th>
                                    <th className="px-2 py-1.5 text-left font-medium">Event</th>
                                    <th className="px-2 py-1.5 text-left font-medium">Date</th>
                                    <th className="px-2 py-1.5 text-left font-medium">Tag</th>
                                    <th className="px-2 py-1.5 text-left font-medium">Status</th>
                                    <th className="px-2 py-1.5"></th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100">
                                {filtered.map((s) => (
                                    <tr
                                        key={s.id}
                                        className="hover:bg-gray-50 cursor-pointer transition"
                                        onClick={() => setReviewing(s)}
                                    >
                                        <td className="px-2 py-1.5 align-middle">
                                            {s.status === 'pending' ? (
                                                <input
                                                    type="checkbox"
                                                    checked={selectedIds.has(s.id)}
                                                    onChange={(e) => { e.stopPropagation(); toggleSelect(s.id); }}
                                                    onClick={(e) => e.stopPropagation()}
                                                    className="accent-sky-600"
                                                    aria-label="Select suggestion"
                                                />
                                            ) : null}
                                        </td>
                                        <td className="px-2 py-1.5 align-middle">
                                            <button
                                                onClick={(e) => { e.stopPropagation(); setAdminDetailEventId(s.event_id); }}
                                                className="text-[10px] font-mono text-slate-500 hover:text-slate-700 hover:underline whitespace-nowrap"
                                                title={`View event ${s.event_id}`}
                                            >
                                                #{s.event_id.slice(0, 8)}
                                            </button>
                                        </td>
                                        <td className="px-2 py-1.5 align-middle">
                                            <p className="font-medium text-gray-800 truncate" title={s.event_title || s.event_id}>
                                                {s.event_title || s.event_id}
                                            </p>
                                        </td>
                                        <td className="px-2 py-1.5 align-middle text-gray-400 text-[10px] whitespace-nowrap">
                                            {new Date(s.created_at).toLocaleDateString()}
                                            {s.source === 'heuristic' && (
                                                <span className="block text-emerald-600 leading-none">
                                                    Auto{typeof s.confidence === 'number' && (
                                                        <span className="tabular-nums ml-0.5">{Math.round(s.confidence * 100)}%</span>
                                                    )}
                                                </span>
                                            )}
                                        </td>

                                        <td className="px-2 py-1.5 align-middle">
                                            {s.tag ? (
                                                <span
                                                    className="inline-block rounded-full px-2 py-0.5 text-[10px] truncate max-w-full"
                                                    style={{
                                                        backgroundColor: `${s.tag.group_color ?? s.tag.color ?? '#6b7280'}20`,
                                                        color: s.tag.group_color ?? s.tag.color ?? '#6b7280',
                                                    }}
                                                    title={`${s.tag.group_label}: ${s.tag.label}`}
                                                >
                                                    {s.tag.group_label}: {s.tag.label}
                                                </span>
                                            ) : s.free_text ? (
                                                <span className="text-gray-400 text-[10px] italic truncate inline-block max-w-full" title={s.free_text}>
                                                    &ldquo;{s.free_text}&rdquo;
                                                </span>
                                            ) : (
                                                <span className="text-gray-300 text-[10px]">—</span>
                                            )}
                                        </td>
                                        <td className="px-2 py-1.5 align-middle">
                                            {statusBadge(s.status)}
                                        </td>
                                        <td className="pl-4 pr-2 py-1.5 align-middle">
                                            {s.status === 'pending' && (
                                                <div className="flex items-center gap-0.5 justify-end">
                                                    {s.tag && (
                                                        <button
                                                            onClick={(e) => { e.stopPropagation(); handleQuickApprove(s); }}
                                                            disabled={actionInFlight === s.id}
                                                            className="text-[10px] font-semibold uppercase px-1.5 py-0.5 bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-50"
                                                            title="Approve suggestion"
                                                        >
                                                            ✓
                                                        </button>
                                                    )}
                                                    <button
                                                        onClick={(e) => { e.stopPropagation(); handleQuickReject(s); }}
                                                        disabled={actionInFlight === s.id}
                                                        className="text-[10px] font-semibold uppercase px-1.5 py-0.5 bg-slate-200 text-slate-700 hover:bg-slate-300 disabled:opacity-50"
                                                        title="Reject suggestion"
                                                    >
                                                        ✕
                                                    </button>
                                                </div>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
            </div>

            {reviewing && (
                <TagSuggestionReviewModal
                    suggestion={reviewing}
                    allTags={allTags}
                    tagGroups={tagGroups}
                    onClose={() => setReviewing(null)}
                    onViewEvent={(eventId) => setAdminDetailEventId(eventId)}
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
