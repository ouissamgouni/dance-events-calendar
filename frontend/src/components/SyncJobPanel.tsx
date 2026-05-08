import { useEffect, useRef, useState } from 'react';
import type { SyncJobRecord } from '../api';
import { abortSyncJob, fetchSyncJobs, getCurrentSyncJob } from '../api';
import JobDetailDrawer from './JobDetailDrawer';

interface SyncJobPanelProps {
    isOpen: boolean;
    onClose: () => void;
    /** Called once when an active job transitions to a terminal state. */
    onJobComplete?: () => void;
}

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
};

const STATUS_LABEL: Record<string, string> = {
    running: 'Running',
    abort_requested: 'Aborting…',
    completed: 'Completed',
    warning: 'Warning',
    failed: 'Failed',
    aborted: 'Aborted',
    idle: 'Idle',
};

function isActive(status: string) {
    return status === 'running' || status === 'abort_requested';
}

function JobCard({
    job,
    onAbort,
    onOpen,
}: {
    job: SyncJobRecord;
    onAbort?: () => void;
    onOpen?: () => void;
}) {
    const active = isActive(job.status);
    const started = new Date(job.started_at);
    const finished = job.finished_at ? new Date(job.finished_at) : null;
    const duration = finished
        ? `${((finished.getTime() - started.getTime()) / 1000).toFixed(1)}s`
        : active
            ? `${Math.floor((Date.now() - started.getTime()) / 1000)}s…`
            : '—';

    const totals: [string, number][] = [
        ['Calendars', job.totals.calendars_synced],
        ['Fetched', job.totals.events_fetched],
        ['Saved', job.totals.events_upserted],
        ['Dedup', job.totals.events_deduped],
        ['Enriched', job.totals.events_enriched],
        ['Failed', job.totals.events_failed],
    ];

    return (
        <div
            onClick={onOpen}
            className={`px-4 py-3 transition cursor-pointer ${active ? 'bg-blue-50/40 hover:bg-blue-50/60' : 'hover:bg-gray-50/50'}`}
        >
            {/* Header row */}
            <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                    <span className={`inline-block w-1.5 h-1.5 rounded-full ${STATUS_DOT[job.status] ?? 'bg-gray-300'}`} />
                    <span className="text-xs font-medium text-gray-700 capitalize">{job.mode}</span>
                    <span className={`text-[10px] font-medium px-1.5 py-0.5 ${STATUS_BADGE[job.status] ?? 'bg-gray-100 text-gray-500'}`}>
                        {STATUS_LABEL[job.status] ?? job.status}
                    </span>
                </div>
                <div className="flex items-center gap-2">
                    <span className="text-[10px] text-gray-400">{duration}</span>
                    {job.status === 'running' && onAbort && (
                        <button
                            onClick={(e) => { e.stopPropagation(); onAbort(); }}
                            className="text-[10px] text-red-500 hover:text-red-700 font-medium px-1.5 py-0.5 border border-red-200 hover:border-red-400 transition"
                        >
                            Abort
                        </button>
                    )}
                </div>
            </div>

            {/* Totals grid */}
            <div className="ml-3.5 grid grid-cols-3 gap-x-4 gap-y-0.5 mb-1">
                {totals.map(([label, val]) => (
                    <div key={label} className="flex items-center gap-1">
                        <span className="text-[10px] text-gray-400">{label}:</span>
                        <span
                            className={`text-[10px] font-medium ${label === 'Failed' && val > 0 ? 'text-red-500' : 'text-gray-600'
                                }`}
                        >
                            {val}
                        </span>
                    </div>
                ))}
            </div>

            {/* Stage breakdown */}
            {Object.keys(job.stage_totals).length > 0 && (
                <div className="ml-3.5 flex flex-wrap gap-x-3 gap-y-0.5 mb-0.5">
                    {Object.entries(job.stage_totals).map(([stage, stats]) => (
                        <span key={stage} className="text-[10px] text-gray-400">
                            {stage}:{' '}
                            <span className="text-emerald-600">{stats.processed}</span>
                            {stats.failed > 0 && (
                                <> / <span className="text-red-500">{stats.failed}f</span></>
                            )}
                        </span>
                    ))}
                </div>
            )}

            {/* since_date / enrichment running indicator */}
            <div className="ml-3.5 flex items-center gap-3">
                {job.since_date && (
                    <span className="text-[10px] text-gray-400">since {job.since_date}</span>
                )}
                {active && job.totals.events_fetched > job.totals.events_upserted + job.totals.events_deduped + job.totals.events_failed && (
                    <span className="text-[10px] text-blue-500 animate-pulse">enriching…</span>
                )}
            </div>

            {/* Error / warning */}
            {job.error_message && (
                <p className="ml-3.5 mt-1 text-[10px] text-red-600 break-words">{job.error_message}</p>
            )}
            {job.warning_message && (
                <p className="ml-3.5 mt-0.5 text-[10px] text-amber-600 break-words">{job.warning_message}</p>
            )}

            <p className="ml-3.5 mt-0.5 text-[10px] text-gray-400">{started.toLocaleString()}</p>
        </div>
    );
}

