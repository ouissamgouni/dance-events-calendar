/**
 * SyncJobsHistoryTable — paginated, filterable table view of past sync jobs.
 *
 * Replaces SyncJobPanel's card list. Click a row to open JobDetailDrawer.
 */
import { useEffect, useMemo, useState } from 'react';
import type { SyncJobRecord } from '../api';
import { fetchSyncJobs } from '../api';
import JobDetailDrawer from './JobDetailDrawer';

const STATUS_DOT: Record<string, string> = {
    running: 'bg-blue-500 animate-pulse',
    abort_requested: 'bg-amber-400 animate-pulse',
    completed: 'bg-emerald-500',
    warning: 'bg-amber-500',
    failed: 'bg-red-500',
    aborted: 'bg-gray-400',
    idle: 'bg-gray-300',
};

const STATUS_BADGE: Record<string, string> = {
    running: 'bg-blue-50 text-blue-700',
    abort_requested: 'bg-amber-50 text-amber-700',
    completed: 'bg-emerald-50 text-emerald-700',
    warning: 'bg-amber-50 text-amber-700',
    failed: 'bg-red-50 text-red-700',
    aborted: 'bg-gray-100 text-gray-500',
    idle: 'bg-gray-100 text-gray-500',
};

type StatusFilter =
    | 'all'
    | 'running'
    | 'completed'
    | 'warning'
    | 'failed'
    | 'aborted';

interface SyncJobsHistoryTableProps {
    onClose?: () => void;
}

const PAGE_SIZE = 25;

function durationLabel(j: SyncJobRecord): string {
    const start = new Date(j.started_at).getTime();
    const end = j.finished_at ? new Date(j.finished_at).getTime() : Date.now();
    const secs = Math.max(0, (end - start) / 1000);
    if (secs < 60) return `${secs.toFixed(1)}s`;
    const m = Math.floor(secs / 60);
    const s = Math.round(secs % 60);
    return `${m}m ${s}s`;
}

function formatTime(iso: string | null): string {
    if (!iso) return '—';
    try {
        return new Date(iso).toLocaleString();
    } catch {
        return iso;
    }
}

