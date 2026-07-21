import { useEffect, useState } from 'react';
import {
    dismissDuplicateGroup,
    fetchDuplicateGroups,
    fetchDuplicateScanHistory,
    keepDuplicateEvent,
    triggerDuplicateScan,
} from '../api';
import { notifyAdminDataChanged } from '../hooks/useAdminCounters';
import type { DuplicateGroup, DuplicateScanLogEntry } from '../types';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    onOpenEvent?: (eventId: string) => void;
}

const TABS = ['pending', 'resolved', 'history'] as const;
type Tab = typeof TABS[number];

function statusBadge(status: string) {
    const colors: Record<string, string> = {
        pending: 'bg-amber-100 text-amber-700',
        resolved: 'bg-emerald-100 text-emerald-700',
        dismissed: 'bg-slate-200 text-slate-700',
    };
    return (
        <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 ${colors[status] ?? 'bg-gray-100 text-gray-600'}`}>
            {status}
        </span>
    );
}

export default function DuplicatesPanel({ isOpen, onClose, onOpenEvent }: Props) {
    const [activeTab, setActiveTab] = useState<Tab>('pending');
    const [groups, setGroups] = useState<DuplicateGroup[]>([]);
    const [history, setHistory] = useState<DuplicateScanLogEntry[]>([]);
    const [loading, setLoading] = useState(false);
    const [acting, setActing] = useState<number | null>(null);
    const [scanning, setScanning] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = () => {
        setLoading(true);
        setError(null);
        if (activeTab === 'history') {
            fetchDuplicateScanHistory()
                .then((res) => setHistory(res.items))
                .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
                .finally(() => setLoading(false));
            return;
        }
        fetchDuplicateGroups(activeTab)
            .then((res) => setGroups(res.items))
            .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
            .finally(() => setLoading(false));
    };

    useEffect(() => {
        if (!isOpen) return;
        load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, activeTab]);

    const scanNow = async () => {
        setScanning(true);
        setError(null);
        try {
            await triggerDuplicateScan();
            if (activeTab === 'pending' || activeTab === 'history') load();
            notifyAdminDataChanged();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to trigger scan');
        } finally {
            setScanning(false);
        }
    };

    const keep = async (groupId: number, keepEventId: string) => {
        setActing(groupId);
        try {
            const updated = await keepDuplicateEvent(groupId, keepEventId);
            if (activeTab === 'pending') {
                setGroups((prev) => prev.filter((g) => g.id !== groupId));
            } else {
                setGroups((prev) => prev.map((g) => (g.id === groupId ? updated : g)));
            }
            notifyAdminDataChanged();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to keep event');
        } finally {
            setActing(null);
        }
    };

    const dismiss = async (groupId: number) => {
        setActing(groupId);
        try {
            const updated = await dismissDuplicateGroup(groupId);
            if (activeTab === 'pending') {
                setGroups((prev) => prev.filter((g) => g.id !== groupId));
            } else {
                setGroups((prev) => prev.map((g) => (g.id === groupId ? updated : g)));
            }
            notifyAdminDataChanged();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to dismiss group');
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
                    <h2 className="text-sm font-semibold text-slate-800">Duplicate events</h2>
                    <div className="flex items-center gap-2">
                        <button
                            disabled={scanning}
                            onClick={scanNow}
                            className="text-[11px] bg-blue-500 text-white px-2.5 py-1 hover:bg-blue-600 disabled:opacity-50"
                        >
                            {scanning ? 'Scanning…' : 'Scan now'}
                        </button>
                        <button
                            onClick={onClose}
                            className="text-slate-400 hover:text-slate-700 text-sm px-2"
                        >
                            ✕
                        </button>
                    </div>
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
                    ) : activeTab === 'history' ? (
                        history.length === 0 ? (
                            <div className="p-6 text-center text-xs text-slate-400">No scan history</div>
                        ) : (
                            <ul className="divide-y divide-slate-100">
                                {history.map((h) => (
                                    <li key={h.id} className="p-3 text-xs">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <span className="font-medium text-slate-800 capitalize">{h.scan_type.replace('_', ' ')}</span>
                                            <span className="text-[10px] uppercase font-semibold text-slate-500">{h.status}</span>
                                        </div>
                                        <div className="mt-1 text-[11px] text-slate-500">
                                            {h.candidates_found} candidate{h.candidates_found === 1 ? '' : 's'} found,{' '}
                                            {h.groups_created} group{h.groups_created === 1 ? '' : 's'} created
                                        </div>
                                        <div className="mt-1 text-[10px] text-slate-400">
                                            Started {new Date(h.started_at).toLocaleString()}
                                            {h.finished_at && ` · finished ${new Date(h.finished_at).toLocaleString()}`}
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        )
                    ) : groups.length === 0 ? (
                        <div className="p-6 text-center text-xs text-slate-400">No duplicate groups</div>
                    ) : (
                        <ul className="divide-y divide-slate-100">
                            {groups.map((g) => (
                                <li key={g.id} className="p-3">
                                    <div className="flex items-center gap-2 flex-wrap mb-2">
                                        {statusBadge(g.status)}
                                        <span className="text-[10px] uppercase text-slate-400">{g.source}</span>
                                        <span className="text-[10px] text-slate-400">
                                            {new Date(g.created_at).toLocaleString()}
                                        </span>
                                    </div>
                                    <ul className="space-y-1.5">
                                        {g.events.map((ev) => (
                                            <li
                                                key={ev.event_id}
                                                className="flex items-start justify-between gap-3 border border-slate-100 bg-slate-50 px-2 py-1.5"
                                            >
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex items-center gap-2 flex-wrap">
                                                        {onOpenEvent ? (
                                                            <button
                                                                type="button"
                                                                onClick={() => onOpenEvent(ev.event_id)}
                                                                className="font-medium text-blue-600 hover:underline text-left text-xs"
                                                            >
                                                                {ev.title}
                                                            </button>
                                                        ) : (
                                                            <span className="font-medium text-xs">{ev.title}</span>
                                                        )}
                                                        {g.kept_event_id === ev.event_id && (
                                                            <span className="text-[10px] font-semibold uppercase px-1.5 py-0.5 bg-emerald-100 text-emerald-700">
                                                                kept
                                                            </span>
                                                        )}
                                                        {ev.rejected_duplicate_reason && (
                                                            <span className="text-[10px] font-semibold uppercase px-1.5 py-0.5 bg-slate-200 text-slate-600">
                                                                rejected
                                                            </span>
                                                        )}
                                                    </div>
                                                    <div className="mt-0.5 text-[10px] text-slate-500">
                                                        {new Date(ev.start).toLocaleString()} — {ev.event_id}
                                                    </div>
                                                    {ev.rejected_duplicate_reason && (
                                                        <div className="mt-0.5 text-[10px] text-slate-500 italic">
                                                            {ev.rejected_duplicate_reason}
                                                        </div>
                                                    )}
                                                </div>
                                                {g.status === 'pending' && (
                                                    <button
                                                        disabled={acting === g.id}
                                                        onClick={() => keep(g.id, ev.event_id)}
                                                        className="text-[11px] bg-blue-500 text-white px-2 py-1 hover:bg-blue-600 disabled:opacity-50 shrink-0"
                                                    >
                                                        Keep
                                                    </button>
                                                )}
                                            </li>
                                        ))}
                                    </ul>
                                    {g.status === 'pending' && (
                                        <div className="mt-2">
                                            <button
                                                disabled={acting === g.id}
                                                onClick={() => dismiss(g.id)}
                                                className="text-[11px] text-slate-500 hover:text-slate-700 px-2 py-1 disabled:opacity-50"
                                            >
                                                Not duplicates — dismiss group
                                            </button>
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