export default function SyncJobPanel({ isOpen, onClose, onJobComplete }: SyncJobPanelProps) {
    const [current, setCurrent] = useState<SyncJobRecord | null>(null);
    const [history, setHistory] = useState<SyncJobRecord[]>([]);
    const [aborting, setAborting] = useState(false);
    const [openJobId, setOpenJobId] = useState<string | null>(null);
    const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const wasActiveRef = useRef(false);

    const refresh = async () => {
        try {
            const [cur, jobs] = await Promise.all([getCurrentSyncJob(), fetchSyncJobs(10)]);
            setCurrent(cur);
            setHistory(jobs.items);

            const nowActive = isActive(cur.status);
            if (wasActiveRef.current && !nowActive) {
                // Job just finished — stop polling, notify parent
                if (pollingRef.current) {
                    clearInterval(pollingRef.current);
                    pollingRef.current = null;
                }
                onJobComplete?.();
            }
            wasActiveRef.current = nowActive;
        } catch {
            // transient network errors ignored
        }
    };

    useEffect(() => {
        if (!isOpen) {
            if (pollingRef.current) clearInterval(pollingRef.current);
            pollingRef.current = null;
            return;
        }
        refresh();
        pollingRef.current = setInterval(refresh, 2000);
        return () => {
            if (pollingRef.current) clearInterval(pollingRef.current);
            pollingRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen]);

    const handleAbort = async () => {
        if (!current || aborting) return;
        setAborting(true);
        try {
            await abortSyncJob(current.job_id);
            await refresh();
        } catch {
            // ignore
        } finally {
            setAborting(false);
        }
    };

    const currentIsNonIdle = current && current.status !== 'idle';
    const historyWithoutCurrent = history.filter((j) => !current || j.job_id !== current.job_id);

    return (
        <>
            {isOpen && <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} />}

            <div
                className={`fixed top-0 right-0 h-full w-[420px] bg-white shadow-lg border-l border-gray-200 z-50 transform transition-transform duration-200 ease-in-out ${isOpen ? 'translate-x-0' : 'translate-x-full'
                    }`}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-200 bg-gray-50">
                    <h2 className="text-xs font-semibold text-gray-800 uppercase tracking-wide">
                        Sync Jobs
                    </h2>
                    <button
                        onClick={onClose}
                        className="text-gray-400 hover:text-gray-600 text-sm leading-none p-1"
                        aria-label="Close"
                    >
                        ✕
                    </button>
                </div>

                <div className="overflow-y-auto h-[calc(100%-41px)] divide-y divide-gray-100">
                    {/* Empty state */}
                    {!currentIsNonIdle && historyWithoutCurrent.length === 0 && (
                        <div className="flex flex-col items-center justify-center h-full text-gray-400">
                            <p className="text-xs">No sync jobs yet</p>
                            <p className="text-[10px] mt-1 text-gray-300">Click "Sync Now" to start one</p>
                        </div>
                    )}

                    {/* Current job */}
                    {currentIsNonIdle && (
                        <>
                            <div className="px-4 py-1.5 bg-gray-50">
                                <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">
                                    Current
                                </span>
                            </div>
                            <JobCard
                                job={current}
                                onAbort={handleAbort}
                                onOpen={() => setOpenJobId(current.job_id)}
                            />
                        </>
                    )}

                    {/* History */}
                    {historyWithoutCurrent.length > 0 && (
                        <>
                            <div className="px-4 py-1.5 bg-gray-50">
                                <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">
                                    History
                                </span>
                            </div>
                            {historyWithoutCurrent.map((job) => (
                                <JobCard
                                    key={job.job_id}
                                    job={job}
                                    onOpen={() => setOpenJobId(job.job_id)}
                                />
                            ))}
                        </>
                    )}
                </div>
            </div>

            {openJobId && (
                <JobDetailDrawer jobId={openJobId} onClose={() => setOpenJobId(null)} />
            )}
        </>
    );
}
