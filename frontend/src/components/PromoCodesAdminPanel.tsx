import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
    approveAdminPromoCode,
    fetchAdminPromoCodes,
    rejectAdminPromoCode,
} from '../api';
import { notifyAdminDataChanged } from '../hooks/useAdminCounters';
import type { PromoCodeAdmin } from '../types';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    onOpenEvent?: (eventId: string) => void;
}

const TABS = ['pending', 'approved', 'rejected', 'all'] as const;
type Tab = typeof TABS[number];

function statusBadge(status: string) {
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
}

export default function PromoCodesAdminPanel({ isOpen, onClose, onOpenEvent }: Props) {
    const [activeTab, setActiveTab] = useState<Tab>('pending');
    const [rows, setRows] = useState<PromoCodeAdmin[]>([]);
    const [loading, setLoading] = useState(false);
    const [acting, setActing] = useState<string | null>(null);
    const [rejectingId, setRejectingId] = useState<string | null>(null);
    const [rejectNotes, setRejectNotes] = useState('');
    const [error, setError] = useState<string | null>(null);

    const load = () => {
        setLoading(true);
        setError(null);
        const status = activeTab === 'all' ? undefined : activeTab;
        fetchAdminPromoCodes(status)
            .then(setRows)
            .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
            .finally(() => setLoading(false));
    };

    useEffect(() => {
        if (!isOpen) return;
        load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, activeTab]);

    const approve = async (id: string) => {
        setActing(id);
        try {
            const updated = await approveAdminPromoCode(id);
            setRows((prev) => prev.map((r) => (r.id === id ? updated : r)));
            if (activeTab === 'pending') {
                setRows((prev) => prev.filter((r) => r.id !== id));
            }
            notifyAdminDataChanged();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to approve');
        } finally {
            setActing(null);
        }
    };

    const reject = async (id: string) => {
        setActing(id);
        try {
            const updated = await rejectAdminPromoCode(id, rejectNotes.trim() || undefined);
            setRows((prev) => prev.map((r) => (r.id === id ? updated : r)));
            if (activeTab === 'pending') {
                setRows((prev) => prev.filter((r) => r.id !== id));
            }
            setRejectingId(null);
            setRejectNotes('');
            notifyAdminDataChanged();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to reject');
        } finally {
            setActing(null);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-40 flex">
            <div
                className="flex-1 bg-black/30"
                onClick={onClose}
                aria-hidden="true"
            />
            <div className="w-full max-w-2xl bg-white shadow-xl flex flex-col">
                <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
                    <h2 className="text-sm font-semibold text-slate-800">Promo codes</h2>
                    <button
                        onClick={onClose}
                        className="text-slate-400 hover:text-slate-700 text-sm px-2"
                    >
                        ✕
                    </button>
                </div>

                <div className="flex border-b border-slate-200">
                    {TABS.map((t) => (
                        <button
                            key={t}
                            onClick={() => setActiveTab(t)}
                            className={`px-3 py-2 text-xs font-medium capitalize ${activeTab === t
                                ? 'text-blue-600 border-b-2 border-blue-500'
                                : 'text-slate-500 hover:text-slate-700'
                                }`}
                        >
                            {t}
                        </button>
                    ))}
                </div>

                {error && (
                    <div className="px-4 py-2 text-xs text-red-600 border-b border-red-200 bg-red-50">
                        {error}
                    </div>
                )}

                <div className="flex-1 overflow-y-auto">
                    {loading ? (
                        <div className="p-6 text-center text-xs text-slate-400">Loading…</div>
                    ) : rows.length === 0 ? (
                        <div className="p-6 text-center text-xs text-slate-400">No promo codes</div>
                    ) : (
                        <ul className="divide-y divide-slate-100">
                            {rows.map((p) => (
                                <li key={p.id} className="p-3">
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2 flex-wrap">
                                                <span className="font-mono text-sm text-slate-900">{p.code}</span>
                                                {statusBadge(p.status)}
                                                {p.expires_at && (
                                                    <span className="text-[10px] text-slate-500">
                                                        expires {new Date(p.expires_at).toLocaleDateString()}
                                                    </span>
                                                )}
                                            </div>
                                            {p.event_title && (
                                                <div className="mt-1 text-xs text-slate-600">
                                                    Event:{' '}
                                                    {onOpenEvent ? (
                                                        <button
                                                            type="button"
                                                            onClick={() => onOpenEvent(p.event_id)}
                                                            className="font-medium text-blue-600 hover:underline text-left"
                                                        >
                                                            {p.event_title}
                                                        </button>
                                                    ) : (
                                                        <span className="font-medium">{p.event_title}</span>
                                                    )}
                                                </div>
                                            )}
                                            {p.description && (
                                                <div className="mt-1 text-xs text-slate-600">{p.description}</div>
                                            )}
                                            {p.source_url && (
                                                <a
                                                    href={p.source_url}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="mt-1 inline-block text-[11px] text-blue-600 hover:underline break-all"
                                                >
                                                    {p.source_url}
                                                </a>
                                            )}
                                            <div className="mt-1 text-[10px] text-slate-400">
                                                Submitted by{' '}
                                                {p.submitter.handle ? (
                                                    <Link
                                                        to={`/u/${p.submitter.handle}`}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        className="text-blue-600 hover:underline"
                                                    >
                                                        @{p.submitter.handle}
                                                    </Link>
                                                ) : (
                                                    p.submitter.display_name ?? 'unknown'
                                                )}{' '}
                                                on {new Date(p.created_at).toLocaleString()}
                                            </div>
                                            {p.admin_notes && (
                                                <div className="mt-1 text-[11px] text-slate-500 italic">
                                                    Notes: {p.admin_notes}
                                                </div>
                                            )}
                                        </div>
                                        {p.status === 'pending' && (
                                            <div className="flex flex-col gap-1">
                                                <button
                                                    disabled={acting === p.id}
                                                    onClick={() => approve(p.id)}
                                                    className="text-[11px] bg-blue-500 text-white px-2 py-1 hover:bg-blue-600 disabled:opacity-50"
                                                >
                                                    Approve
                                                </button>
                                                <button
                                                    disabled={acting === p.id}
                                                    onClick={() => {
                                                        setRejectingId(p.id);
                                                        setRejectNotes('');
                                                    }}
                                                    className="text-[11px] bg-red-600 text-white px-2 py-1 hover:bg-red-700 disabled:opacity-50"
                                                >
                                                    Reject
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                    {rejectingId === p.id && (
                                        <div className="mt-2 border border-slate-200 bg-slate-50 p-2 flex flex-col gap-2">
                                            <textarea
                                                value={rejectNotes}
                                                onChange={(e) => setRejectNotes(e.target.value)}
                                                placeholder="Reason (optional, shown to submitter)"
                                                rows={2}
                                                maxLength={500}
                                                className="text-xs border border-slate-300 px-2 py-1 focus:outline-none focus:border-blue-400"
                                            />
                                            <div className="flex gap-2">
                                                <button
                                                    disabled={acting === p.id}
                                                    onClick={() => reject(p.id)}
                                                    className="text-[11px] bg-red-600 text-white px-2 py-1 hover:bg-red-700 disabled:opacity-50"
                                                >
                                                    Confirm reject
                                                </button>
                                                <button
                                                    onClick={() => setRejectingId(null)}
                                                    className="text-[11px] text-slate-500 px-2"
                                                >
                                                    Cancel
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </div>
        </div>
    );
}