export default function SyncJobsHistoryTable({ onClose }: SyncJobsHistoryTableProps) {
    const [jobs, setJobs] = useState<SyncJobRecord[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
    const [page, setPage] = useState(0);
    const [openJobId, setOpenJobId] = useState<string | null>(null);

    const refresh = async () => {
        setLoading(true);
        try {
            const res = await fetchSyncJobs(PAGE_SIZE, page * PAGE_SIZE);
            setJobs(res.items);
            setTotal(res.total);
            setError(null);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        refresh();
        const t = setInterval(refresh, 5000);
        return () => clearInterval(t);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [page]);

    const filtered = useMemo(() => {
        if (statusFilter === 'all') return jobs;
        if (statusFilter === 'running') {
            return jobs.filter((j) => j.status === 'running' || j.status === 'abort_requested');
        }
        return jobs.filter((j) => j.status === statusFilter);
    }, [jobs, statusFilter]);

    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    return (
        <div className="bg-white border border-gray-200 rounded-lg shadow-sm">
            <div className="flex items-center justify-between px-4 py-2 border-b border-gray-100">
                <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-gray-700">Sync History</h3>
                    <span className="text-[10px] text-gray-400">{total} total</span>
                </div>
                <div className="flex items-center gap-2">
                    <select
                        value={statusFilter}
                        onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                        className="text-xs border border-gray-300 rounded px-2 py-1"
                    >
                        <option value="all">All statuses</option>
                        <option value="running">Running</option>
                        <option value="completed">Completed</option>
                        <option value="warning">Warning</option>
                        <option value="failed">Failed</option>
                        <option value="aborted">Aborted</option>
                    </select>
                    <button
                        onClick={refresh}
                        disabled={loading}
                        className="text-xs text-gray-500 hover:text-gray-700 disabled:opacity-50"
                    >
                        ↻
                    </button>
                    {onClose && (
                        <button
                            onClick={onClose}
                            className="text-xs text-gray-400 hover:text-gray-600"
                        >
                            ✕
                        </button>
                    )}
                </div>
            </div>

            {error && <div className="px-4 py-2 text-xs text-red-600">{error}</div>}

            <div className="overflow-x-auto">
                <table className="w-full text-xs">
                    <thead>
                        <tr className="text-left text-[10px] uppercase tracking-wide text-gray-400 border-b border-gray-100 bg-gray-50">
                            <th className="px-3 py-2 font-medium">Job</th>
                            <th className="px-3 py-2 font-medium">Status</th>
                            <th className="px-3 py-2 font-medium">Started</th>
                            <th className="px-3 py-2 font-medium">Duration</th>
                            <th className="px-3 py-2 font-medium">Mode</th>
                            <th className="px-3 py-2 font-medium text-right">Calendars</th>
                            <th className="px-3 py-2 font-medium text-right">New</th>
                            <th className="px-3 py-2 font-medium text-right">Issues</th>
                        </tr>
                    </thead>
                    <tbody>
                        {filtered.length === 0 && !loading && (
                            <tr>
                                <td colSpan={8} className="px-3 py-6 text-center text-xs text-gray-400">
                                    No jobs found.
                                </td>
                            </tr>
                        )}
                        {filtered.map((j) => {
                            // Only count actionable issues (geocoding warnings +
                            // persistence/exception failures). Link/price stage
                            // failures are no-ops (event simply had no link /
                            // no parseable price text) and should not inflate
                            // the Issues counter.
                            const stageTotals = j.stage_totals ?? {};
                            const issues =
                                (stageTotals.geocoding?.failed ?? 0) +
                                (stageTotals.persistence?.failed ?? 0);
                            return (
                                <tr
                                    key={j.job_id}
                                    onClick={() => setOpenJobId(j.job_id)}
                                    className="cursor-pointer hover:bg-gray-50 border-b border-gray-50"
                                >
                                    <td className="px-3 py-2 font-mono text-[10px] text-gray-500" title={j.job_id}>
                                        {j.job_id.slice(0, 8)}
                                    </td>
                                    <td className="px-3 py-2">
                                        <div className="flex items-center gap-2">
                                            <span
                                                className={`inline-block w-2 h-2 rounded-full ${STATUS_DOT[j.status] ?? 'bg-gray-300'
                                                    }`}
                                            />
                                            <span
                                                className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${STATUS_BADGE[j.status] ?? 'bg-gray-100 text-gray-500'
                                                    }`}
                                            >
                                                {j.status}
                                            </span>
                                            {j.is_stale && (
                                                <span
                                                    className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-orange-50 text-orange-700 border border-orange-200"
                                                    title="No heartbeat received — worker likely crashed"
                                                >
                                                    stale
                                                </span>
                                            )}
                                        </div>
                                    </td>
                                    <td className="px-3 py-2 text-gray-700 whitespace-nowrap">
                                        {formatTime(j.started_at)}
                                    </td>
                                    <td className="px-3 py-2 text-gray-600">{durationLabel(j)}</td>
                                    <td className="px-3 py-2 text-gray-600 capitalize">{j.mode}</td>
                                    <td className="px-3 py-2 text-right text-gray-600">
                                        {j.totals.calendars_synced}
                                    </td>
                                    <td className="px-3 py-2 text-right text-gray-600">
                                        {j.totals.events_upserted}
                                    </td>
                                    <td
                                        className={`px-3 py-2 text-right ${issues > 0 ? 'text-amber-600' : 'text-gray-400'
                                            }`}
                                    >
                                        {issues}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            {totalPages > 1 && (
                <div className="flex items-center justify-between px-4 py-2 border-t border-gray-100 text-xs">
                    <button
                        onClick={() => setPage((p) => Math.max(0, p - 1))}
                        disabled={page === 0}
                        className="px-2 py-1 border border-gray-200 rounded disabled:opacity-50"
                    >
                        Prev
                    </button>
                    <span className="text-gray-500">
                        Page {page + 1} of {totalPages}
                    </span>
                    <button
                        onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                        disabled={page >= totalPages - 1}
                        className="px-2 py-1 border border-gray-200 rounded disabled:opacity-50"
                    >
                        Next
                    </button>
                </div>
            )}

            {openJobId && (
                <JobDetailDrawer jobId={openJobId} onClose={() => setOpenJobId(null)} />
            )}
        </div>
    );
}
