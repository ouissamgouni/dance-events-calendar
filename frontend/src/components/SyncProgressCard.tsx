/**
 * SyncProgressCard — inline progress card that appears below the Sync button.
 *
 * Shows:
 *   • Top bar: status dot, mode badge, aggregate counters, duration, abort/dismiss
 *   • Per-calendar grid: name, status badge, mini counters, "View details" link
 *   • Logs strip: last 5 WARNING/ERROR lines
 *   • Error box: job-level errors
 *
 * Clicking "View details" on a calendar row opens CalendarDetailDrawer.
 */
import { useEffect, useRef, useState } from 'react';
import type { SyncJobRecord, CalendarStatus } from '../api';
import { abortSyncJob, getCurrentSyncJob, getSyncJob } from '../api';
import CalendarDetailDrawer from './CalendarDetailDrawer';

interface SyncProgressCardProps {
    /** Whether the card is visible */
    visible: boolean;
    /** When set, polls this specific job (avoids multi-instance split-brain on prod) */
    jobId?: string;
    /** Called when user clicks X to dismiss */
    onDismiss: () => void;
    /** Called when an active job transitions to a terminal state */
    onJobComplete?: () => void;
}

// ---------------------------------------------------------------------------
// Style maps
// ---------------------------------------------------------------------------

const STATUS_DOT: Record<string, string> = {
    running: 'bg-blue-500 animate-pulse',
    processing: 'bg-violet-500 animate-pulse',
    abort_requested: 'bg-amber-400 animate-pulse',
    completed: 'bg-emerald-500',
    warning: 'bg-amber-500',
    failed: 'bg-red-500',
    aborted: 'bg-gray-400',
    idle: 'bg-gray-300',
};

const STATUS_BADGE_CAL: Record<string, string> = {
    queued: 'bg-gray-100 text-gray-500',
    running: 'bg-blue-50 text-blue-700',
    processing: 'bg-violet-50 text-violet-700',
    completed: 'bg-emerald-50 text-emerald-700',
    warning: 'bg-amber-50 text-amber-700',
    failed: 'bg-red-50 text-red-700',
};

const STATUS_LABEL_CAL: Record<string, string> = {
    queued: 'Queued',
    running: 'Fetching',
    processing: 'Processing',
    completed: 'Done',
    warning: 'Warning',
    failed: 'Failed',
};

const STATUS_BADGE: Record<string, string> = {
    running: 'bg-blue-100 text-blue-700',
    abort_requested: 'bg-amber-100 text-amber-700',
    completed: 'bg-emerald-100 text-emerald-700',
    warning: 'bg-amber-100 text-amber-700',
    failed: 'bg-red-100 text-red-700',
    aborted: 'bg-gray-100 text-gray-500',
};

const LOG_LEVEL_BADGE: Record<string, string> = {
    WARNING: 'text-amber-600',
    ERROR: 'text-red-600',
};

