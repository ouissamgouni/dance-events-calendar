import { useState, useEffect, useCallback } from 'react';
import type { AdminRating } from '../types';
import { fetchAdminRatings } from '../api';
import RatingReviewModal from './RatingReviewModal';
import AdminEventDetailPanel from './AdminEventDetailPanel';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    onCountChange: (pendingCount: number) => void;
}

const TABS = ['all', 'pending', 'approved', 'rejected'] as const;
type Tab = typeof TABS[number];

const PAGE_SIZES = [25, 50, 100] as const;

export default function FeedbackPanel({ isOpen, onClose, onCountChange }: Props) {
    const [items, setItems] = useState<AdminRating[]>([]);
    const [total, setTotal] = useState(0);
    const [pendingTotal, setPendingTotal] = useState(0);
    const [activeTab, setActiveTab] = useState<Tab>('pending');
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState<number>(25);
    const [loading, setLoading] = useState(false);
    const [reviewing, setReviewing] = useState<AdminRating | null>(null);
    const [adminDetailEventId, setAdminDetailEventId] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetchAdminRatings({
                status: activeTab === 'all' ? undefined : activeTab,
                page,
                pageSize: pageSize,
            });
            setItems(res.items);
            setTotal(res.total);
            if (activeTab === 'pending') {
                setPendingTotal(res.total);
                onCountChange(res.total);
            } else {
                const pendingRes = await fetchAdminRatings({ status: 'pending', page: 1, pageSize: 1 });
                setPendingTotal(pendingRes.total);
                onCountChange(pendingRes.total);
            }
        } catch {
            // silent
        } finally {
            setLoading(false);
        }
    }, [activeTab, page, pageSize, onCountChange]);

    useEffect(() => {
        if (isOpen) load();
    }, [isOpen, load]);

    useEffect(() => {
        setPage(1);
    }, [activeTab, pageSize]);

    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    const statusBadge = (status: string) => {
        const colors: Record<string, string> = {
            pending: 'bg-amber-50 text-amber-700 border-amber-200',
            approved: 'bg-sky-50 text-sky-700 border-sky-200',
            rejected: 'bg-slate-100 text-slate-600 border-slate-300',
        };
        return (
            <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 border ${colors[status] ?? 'bg-slate-100 text-slate-600 border-slate-300'}`}>
                {status}
            </span>
        );
    };

    return (
        <>
            {isOpen && <div className="fixed inset-0 bg-slate-900/20 z-40" onClick={onClose} />}

            <div
                className={`fixed top-0 right-0 h-full w-[420px] bg-white shadow-lg border-l border-slate-200 z-50 transform transition-transform duration-200 ease-in-out ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-3 py-2 border-b border-slate-200 bg-slate-50">
                    <div className="flex items-center gap-2">
                        <button
                            onClick={load}
                            className={`text-slate-400 hover:text-slate-700 p-1 transition-transform ${loading ? 'animate-spin' : ''}`}
                            title="Refresh"
                            aria-label="Refresh"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="23 4 23 10 17 10" />
                                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                            </svg>
                        </button>
                        <h2 className="text-[11px] font-semibold text-slate-700 uppercase tracking-wide">Feedback &amp; Reviews</h2>
                        {pendingTotal > 0 && (
                            <span className="inline-flex items-center justify-center bg-slate-700 text-white text-[10px] font-semibold px-1.5 py-0.5 min-w-[18px]">
                                {pendingTotal}
                            </span>
                        )}
                    </div>
                    <button
                        onClick={onClose}
                        className="text-slate-400 hover:text-slate-700 text-sm leading-none p-1"
                        aria-label="Close"
                    >
                        ✕
                    </button>
                </div>

                {/* Tabs */}
                <div className="flex border-b border-slate-200">
                    {TABS.map((tab) => (
                        <button
                            key={tab}
                            onClick={() => setActiveTab(tab)}
                            className={`flex-1 py-1.5 text-[11px] font-medium capitalize transition border-b-2 ${activeTab === tab
                                ? 'border-sky-600 text-sky-700'
                                : 'border-transparent text-slate-400 hover:text-slate-700'
                                }`}
                        >
                            {tab}
                        </button>
                    ))}
                </div>

                {/* Pagination top bar */}
                <div className="flex items-center justify-between px-3 py-1 border-b border-slate-200 bg-slate-50/60 text-[10px] text-slate-500">
                    <div>{total} item{total !== 1 ? 's' : ''}</div>
                    <div className="flex items-center gap-1.5">
                        <label>Per page:</label>
                        <select
                            value={pageSize}
                            onChange={(e) => setPageSize(Number(e.target.value))}
                            className="border border-slate-300 px-1 py-0.5 text-[10px] bg-white"
                        >
                            {PAGE_SIZES.map((s) => (
                                <option key={s} value={s}>{s}</option>
                            ))}
                        </select>
                    </div>
                </div>

                {/* List */}
                <div className="overflow-y-auto" style={{ height: 'calc(100% - 130px)' }}>
                    {loading ? (
                        <p className="text-center text-[11px] text-slate-400 mt-8">Loading…</p>
                    ) : items.length === 0 ? (
                        <p className="text-center text-[11px] text-slate-400 mt-8">No feedback</p>
                    ) : (
                        <ul className="divide-y divide-slate-100">
                            {items.map((r) => (
                                <li
                                    key={r.id}
                                    className="px-3 py-2 hover:bg-slate-50 cursor-pointer transition"
                                    onClick={() => setReviewing(r)}
                                >
                                    <div className="flex items-start justify-between gap-2">
                                        <div className="min-w-0 flex-1">
                                            <p className="text-[12px] font-medium text-slate-800 truncate">
                                                {r.event_title || r.event_id}
                                            </p>
                                            <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-slate-500">
                                                <span className="font-mono text-slate-400" title={r.event_id}>
                                                    {r.event_id}
                                                </span>
                                                <button
                                                    onClick={(e) => { e.stopPropagation(); setAdminDetailEventId(r.event_id); }}
                                                    className="text-sky-700 hover:text-sky-900 hover:underline shrink-0"
                                                    title="Open event details panel"
                                                >
                                                    View event
                                                </button>
                                            </div>
                                            <div className="mt-1 flex items-center gap-1.5 text-[10px] text-slate-500">
                                                <span className="text-slate-700 font-semibold tracking-tight">
                                                    {'★'.repeat(r.stars)}{'☆'.repeat(5 - r.stars)}
                                                </span>
                                                <span className="truncate">
                                                    {r.is_anonymous ? 'Anonymous' : (r.user_email || r.user_display_name || 'Unknown')}
                                                </span>
                                                {r.submitter_country && <span title={r.submitter_country}>· {r.submitter_country}</span>}
                                            </div>
                                            {r.comment && (
                                                <p className="text-slate-600 text-[11px] mt-1 line-clamp-2">
                                                    {r.comment.slice(0, 120)}{r.comment.length > 120 ? '…' : ''}
                                                </p>
                                            )}
                                            <div className="mt-1 flex flex-wrap items-center gap-1">
                                                {r.auto_flagged && (
                                                    <span className="text-[9px] font-semibold uppercase px-1.5 py-0.5 border border-amber-300 bg-amber-50 text-amber-700">
                                                        ⚠ flagged
                                                    </span>
                                                )}
                                                {r.linked_tag_suggestion_ids.length > 0 && (
                                                    <span className="text-[9px] font-semibold uppercase px-1.5 py-0.5 border border-slate-300 bg-slate-50 text-slate-600">
                                                        +{r.linked_tag_suggestion_ids.length} tag suggestion{r.linked_tag_suggestion_ids.length !== 1 ? 's' : ''}
                                                    </span>
                                                )}
                                                <span className="text-slate-400 text-[10px] ml-auto">
                                                    {new Date(r.created_at).toLocaleDateString()}
                                                </span>
                                            </div>
                                        </div>
                                        {statusBadge(r.status)}
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>

                {/* Pagination footer */}
                <div className="flex items-center justify-between px-3 py-1.5 border-t border-slate-200 bg-slate-50 text-[11px]">
                    <button
                        onClick={() => setPage((p) => Math.max(1, p - 1))}
                        disabled={page <= 1 || loading}
                        className="px-2 py-0.5 border border-slate-300 disabled:opacity-50 hover:bg-white"
                    >
                        ← Prev
                    </button>
                    <span className="text-slate-500">
                        Page {page} of {totalPages}
                    </span>
                    <button
                        onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                        disabled={page >= totalPages || loading}
                        className="px-2 py-0.5 border border-slate-300 disabled:opacity-50 hover:bg-white"
                    >
                        Next →
                    </button>
                </div>
            </div>

            {reviewing && (
                <RatingReviewModal
                    rating={reviewing}
                    onClose={() => setReviewing(null)}
                    onUpdated={(updated) => {
                        setItems((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
                        setReviewing(updated);
                        load();
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
