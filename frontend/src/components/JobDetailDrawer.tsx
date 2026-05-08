/**
 * JobDetailDrawer — right slide-over showing a sync job and per-calendar drill-down.
 *
 * Two views in the same drawer (single-pane navigation):
 *   1. JOB view      — header + status + stat row + Calendar Runs cards.
 *   2. CALENDAR view — Back link + calendar header + stat row + tabs:
 *                      Logs · New · Updated · Duplicates · Price · Issues.
 *
 * Polls every 2s while job is active.
 */
import { useEffect, useRef, useState } from 'react';
import type {
    CalendarStatus,
    SyncJobRecord,
} from '../api';
import { getSyncJob, retryCalendarInJob } from '../api';
import { useToast } from './Toast';
import CalendarRunPanel from './CalendarRunPanel';

interface JobDetailDrawerProps {
    jobId: string;
    onClose: () => void;
}

const STATUS_BADGE: Record<string, string> = {
    running: 'bg-blue-100 text-blue-700',
    processing: 'bg-violet-100 text-violet-700',
    abort_requested: 'bg-amber-100 text-amber-700',
    completed: 'bg-emerald-100 text-emerald-700',
    warning: 'bg-amber-100 text-amber-700',
    failed: 'bg-red-100 text-red-700',
    aborted: 'bg-gray-100 text-gray-600',
    idle: 'bg-gray-100 text-gray-500',
    queued: 'bg-gray-100 text-gray-500',
};

const isActive = (s: string) => s === 'running' || s === 'abort_requested';

function formatTime(iso: string | null): string {
    if (!iso) return '—';
    try {
        return new Date(iso).toLocaleString();
    } catch {
        return iso;
    }
}

function durationLabel(start: string, end: string | null): string {
    const s = new Date(start).getTime();
    const e = end ? new Date(end).getTime() : Date.now();
    const secs = Math.max(0, (e - s) / 1000);
    if (secs < 60) return `${Math.round(secs)}s`;
    const m = Math.floor(secs / 60);
    const sec = Math.round(secs % 60);
    return `${m}m ${sec}s`;
}