function isActive(status: string): boolean {
    return status === 'running' || status === 'abort_requested';
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Counter({ label, value, highlight }: { label: string; value: number; highlight?: string }) {
    return (
        <div className="inline-flex items-baseline gap-1">
            <span className={`text-sm font-semibold ${highlight && value > 0 ? highlight : 'text-gray-700'}`}>
                {value}
            </span>
            <span className="text-[10px] text-gray-400">{label}</span>
        </div>
    );
}

interface LogLine {
    timestamp: string;
    level: string;
    message: string;
    calendar: string;
}

function LogsStrip({ logs, errorCount }: { logs: LogLine[]; errorCount: number }) {
    const [filter, setFilter] = useState<'all' | 'errors'>('all');
    const visible = filter === 'errors'
        ? logs.filter((l) => l.level === 'WARNING' || l.level === 'ERROR')
        : logs;

    const fmtTime = (iso: string): string => {
        try { return new Date(iso).toLocaleTimeString(); } catch { return iso; }
    };

    return (
        <div className="border border-gray-100 rounded bg-white">
            <div className="flex items-center justify-between px-2 py-1 border-b border-gray-100">
                <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wide">
                    Recent logs {errorCount > 0 && (
                        <span className="text-amber-600 normal-case">({errorCount} alerts)</span>
                    )}
                </p>
                <div className="flex items-center gap-1">
                    {(['all', 'errors'] as const).map((f) => (
                        <button
                            key={f}
                            onClick={() => setFilter(f)}
                            className={`text-[10px] px-1.5 py-0.5 rounded ${filter === f ? 'bg-gray-200 text-gray-700' : 'text-gray-400 hover:text-gray-600'
                                }`}
                        >
                            {f === 'all' ? 'All' : 'Alerts'}
                        </button>
                    ))}
                </div>
            </div>
            <div className="max-h-32 overflow-y-auto px-2 py-1 font-mono text-[10px] space-y-0.5">
                {visible.length === 0 && (
                    <div className="text-gray-400 italic py-1">No log entries</div>
                )}
                {visible.map((log, i) => (
                    <div key={i} className="flex items-start gap-1.5">
                        <span className="text-gray-400 flex-shrink-0">{fmtTime(log.timestamp)}</span>
                        <span className={`font-semibold flex-shrink-0 w-12 ${LOG_LEVEL_BADGE[log.level] ?? 'text-gray-400'}`}>
                            {log.level}
                        </span>
                        <span className="text-gray-400 truncate flex-shrink-0 max-w-[100px]">[{log.calendar}]</span>
                        <span className="text-gray-700 break-words">{log.message}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}

function CalendarRow({
    cal,
    onViewDetails,
}: {
    cal: CalendarStatus;
    onViewDetails: () => void;
}) {
    const stageOrder = ['link_extraction', 'price_extraction', 'geocoding', 'persistence'];
    const stageLabel: Record<string, string> = {
        link_extraction: 'links',
        price_extraction: 'price',
        geocoding: 'geo',
        persistence: 'save',
    };
    const stages = cal.stage_stats || {};
    const visibleStages = stageOrder.filter((s) => stages[s]);
    const calProcessed = cal.upserted + cal.deduped + cal.enriched_failed;
    const calProgressPct = cal.fetched > 0 ? Math.min(100, Math.round((calProcessed / cal.fetched) * 100)) : 0;
    const calActive = cal.status === 'running' || cal.status === 'queued' || cal.status === 'processing';

    // Per-cal split (warn = geo only; errors = persistence/exception + cal.error)
    const calWarnings = stages.geocoding?.failed ?? 0;
    const calRealErrors =
        (cal.failures ?? []).filter(
            (f) => f.type === 'persistence_failed' || f.type === 'enrichment_exception',
        ).length + (cal.error ? 1 : 0);

    // Per-stage chip color for the failed sub-counter
    const failTone: Record<string, string> = {
        geocoding: 'text-amber-600',
        link_extraction: 'text-gray-500',
        price_extraction: 'text-gray-500',
        persistence: 'text-red-500',
    };

    return (
        <div className="flex flex-col gap-1 px-3 py-2 bg-white border border-gray-100 rounded-lg hover:border-gray-200 transition group">
            {/* Mini progress bar */}
            {(calActive || calProgressPct > 0) && (
                <div className="h-0.5 -mx-3 -mt-2 mb-1 bg-gray-100 overflow-hidden rounded-t-lg">
                    <div
                        className={`h-full transition-all duration-500 ${calActive
                            ? 'bg-blue-400'
                            : cal.status === 'completed'
                                ? 'bg-emerald-400'
                                : 'bg-amber-400'
                            }`}
                        style={{ width: `${calProgressPct}%` }}
                    />
                </div>
            )}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                    {/* Status dot */}
                    <span
                        className={`flex-shrink-0 w-1.5 h-1.5 rounded-full ${STATUS_DOT[cal.status] ?? 'bg-gray-300'}`}
                    />
                    {/* Name + badge */}
                    <span className="text-xs font-medium text-gray-700 truncate max-w-[180px]">
                        {cal.calendar_name}
                    </span>
                    <span className={`flex-shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded ${STATUS_BADGE_CAL[cal.status] ?? 'bg-gray-100 text-gray-500'}`}>
                        {STATUS_LABEL_CAL[cal.status] ?? cal.status}
                    </span>
                </div>

                {/* Mini counters */}
                <div className="flex items-center gap-3 ml-2">
                    <span className="text-[10px] text-gray-400">
                        <span className="font-medium text-gray-600">{cal.fetched}</span> fetched
                    </span>
                    <span className="text-[10px] text-gray-400">
                        <span className="font-medium text-gray-600">{cal.upserted}</span> new
                    </span>
                    {cal.deduped > 0 && (
                        <span className="text-[10px] text-gray-400">
                            <span className="font-medium text-gray-500">{cal.deduped}</span> dedup
                        </span>
                    )}
                    <span className="text-[10px] text-gray-400">
                        <span className={`font-medium ${cal.enriched_ok > 0 ? 'text-emerald-600' : 'text-gray-400'}`}>{cal.enriched_ok}</span> enriched
                    </span>
                    {calWarnings > 0 && (
                        <span className="text-[10px] font-medium text-amber-600">
                            {calWarnings} warn
                        </span>
                    )}
                    {calRealErrors > 0 && (
                        <span className="text-[10px] font-medium text-red-500">
                            {calRealErrors} err
                        </span>
                    )}
                    {/* View details */}
                    <button
                        onClick={onViewDetails}
                        className="text-[10px] text-indigo-500 hover:text-indigo-700 font-medium opacity-0 group-hover:opacity-100 transition"
                    >
                        Details →
                    </button>
                </div>
            </div>

            {/* Per-stage chips */}
            {visibleStages.length > 0 && (
                <div className="flex items-center justify-between gap-2 pl-3.5">
                    <div className="flex items-center gap-1.5 flex-wrap">
                        {visibleStages.map((s) => {
                            const stat = stages[s];
                            const ok = stat.processed;
                            const fail = stat.failed;
                            const skip = stat.skipped;
                            const isOptional = s === 'link_extraction' || s === 'price_extraction';
                            const isGeo = s === 'geocoding';
                            return (
                                <span
                                    key={s}
                                    className={`inline-flex items-center gap-1 text-[9.5px] px-1.5 py-0.5 rounded ${cal.pipeline_stage === s
                                        ? 'bg-blue-50 border border-blue-200 text-blue-700'
                                        : 'bg-gray-50 border border-gray-100 text-gray-500'
                                        }`}
                                >
                                    <span className="font-medium">{stageLabel[s] ?? s}</span>
                                    {ok > 0 && <span className="text-emerald-600">{ok} ✓</span>}
                                    {isOptional ? (
                                        (skip + fail) > 0 && (
                                            <span className="text-gray-400">{skip + fail} N/A</span>
                                        )
                                    ) : isGeo ? (
                                        fail > 0 && (
                                            <span className="text-amber-600">{fail} ⚠</span>
                                        )
                                    ) : (
                                        fail > 0 && (
                                            <span className={failTone[s] ?? 'text-red-500'}>/{fail}</span>
                                        )
                                    )}
                                </span>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function SyncProgressCard({ visible, jobId, onDismiss, onJobComplete }: SyncProgressCardProps) {
    const [job, setJob] = useState<SyncJobRecord | null>(null);
    const [aborting, setAborting] = useState(false);
    const [expanded, setExpanded] = useState(true);
    const [drawerCalId, setDrawerCalId] = useState<string | null>(null);
    const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const wasActiveRef = useRef(false);
    const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const fetchJob = async () => {
        try {
            const j = jobId ? await getSyncJob(jobId) : await getCurrentSyncJob();
            setJob(j);
            const nowActive = isActive(j.status);
            if (wasActiveRef.current && !nowActive) {
                // Just finished
                if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
                onJobComplete?.();
                // Auto-dismiss after 8s if user hasn't interacted
                dismissTimerRef.current = setTimeout(onDismiss, 8000);
            }
            wasActiveRef.current = nowActive;
        } catch {
            // network blip — ignore
        }
    };

    useEffect(() => {
        if (!visible) {
            if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
            if (dismissTimerRef.current) { clearTimeout(dismissTimerRef.current); dismissTimerRef.current = null; }
            return;
        }
        fetchJob();
        pollingRef.current = setInterval(fetchJob, 2000);
        return () => {
            if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
            if (dismissTimerRef.current) { clearTimeout(dismissTimerRef.current); dismissTimerRef.current = null; }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible]);

    const handleAbort = async () => {
        if (!job || aborting) return;
        setAborting(true);
        try {
            await abortSyncJob(job.job_id);
            await fetchJob();
        } catch { /* ignore */ } finally {
            setAborting(false);
        }
    };

    const handleDismiss = () => {
        if (dismissTimerRef.current) { clearTimeout(dismissTimerRef.current); dismissTimerRef.current = null; }
        onDismiss();
    };

    if (!visible || !job) return null;
    // Backend returns `{"status": "idle"}` (no totals/calendar_statuses) when
    // no job is active — guard against rendering until a real job is present.
    if (!job.totals) return null;

    const active = isActive(job.status);
    const started = new Date(job.started_at);
    const finished = job.finished_at ? new Date(job.finished_at) : null;

    // Live duration is computed each render when running
    const durationSec = finished
        ? ((finished.getTime() - started.getTime()) / 1000).toFixed(0)
        : active
            ? Math.floor((Date.now() - started.getTime()) / 1000).toString()
            : null;
    const durationLabel = durationSec != null ? `${durationSec}s` : '—';

    const calEntries = Object.values(job.calendar_statuses ?? {});

    // Split aggregated enrichment failures by severity for friendlier labelling:
    //   geo failures        → warnings (orange)
    //   persistence_failed / enrichment_exception + cal.error → real errors (red)
    // (link/price failures are intentionally not surfaced — they're common no-ops.)
    const totalWarnings = calEntries.reduce(
        (n, c) => n + (c.stage_stats?.geocoding?.failed ?? 0),
        0,
    );
    const totalErrors = calEntries.reduce(
        (n, c) =>
            n +
            (c.failures ?? []).filter(
                (f) =>
                    f.type === 'persistence_failed' ||
                    f.type === 'enrichment_exception',
            ).length +
            (c.error ? 1 : 0),
        0,
    );

    // Collect recent log entries (any level) merged across calendars, newest first.
    const recentLogs = calEntries
        .flatMap((c) => (c.logs ?? []).map((l) => ({ ...l, calendar: c.calendar_name })))
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        .slice(0, 10);
    const errorLogs = recentLogs.filter((l) => l.level === 'WARNING' || l.level === 'ERROR');

    const drawerCal = drawerCalId ? (job.calendar_statuses?.[drawerCalId] ?? null) : null;

    // Aggregate progress: how many fetched events have completed the pipeline.
    const fetched = job.totals.events_fetched;
    const processed =
        job.totals.events_upserted + job.totals.events_deduped + job.totals.events_failed;
    const progressPct = fetched > 0 ? Math.min(100, Math.round((processed / fetched) * 100)) : 0;

    return (
        <>
            <div className="mt-3 border border-gray-200 rounded-xl bg-gray-50 shadow-sm overflow-hidden">
                {/* ── Progress bar ── */}
                {(active || progressPct > 0) && (
                    <div className="h-1 bg-gray-100 relative overflow-hidden">
                        <div
                            className={`h-full transition-all duration-500 ease-out ${active
                                ? 'bg-blue-500'
                                : job.status === 'completed'
                                    ? 'bg-emerald-500'
                                    : job.status === 'warning'
                                        ? 'bg-amber-500'
                                        : 'bg-red-500'
                                }`}
                            style={{ width: `${progressPct}%` }}
                        />
                        {active && progressPct === 0 && (
                            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-blue-300 to-transparent animate-pulse" />
                        )}
                    </div>
                )}

                {/* ── Top bar (vertical layout for narrow column) ── */}
                <div className="flex flex-col gap-2 px-4 py-2.5 bg-white border-b border-gray-100">
                    <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0 flex-wrap">
                            <span className={`w-2 h-2 rounded-full ${STATUS_DOT[job.status] ?? 'bg-gray-300'}`} />
                            <span className="text-xs font-semibold text-gray-700">
                                {active ? 'Sync in progress' : job.status === 'completed' ? 'Sync complete' : `Sync ${job.status}`}
                            </span>
                            <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${STATUS_BADGE[job.status] ?? 'bg-gray-100 text-gray-500'}`}>
                                {job.mode}
                            </span>
                            <span className="text-[10px] text-gray-400">{durationLabel}</span>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                            {active && (
                                <button
                                    onClick={handleAbort}
                                    disabled={aborting || job.status === 'abort_requested'}
                                    className="text-[10px] text-red-500 hover:text-red-700 font-medium px-2 py-1 border border-red-200 hover:border-red-400 rounded transition disabled:opacity-50"
                                >
                                    {job.status === 'abort_requested' ? 'Aborting…' : aborting ? 'Aborting…' : 'Abort'}
                                </button>
                            )}
                            <button
                                onClick={() => setExpanded((e) => !e)}
                                className="text-[10px] text-gray-400 hover:text-gray-600 px-1"
                                title={expanded ? 'Collapse' : 'Expand'}
                            >
                                {expanded ? '▲' : '▼'}
                            </button>
                            <button
                                onClick={handleDismiss}
                                className="text-gray-400 hover:text-gray-600 text-base leading-none px-1"
                                title="Dismiss"
                            >
                                ×
                            </button>
                        </div>
                    </div>

                    {/* Aggregate counters — single horizontal row */}
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                        <Counter label="fetched" value={job.totals.events_fetched} />
                        <Counter label="new" value={job.totals.events_upserted} />
                        <Counter label="dedup" value={job.totals.events_deduped} />
                        <Counter label="enriched" value={job.totals.events_enriched} />
                        {totalWarnings > 0 && (
                            <Counter label="warnings" value={totalWarnings} highlight="text-amber-600" />
                        )}
                        {totalErrors > 0 && (
                            <Counter label="errors" value={totalErrors} highlight="text-red-500" />
                        )}
                    </div>
                </div>

                {/* ── Expanded body ── */}
                {expanded && (
                    <div className="px-4 py-3 space-y-3">
                        {/* Per-calendar grid */}
                        {calEntries.length > 0 && (
                            <div className="grid grid-cols-1 gap-2">
                                {calEntries.map((cal) => (
                                    <CalendarRow
                                        key={cal.calendar_id}
                                        cal={cal}
                                        onViewDetails={() => setDrawerCalId(cal.calendar_id)}
                                    />
                                ))}
                            </div>
                        )}

                        {/* Recent logs strip — collapsible, all levels */}
                        {recentLogs.length > 0 && (
                            <LogsStrip logs={recentLogs} errorCount={errorLogs.length} />
                        )}

                        {/* Job-level errors */}
                        {job.error_message && (
                            <div className="bg-red-50 border border-red-100 rounded p-2">
                                <p className="text-[10px] text-red-700 break-words">{job.error_message}</p>
                            </div>
                        )}
                        {job.warning_message && (
                            <div className="bg-amber-50 border border-amber-100 rounded p-2">
                                <p className="text-[10px] text-amber-700 break-words">{job.warning_message}</p>
                            </div>
                        )}

                        {/* No calendars yet (job just started) */}
                        {calEntries.length === 0 && active && (
                            <p className="text-xs text-gray-400 text-center py-2 animate-pulse">
                                Starting calendar fetch…
                            </p>
                        )}
                    </div>
                )}
            </div>

            {/* Calendar detail drawer */}
            {drawerCal && (
                <CalendarDetailDrawer
                    cal={drawerCal}
                    jobStatus={job.status}
                    onClose={() => setDrawerCalId(null)}
                    onRefresh={fetchJob}
                />
            )}
        </>
    );
}
