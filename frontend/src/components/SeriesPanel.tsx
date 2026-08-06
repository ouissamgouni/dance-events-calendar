import { useEffect, useState } from 'react';
import {
    approveSeriesGroup,
    dismissSeriesGroup,
    fetchSeriesGroups,
    fetchSeriesScanHistory,
    splitSeriesMember,
    triggerSeriesScan,
} from '../api';
import { notifyAdminDataChanged } from '../hooks/useAdminCounters';
import type { SeriesGroup, SeriesScanLogEntry } from '../types';
import SeriesGroupCard from './SeriesGroupCard';
import SeriesDetailPanel from './SeriesDetailPanel';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    onOpenEvent?: (eventId: string) => void;
}

const TABS = ['pending', 'resolved', 'history'] as const;
type Tab = typeof TABS[number];
const PAGE_SIZE = 25;

export default function SeriesPanel({ isOpen, onClose, onOpenEvent }: Props) {
    const [activeTab, setActiveTab] = useState<Tab>('pending');
    const [groups, setGroups] = useState<SeriesGroup[]>([]);
    const [total, setTotal] = useState(0);
    const [history, setHistory] = useState<SeriesScanLogEntry[]>([]);
    const [loading, setLoading] = useState(false);
    const [acting, setActing] = useState<number | null>(null);
    const [scanning, setScanning] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [q, setQ] = useState('');
    const [debouncedQ, setDebouncedQ] = useState('');
    const [detailSeries, setDetailSeries] = useState<SeriesGroup | null>(null);

    useEffect(() => {
        const t = setTimeout(() => setDebouncedQ(q), 250);
        return () => clearTimeout(t);
    }, [q]);

    const load = (offset = 0, append = false) => {
        setLoading(true);
        setError(null);
        if (activeTab === 'history') {
            fetchSeriesScanHistory()
                .then((res) => setHistory(res.items))
                .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
                .finally(() => setLoading(false));
            return;
        }
        fetchSeriesGroups(activeTab, { q: debouncedQ || undefined, limit: PAGE_SIZE, offset })
            .then((res) => {
                setGroups((prev) => (append ? [...prev, ...res.items] : res.items));
                setTotal(res.total);
            })
            .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
            .finally(() => setLoading(false));
    };

    useEffect(() => {
        if (!isOpen) return;
        load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, activeTab, debouncedQ]);

    const scanNow = async () => {
        setScanning(true);
        setError(null);
        try {
            await triggerSeriesScan();
            if (activeTab === 'pending' || activeTab === 'history') load();
            notifyAdminDataChanged();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to trigger scan');
        } finally {
            setScanning(false);
        }
    };

    // Apply an updated series (or removal when null) coming from the detail panel.
    const applyChange = (seriesId: number, updated: SeriesGroup | null) => {
        setGroups((prev) => {
            if (!updated || (activeTab === 'pending' && updated.status !== 'pending')) {
                return prev.filter((g) => g.id !== seriesId);
            }
            return prev.map((g) => (g.id === seriesId ? updated : g));
        });
    };

    const approve = async (seriesId: number) => {
        setActing(seriesId);
        try {
            const updated = await approveSeriesGroup(seriesId);
            if (activeTab === 'pending') {
                setGroups((prev) => prev.filter((g) => g.id !== seriesId));
            } else {
                setGroups((prev) => prev.map((g) => (g.id === seriesId ? updated : g)));
            }
            notifyAdminDataChanged();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to approve series');
        } finally {
            setActing(null);
        }
    };

    const dismiss = async (seriesId: number) => {
        setActing(seriesId);
        try {
            const updated = await dismissSeriesGroup(seriesId);
            if (activeTab === 'pending') {
                setGroups((prev) => prev.filter((g) => g.id !== seriesId));
            } else {
                setGroups((prev) => prev.map((g) => (g.id === seriesId ? updated : g)));
            }
            notifyAdminDataChanged();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to dismiss series');
        } finally {
            setActing(null);
        }
    };

    const split = async (seriesId: number, eventId: string) => {
        setActing(seriesId);
        try {
            const res = await splitSeriesMember(seriesId, eventId);
            if (res.dissolved || !res.series) {
                setGroups((prev) => prev.filter((g) => g.id !== seriesId));
            } else {
                const series = res.series;
                setGroups((prev) => prev.map((g) => (g.id === seriesId ? series : g)));
            }
            notifyAdminDataChanged();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to split event from series');
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
                    <h2 className="text-sm font-semibold text-slate-800">Event series</h2>
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

                {activeTab !== 'history' && (
                    <div className="px-4 py-2 border-b border-slate-100">
                        <input
                            type="text"
                            value={q}
                            onChange={(e) => setQ(e.target.value)}
                            placeholder="Search series by title…"
                            className="w-full text-xs border border-slate-300 px-2 py-1"
                        />
                    </div>
                )}

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
                                            <span className="font-medium text-slate-800 capitalize">{h.scan_type}</span>
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
                        <div className="p-6 text-center text-xs text-slate-400">No series groups</div>
                    ) : (
                        <ul className="divide-y divide-slate-100">
                            {groups.map((g) => (
                                activeTab === 'resolved' ? (
                                    <li key={g.id} className="px-3 py-2">
                                        <button
                                            onClick={() => setDetailSeries(g)}
                                            className="text-left text-xs text-blue-600 hover:underline"
                                        >
                                            {g.canonical_title}{' '}
                                            <span className="text-slate-400">({g.events.length})</span>
                                        </button>
                                    </li>
                                ) : (
                                    <li key={g.id} className="p-3">
                                        <div className="flex justify-end mb-1">
                                            <button
                                                onClick={() => setDetailSeries(g)}
                                                className="text-[11px] text-blue-600 hover:underline"
                                            >
                                                Details
                                            </button>
                                        </div>
                                        <SeriesGroupCard
                                            group={g}
                                            acting={acting === g.id}
                                            onApprove={() => approve(g.id)}
                                            onDismiss={() => dismiss(g.id)}
                                            onRemove={g.status === 'pending' ? (eventId) => split(g.id, eventId) : undefined}
                                            onOpenEvent={onOpenEvent}
                                        />
                                    </li>
                                )
                            ))}
                            {groups.length < total && (
                                <li className="p-3 text-center">
                                    <button
                                        disabled={loading}
                                        onClick={() => load(groups.length, true)}
                                        className="text-[11px] text-blue-600 hover:underline disabled:opacity-50"
                                    >
                                        {loading ? 'Loading…' : `Load more (${total - groups.length})`}
                                    </button>
                                </li>
                            )}
                        </ul>
                    )}
                </div>
            </div>

            {detailSeries && (
                <SeriesDetailPanel
                    series={detailSeries}
                    onClose={() => setDetailSeries(null)}
                    onChanged={(updated) => {
                        applyChange(detailSeries.id, updated);
                        setDetailSeries(updated);
                    }}
                    onOpenEvent={onOpenEvent}
                />
            )}
        </div>
    );
}