export default function JobDetailDrawer({ jobId, onClose }: JobDetailDrawerProps) {
    const [job, setJob] = useState<SyncJobRecord | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [openCalId, setOpenCalId] = useState<string | null>(null);
    const [retrying, setRetrying] = useState<string | null>(null);
    const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const toast = useToast();

    const refresh = async () => {
        try {
            const j = await getSyncJob(jobId);
            setJob(j);
            setError(null);
            if (!isActive(j.status) && pollingRef.current) {
                clearInterval(pollingRef.current);
                pollingRef.current = null;
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    };

    useEffect(() => {
        refresh();
        pollingRef.current = setInterval(refresh, 2000);
        return () => {
            if (pollingRef.current) clearInterval(pollingRef.current);
            pollingRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [jobId]);

    const handleRetry = async (calendarId: string, calendarName: string) => {
        setRetrying(calendarId);
        try {
            const newJob = await retryCalendarInJob(jobId, calendarId);
            toast.push({
                title: `Retrying ${calendarName}`,
                message: `New job ${newJob.job_id.slice(0, 8)} started`,
                variant: 'info',
            });
        } catch (e) {
            toast.push({
                title: 'Retry failed',
                message: e instanceof Error ? e.message : String(e),
                variant: 'error',
            });
        } finally {
            setRetrying(null);
        }
    };

    const calendarList: CalendarStatus[] = job
        ? Object.values(job.calendar_statuses).sort((a, b) =>
            a.calendar_name.localeCompare(b.calendar_name),
        )
        : [];

    const openCal = openCalId
        ? job?.calendar_statuses[openCalId] ?? null
        : null;

    return (
        <>
            <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />
            <div
                className="fixed top-0 right-0 h-full w-full sm:w-[1100px] max-w-[95vw] bg-white shadow-xl border-l border-gray-200 z-50 flex flex-col"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200">
                    <h2 className="text-xs font-semibold text-gray-900">
                        Job <span className="text-gray-500">#{jobId.slice(0, 8)}</span>
                    </h2>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={refresh}
                            className="text-gray-400 hover:text-gray-600 text-sm"
                            title="Refresh"
                            aria-label="Refresh"
                        >
                            ↻
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

                {/* Body */}
                <div className="flex-1 overflow-y-auto">
                    {error && (
                        <div className="px-4 py-2 text-[11px] text-red-600">{error}</div>
                    )}
                    {!job && !error && (
                        <div className="px-4 py-3 text-[11px] text-gray-400">Loading…</div>
                    )}
                    {job && !openCal && (
                        <JobView
                            job={job}
                            calendars={calendarList}
                            onOpenCalendar={setOpenCalId}
                        />
                    )}
                    {job && openCal && (
                        <CalendarRunPanel
                            cal={openCal}
                            jobStatus={job.status}
                            retrying={retrying === openCal.calendar_id}
                            onBack={() => setOpenCalId(null)}
                            onRetry={() =>
                                handleRetry(openCal.calendar_id, openCal.calendar_name)
                            }
                        />
                    )}
                </div>
            </div>
        </>
    );
}

// ============================================================================
// JOB VIEW
// ============================================================================
function JobView({
    job,
    calendars,
    onOpenCalendar,
}: {
    job: SyncJobRecord;
    calendars: CalendarStatus[];
    onOpenCalendar: (id: string) => void;
}) {
    const totals = job.totals;
    const calsArr = calendars;

    // Aggregated severity split (mirrors SyncProgressCard / CalendarRunPanel).
    // "Issues" = warnings (geocoding failures) + errors (persistence failures,
    // unhandled exceptions, calendar-level errors). Link- and price-extraction
    // failures are NOT counted — they're no-ops (event simply has no link /
    // no parseable price text).
    const totalIssues = calsArr.reduce((n, c) => {
        const warnings = c.stage_stats?.geocoding?.failed ?? 0;
        const errors =
            (c.failures ?? []).filter(
                (f) =>
                    f.type === 'persistence_failed' ||
                    f.type === 'enrichment_exception',
            ).length + (c.error ? 1 : 0);
        return n + warnings + errors;
    }, 0);

    // Aggregate New/Updated from per-calendar processed_events so the totals
    // match the per-calendar rows and detail panel exactly.
    const totalNew = calsArr.reduce(
        (n, c) => n + (c.processed_events ?? []).filter((e) => e.action === 'new').length,
        0,
    );
    const totalUpdated = calsArr.reduce(
        (n, c) => n + (c.processed_events ?? []).filter((e) => e.action === 'updated').length,
        0,
    );

    const stats: { label: string; value: number; tone?: string }[] = [
        { label: 'Calendars', value: totals.calendars_synced },
        { label: 'Fetched', value: totals.events_fetched },
        { label: 'New', value: totalNew, tone: 'text-emerald-600' },
        { label: 'Updated', value: totalUpdated, tone: 'text-blue-600' },
        { label: 'Duplicates', value: totals.events_deduped },
        ...(totalIssues > 0
            ? [{ label: 'Issues', value: totalIssues, tone: 'text-amber-600' }]
            : []),
    ];

    return (
        <div className="px-4 py-3 space-y-4 text-xs">
            {/* Status + meta */}
            <div className="space-y-2">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <span
                            className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium ${STATUS_BADGE[job.status] ?? 'bg-gray-100 text-gray-500'
                                }`}
                        >
                            {job.status}
                        </span>
                        {job.is_stale && (
                            <span
                                className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-orange-50 text-orange-700 border border-orange-200"
                                title="No heartbeat received — worker likely crashed"
                            >
                                stale
                            </span>
                        )}
                    </div>
                </div>
                <div className="text-[11px] text-gray-500 flex items-center gap-3 flex-wrap">
                    <span className="flex items-center gap-1">
                        🕐 Started: {formatTime(job.started_at)}
                    </span>
                    <span>Duration: {durationLabel(job.started_at, job.finished_at)}</span>
                    {job.mode && (
                        <span className="capitalize text-gray-400">· {job.mode}</span>
                    )}
                </div>
            </div>

            {/* Stat row */}
            <div className="bg-gray-50 border border-gray-100 rounded-lg px-3 py-2">
                <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
                    {stats.map((s) => (
                        <div key={s.label}>
                            <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-0.5">
                                {s.label}
                            </div>
                            <div className={`text-sm font-semibold ${s.value === 0 ? 'text-gray-400' : (s.tone ?? 'text-gray-900')}`}>
                                {s.value > 0 && s.tone === 'text-emerald-600' ? `+${s.value}` : s.value}
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {/* Messages */}
            {(job.error_message || job.warning_message) && (
                <div className="space-y-1.5">
                    {job.error_message && (
                        <div className="text-[11px] text-red-700 bg-red-50 border border-red-200 rounded px-2.5 py-1.5">
                            {job.error_message}
                        </div>
                    )}
                    {job.warning_message && (
                        <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2.5 py-1.5">
                            {job.warning_message}
                        </div>
                    )}
                </div>
            )}

            {/* Calendar Runs */}
            <div>
                <h3 className="text-xs font-semibold text-gray-800 mb-2">
                    Calendar Runs
                </h3>
                {calendars.length === 0 ? (
                    <div className="text-[11px] text-gray-400">No calendars in this job.</div>
                ) : (
                    <div className="space-y-2">
                        {calendars.map((c) => (
                            <CalendarRunCard
                                key={c.calendar_id}
                                cal={c}
                                onClick={() => onOpenCalendar(c.calendar_id)}
                            />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

function CalendarRunCard({
    cal,
    onClick,
}: {
    cal: CalendarStatus;
    onClick: () => void;
}) {
    const warnings = cal.stage_stats?.geocoding?.failed ?? 0;
    const errs =
        (cal.failures ?? []).filter(
            (f) =>
                f.type === 'persistence_failed' || f.type === 'enrichment_exception',
        ).length + (cal.error ? 1 : 0);
    const issues = warnings + errs;
    // Derive new/updated counts from processed_events so the row matches the
    // detail panel exactly (cal.enriched_ok / cal.upserted are different
    // metrics that conflate persistence vs. action-classified events).
    const events = cal.processed_events ?? [];
    const newCount = events.filter((e) => e.action === 'new').length;
    const updatedCount = events.filter((e) => e.action === 'updated').length;
    return (
        <button
            onClick={onClick}
            className="w-full text-left bg-white border border-gray-200 hover:border-gray-300 hover:shadow-sm rounded-lg px-3 py-2 transition flex items-center gap-3"
        >
            <span
                className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0 ${STATUS_BADGE[cal.status] ?? 'bg-gray-100 text-gray-500'
                    }`}
            >
                {cal.status}
            </span>
            <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-gray-900 truncate">
                    {cal.calendar_name}
                </div>
                <div className="text-[10px] text-gray-400 truncate font-mono">
                    {cal.calendar_id}
                </div>
            </div>
            <div className="hidden sm:flex items-center gap-4 text-[11px] flex-shrink-0">
                <Stat label="Processed" value={cal.fetched} />
                <Stat label="New" value={newCount} tone="text-emerald-600" prefix="+" />
                <Stat label="Updated" value={updatedCount} tone="text-blue-600" />
                {issues > 0 && <Stat label="Issues" value={issues} tone="text-amber-600" />}
            </div>
            <span className="text-gray-300 text-base flex-shrink-0">›</span>
        </button>
    );
}

function Stat({
    label,
    value,
    tone,
    prefix,
}: {
    label: string;
    value: number;
    tone?: string;
    prefix?: string;
}) {
    return (
        <div className="text-right">
            <div className="text-[9px] text-gray-400 uppercase tracking-wide">{label}</div>
            <div className={`text-xs font-semibold ${value === 0 ? 'text-gray-400' : (tone ?? 'text-gray-700')}`}>
                {prefix && value > 0 ? prefix : ''}
                {value}
            </div>
        </div>
    );
}

// ============================================================================
// CALENDAR VIEW — delegated to the shared <CalendarRunPanel> component.
// ============================================================================
