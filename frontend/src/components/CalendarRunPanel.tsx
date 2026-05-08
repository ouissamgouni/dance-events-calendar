/**
 * CalendarRunPanel — shared body for per-calendar run details.
 *
 * Used in two contexts:
 *   - CalendarDetailDrawer (live, embedded in SyncProgressCard)
 *   - JobDetailDrawer.CalendarView (post-mortem, embedded in job history drawer)
 *
 * Single source of truth: same tabs, same stat row, same severity split.
 * Tabs: Logs · New · Updated · Duplicates · Price · Issues
 *
 * Pipeline-stage strip is rendered above the tabs (not inside Logs).
 */
import { useMemo, useState } from 'react';
import type {
    CalendarStatus,
    FailureEntry,
    FailureType,
    JobLogEntry,
    LogEntry,
    ProcessedEventSummary,
} from '../api';
import AdminEventDetailPanel from './AdminEventDetailPanel';

const STATUS_BADGE: Record<string, string> = {
    running: 'bg-blue-100 text-blue-700',
    abort_requested: 'bg-amber-100 text-amber-700',
    completed: 'bg-emerald-100 text-emerald-700',
    warning: 'bg-amber-100 text-amber-700',
    failed: 'bg-red-100 text-red-700',
    aborted: 'bg-gray-100 text-gray-600',
    queued: 'bg-gray-100 text-gray-500',
};

const FAILURE_TYPE_LABEL: Record<FailureType, string> = {
    ungeolocated: 'Ungeolocated',
    price_not_found: 'Price not found',
    links_not_found: 'Links not found',
    enrichment_exception: 'Enrichment exception',
    persistence_failed: 'Persistence failed',
};

const STAGE_LABEL: Record<string, string> = {
    link_extraction: 'links',
    price_extraction: 'price',
    geocoding: 'geo',
    persistence: 'save',
};

type CalTab =
    | 'logs'
    | 'synced'
    | 'updated'
    | 'unchanged'
    | 'duplicates'
    | 'price'
    | 'links'
    | 'geo'
    | 'issues';

const isActive = (s: string) => s === 'running' || s === 'abort_requested';

function formatTime(iso: string | null): string {
    if (!iso) return '—';
    try {
        return new Date(iso).toLocaleString();
    } catch {
        return iso;
    }
}

function formatTimeShort(iso: string): string {
    try {
        return new Date(iso).toLocaleTimeString();
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

interface Props {
    cal: CalendarStatus;
    jobStatus: string;
    /** Optional Back link (e.g. job-history "Back to Job") */
    onBack?: () => void;
    /** Optional Retry handler shown when calendar finished with errors */
    onRetry?: () => void;
    retrying?: boolean;
    /** Show calendar id under header (default true) */
    showCalendarId?: boolean;
}

export default function CalendarRunPanel({
    cal,
    jobStatus,
    onBack,
    onRetry,
    retrying = false,
    showCalendarId = true,
}: Props) {
    const [tab, setTab] = useState<CalTab>('logs');
    const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
    const events = cal.processed_events ?? [];

    const synced = events.filter((e) => e.action === 'new');
    const updated = events.filter((e) => e.action === 'updated');
    const unchanged = events.filter((e) => e.action === 'unchanged');
    const duplicates = events.filter((e) => e.action === 'deduped');

    // Enrichment lenses — include any persisted action (new/updated/unchanged/deduped),
    // since enrichment runs before persistence regardless of dedup outcome.
    const persisted = events.filter((e) =>
        ['new', 'updated', 'unchanged', 'deduped'].includes(e.action),
    );
    const priceEnriched = persisted.filter((e) => e.price != null);
    const linksEnriched = persisted.filter((e) => (e.links_count ?? 0) > 0);
    // Ungeolocated = persisted events that should have been geolocated but
    // weren't (no provider). These are the events surfaced under the
    // "Ungeolocated" tab and counted as warnings.
    const ungeolocated = persisted.filter((e) => e.geocode_provider == null);

    // Restrict 'Issues' to actionable severities only (warnings + real errors).
    // 'links_not_found' and 'price_not_found' are intentionally excluded — they
    // are common no-ops, not problems worth surfacing.
    const actionableFailures = (cal.failures ?? []).filter(
        (f) => f.type !== 'links_not_found' && f.type !== 'price_not_found',
    );

    // Severity split (frontend-derived from stage_stats):
    //   geo failures → warnings (orange); persistence/exception → real errors (red).
    //   link/price failures are no longer surfaced.
    const geoFailed = cal.stage_stats?.geocoding?.failed ?? 0;
    const realErrors =
        (cal.failures ?? []).filter(
            (f) =>
                f.type === 'persistence_failed' || f.type === 'enrichment_exception',
        ).length + (cal.error ? 1 : 0);
    // "Issues" = warnings + errors. Link/price extraction failures are NOT
    // counted (they're no-ops, not problems).
    const issuesCount = geoFailed + realErrors;

    const counts: Record<CalTab, number> = {
        logs: cal.logs?.length ?? 0,
        synced: synced.length,
        updated: updated.length,
        unchanged: unchanged.length,
        duplicates: duplicates.length,
        price: priceEnriched.length,
        links: linksEnriched.length,
        geo: ungeolocated.length,
        issues: actionableFailures.length,
    };

    const tabs: { id: CalTab; label: string }[] = [
        { id: 'logs', label: 'Logs' },
        { id: 'synced', label: 'New' },
        { id: 'updated', label: 'Updated' },
        ...(unchanged.length > 0
            ? [{ id: 'unchanged' as CalTab, label: 'Unchanged' }]
            : []),
        { id: 'duplicates', label: 'Duplicates' },
        { id: 'price', label: 'Price found' },
        { id: 'links', label: 'Links found' },
        ...(ungeolocated.length > 0
            ? [{ id: 'geo' as CalTab, label: 'Ungeolocated' }]
            : []),
        ...(actionableFailures.length > 0 || cal.error
            ? [{ id: 'issues' as CalTab, label: 'Issues' }]
            : []),
    ];

    const showRetry =
        !!onRetry &&
        !isActive(jobStatus) &&
        (cal.status === 'failed' || cal.status === 'warning' || cal.enriched_failed > 0);

    return (
        <div className="px-4 py-3 space-y-3 text-xs">
            {onBack && (
                <button
                    onClick={onBack}
                    className="text-xs text-gray-500 hover:text-gray-800 inline-flex items-center gap-1"
                >
                    ← Back to Job
                </button>
            )}

            {/* Header */}
            <div>
                <div className="flex items-center justify-between gap-3 mb-1">
                    <div className="flex items-center gap-2 min-w-0">
                        <h3 className="text-sm font-semibold text-gray-900 truncate">
                            {cal.calendar_name}
                        </h3>
                        <span
                            className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${STATUS_BADGE[cal.status] ?? 'bg-gray-100 text-gray-500'
                                }`}
                        >
                            {cal.status}
                        </span>
                    </div>
                    {showRetry && (
                        <button
                            onClick={onRetry}
                            disabled={retrying}
                            className="text-[11px] px-2.5 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                        >
                            {retrying ? 'Retrying…' : 'Retry'}
                        </button>
                    )}
                </div>
                {showCalendarId && (
                    <div className="text-[10px] text-gray-400 font-mono truncate">{cal.calendar_id}</div>
                )}
            </div>

            {/* Stat row */}
            <div className="bg-gray-50 border border-gray-100 rounded-lg px-3 py-2">
                <div className="grid grid-cols-3 sm:grid-cols-7 gap-3">
                    <Stat
                        label="Duration"
                        value={cal.started_at ? durationLabel(cal.started_at, cal.finished_at) : '—'}
                    />
                    <Stat label="Processed" value={cal.fetched} />
                    <Stat
                        label="New"
                        value={synced.length > 0 ? `+${synced.length}` : 0}
                        tone="text-emerald-600"
                    />
                    <Stat label="Updated" value={updated.length} tone="text-blue-600" />
                    {unchanged.length > 0 && (
                        <Stat label="Unchanged" value={unchanged.length} />
                    )}
                    <Stat label="Duplicates" value={duplicates.length} />
                    {issuesCount > 0 && (
                        <Stat label="Issues" value={issuesCount} tone="text-amber-600" />
                    )}
                </div>
            </div>

            {/* Pipeline stages strip (above tabs) */}
            <PipelineStagesStrip
                stageStats={cal.stage_stats}
                pipelineStage={cal.pipeline_stage}
                // Only show "current operation" while the calendar is actively
                // running. Worker threads can leave a stale value behind after
                // the fetch loop is marked completed (the per-event queue keeps
                // updating it from a different thread).
                currentOperation={
                    cal.status === 'running' ? cal.current_operation : null
                }
            />

            {/* Calendar-level error */}
            {cal.error && (
                <div className="text-[11px] text-red-700 bg-red-50 border border-red-200 rounded px-2.5 py-1.5">
                    {cal.error}
                </div>
            )}

            {/* Tabs */}
            <div className="border-b border-gray-200 -mx-4 px-4 flex items-center gap-1 overflow-x-auto">
                {tabs.map((t) => (
                    <button
                        key={t.id}
                        onClick={() => setTab(t.id)}
                        className={`px-2.5 py-1.5 text-xs font-medium border-b-2 -mb-px whitespace-nowrap ${tab === t.id
                            ? 'border-gray-900 text-gray-900'
                            : 'border-transparent text-gray-500 hover:text-gray-700'
                            }`}
                    >
                        {t.label}{' '}
                        <span className="text-gray-400 font-normal">({counts[t.id]})</span>
                    </button>
                ))}
            </div>

            {/* Tab body */}
            <div>
                {tab === 'logs' && <LogsList logs={cal.logs ?? []} />}
                {tab === 'synced' && <EventsList events={synced} emptyLabel="No new events." onOpenEvent={setSelectedEventId} />}
                {tab === 'updated' && <EventsList events={updated} emptyLabel="No updated events." onOpenEvent={setSelectedEventId} />}
                {tab === 'unchanged' && (
                    <EventsList events={unchanged} emptyLabel="No unchanged events." onOpenEvent={setSelectedEventId} />
                )}
                {tab === 'duplicates' && <EventsList events={duplicates} emptyLabel="No duplicates." onOpenEvent={setSelectedEventId} />}
                {tab === 'price' && (
                    <EventsList
                        events={priceEnriched}
                        emptyLabel="No events with extracted price."
                        onOpenEvent={setSelectedEventId}
                    />
                )}
                {tab === 'links' && (
                    <EventsList
                        events={linksEnriched}
                        emptyLabel="No events with extracted links."
                        onOpenEvent={setSelectedEventId}
                    />
                )}
                {tab === 'geo' && (
                    <EventsList
                        events={ungeolocated}
                        emptyLabel="All persisted events were geolocated."
                        onOpenEvent={setSelectedEventId}
                    />
                )}
                {tab === 'issues' && <FailuresTab failures={actionableFailures} onOpenEvent={setSelectedEventId} />}
            </div>

            <AdminEventDetailPanel
                eventId={selectedEventId}
                onClose={() => setSelectedEventId(null)}
            />
        </div>
    );
}

function Stat({
    label,
    value,
    tone,
}: {
    label: string;
    value: number | string;
    tone?: string;
}) {
    return (
        <div>
            <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-0.5">
                {label}
            </div>
            <div className={`text-sm font-semibold ${(typeof value === 'number' && value === 0) ? 'text-gray-400' : (tone || 'text-gray-900')}`}>{value}</div>
        </div>
    );
}

function levelClass(level: string) {
    if (level === 'ERROR') return 'bg-red-500/20 text-red-300';
    if (level === 'WARNING') return 'bg-amber-500/20 text-amber-300';
    if (level === 'INFO') return 'bg-sky-500/20 text-sky-300';
    if (level === 'DEBUG') return 'bg-gray-500/20 text-gray-300';
    return 'bg-gray-500/20 text-gray-300';
}

// Higher-contrast variant for the filter chips (rendered on a light background,
// where the dark-mode `text-*-300` shade used inside the log rows is too pale).
function levelChipClass(level: string) {
    if (level === 'ERROR') return 'bg-red-100 text-red-700';
    if (level === 'WARNING') return 'bg-amber-100 text-amber-800';
    if (level === 'INFO') return 'bg-sky-100 text-sky-800';
    if (level === 'DEBUG') return 'bg-gray-200 text-gray-700';
    return 'bg-gray-200 text-gray-700';
}

type LogLevel = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';
const LOG_LEVEL_ORDER: LogLevel[] = ['DEBUG', 'INFO', 'WARNING', 'ERROR'];

function PipelineStagesStrip({
    stageStats,
    pipelineStage,
    currentOperation,
}: {
    stageStats?: CalendarStatus['stage_stats'];
    pipelineStage?: string | null;
    currentOperation?: string | null;
}) {
    const stageOrder = ['link_extraction', 'price_extraction', 'geocoding', 'persistence'];
    const visibleStages = stageOrder.filter((s) => stageStats?.[s]);
    if (visibleStages.length === 0) return null;
    return (
        <div className="px-3 py-2 border border-gray-100 rounded bg-gray-50">
            <p className="text-[10px] font-medium text-gray-400 uppercase tracking-wide mb-1">
                Pipeline stages
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {visibleStages.map((s) => {
                    const stat = stageStats![s];
                    const isCurrent = pipelineStage === s;
                    // For link/price stages a "fail" or "skip" just means the
                    // event had no link / no price text — common no-ops, not
                    // problems. Only show the success counter for those.
                    const isOptional =
                        s === 'link_extraction' || s === 'price_extraction';
                    return (
                        <div
                            key={s}
                            className={`px-2 py-1 rounded border ${isCurrent
                                ? 'border-blue-300 bg-blue-50'
                                : 'border-gray-200 bg-white'
                                }`}
                        >
                            <div className="text-[10px] font-medium text-gray-700 capitalize">
                                {STAGE_LABEL[s] ?? s}
                                {isCurrent && (
                                    <span className="ml-1 text-blue-500 animate-pulse">●</span>
                                )}
                            </div>
                            <div className="flex items-center gap-2 text-[10px] mt-0.5">
                                {stat.processed > 0 && <span className="text-emerald-600">{stat.processed} ✓</span>}
                                {isOptional ? (
                                    // For link/price stages, "skip + fail" =
                                    // events with no link / no price text \u2014
                                    // not problems, just not applicable.
                                    (stat.skipped + stat.failed > 0) && (
                                        <span className="text-gray-400">
                                            {stat.skipped + stat.failed} N/A
                                        </span>
                                    )
                                ) : s === 'geocoding' ? (
                                    stat.failed > 0 && (
                                        <span className="text-amber-600">
                                            {stat.failed} ⚠
                                        </span>
                                    )
                                ) : (
                                    <>
                                        {stat.skipped > 0 && (
                                            <span className="text-gray-400">{stat.skipped} skip</span>
                                        )}
                                        {stat.failed > 0 && (
                                            <span className="text-red-500">{stat.failed} fail</span>
                                        )}
                                    </>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
            {currentOperation && (
                <p className="text-[10px] text-blue-600 italic mt-1.5">{currentOperation}</p>
            )}
        </div>
    );
}

function LogsList({ logs }: { logs: LogEntry[] | JobLogEntry[] }) {
    const [activeLevels, setActiveLevels] = useState<Set<LogLevel>>(
        () => new Set(LOG_LEVEL_ORDER),
    );

    const toggleLevel = (lvl: LogLevel) => {
        setActiveLevels((prev) => {
            const next = new Set(prev);
            if (next.has(lvl)) next.delete(lvl);
            else next.add(lvl);
            return next;
        });
    };

    const counts = useMemo(() => {
        const c: Record<LogLevel, number> = { DEBUG: 0, INFO: 0, WARNING: 0, ERROR: 0 };
        for (const l of logs) {
            if (l.level in c) c[l.level as LogLevel]++;
        }
        return c;
    }, [logs]);

    const filtered = useMemo(
        () => (logs ?? []).filter((l) => activeLevels.has(l.level as LogLevel)),
        [logs, activeLevels],
    );

    return (
        <div className="space-y-2">
            {/* Level filter chips */}
            <div className="flex items-center flex-wrap gap-1.5">
                {LOG_LEVEL_ORDER.map((lvl) => {
                    const on = activeLevels.has(lvl);
                    return (
                        <button
                            key={lvl}
                            onClick={() => toggleLevel(lvl)}
                            className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded border transition ${on
                                ? `${levelChipClass(lvl)} border-transparent`
                                : 'bg-transparent text-gray-400 border-gray-200 hover:text-gray-600'
                                }`}
                        >
                            {lvl}
                            <span className="ml-1 font-normal opacity-70">{counts[lvl]}</span>
                        </button>
                    );
                })}
            </div>

            {!logs || logs.length === 0 ? (
                <div className="rounded bg-gray-900 text-gray-400 italic px-3 py-3 text-[11px] font-mono">
                    No log entries.
                </div>
            ) : filtered.length === 0 ? (
                <div className="rounded bg-gray-900 text-gray-500 italic px-3 py-3 text-[11px] font-mono">
                    No logs match the selected levels.
                </div>
            ) : (
                <div className="rounded bg-gray-900 max-h-80 overflow-y-auto divide-y divide-gray-800">
                    {filtered.map((l, i) => (
                        <div
                            key={i}
                            className="px-2.5 py-1.5 flex items-start gap-2 text-[11px] font-mono"
                        >
                            <span className="text-gray-500 text-[10px] flex-shrink-0 w-16">
                                {formatTimeShort(l.timestamp)}
                            </span>
                            <span
                                className={`text-[9px] font-semibold uppercase px-1 py-0.5 rounded flex-shrink-0 ${levelClass(
                                    l.level,
                                )}`}
                            >
                                {l.level}
                            </span>
                            <span className="flex-1 break-words text-gray-100">{l.message}</span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

function EventsList({
    events,
    showError,
    emptyLabel,
    onOpenEvent,
}: {
    events: ProcessedEventSummary[];
    showError?: boolean;
    emptyLabel: string;
    onOpenEvent?: (id: string) => void;
}) {
    const [page, setPage] = useState(0);
    const PAGE = 50;
    const totalPages = Math.max(1, Math.ceil(events.length / PAGE));
    const rows = useMemo(() => events.slice(page * PAGE, (page + 1) * PAGE), [events, page]);

    if (events.length === 0) {
        return <div className="text-[11px] text-gray-400">{emptyLabel}</div>;
    }
    return (
        <div className="space-y-2">
            <div className="divide-y divide-gray-100 border border-gray-100 rounded">
                {rows.map((e, i) => (
                    <div key={`${e.event_id}-${i}`} className="px-2.5 py-1.5">
                        <div className="flex items-baseline gap-2 min-w-0">
                            <button
                                type="button"
                                onClick={() => onOpenEvent?.(e.event_id)}
                                title={e.event_id}
                                className="text-[10px] font-mono text-blue-600 hover:underline flex-shrink-0"
                            >
                                {e.event_id.slice(0, 8)}
                            </button>
                            <div className="text-[11px] text-gray-900 truncate">{e.title}</div>
                        </div>
                        <div className="text-[10px] text-gray-500 flex items-center gap-2">
                            {e.start_dt && <span>{formatTime(e.start_dt)}</span>}
                            {e.location && (
                                <>
                                    <span>·</span>
                                    <span className="truncate">{e.location}</span>
                                </>
                            )}
                            {e.price && (
                                <>
                                    <span>·</span>
                                    <span>${e.price}</span>
                                </>
                            )}
                            {(e.links_count ?? 0) > 0 && (
                                <>
                                    <span>·</span>
                                    <span>🔗 {e.links_count}</span>
                                </>
                            )}
                            {e.geocode_provider && (
                                <>
                                    <span>·</span>
                                    <span>📍 {e.geocode_provider}</span>
                                </>
                            )}
                        </div>
                        {showError && e.error && (
                            <div className="text-[10px] text-red-600 mt-1 break-words">
                                {e.error}
                            </div>
                        )}
                    </div>
                ))}
            </div>
            {totalPages > 1 && (
                <div className="flex items-center justify-between text-[11px]">
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
        </div>
    );
}

function FailuresTab({ failures, onOpenEvent }: { failures: FailureEntry[]; onOpenEvent?: (id: string) => void }) {
    const [typeFilter, setTypeFilter] = useState<FailureType | 'all'>('all');

    if (failures.length === 0) {
        return <div className="text-[11px] text-gray-400">No failures recorded.</div>;
    }

    const counts = failures.reduce<Record<string, number>>((acc, f) => {
        acc[f.type] = (acc[f.type] ?? 0) + 1;
        return acc;
    }, {});
    const typeOrder = (Object.keys(counts) as FailureType[]).sort(
        (a, b) => counts[b] - counts[a],
    );

    const filtered =
        typeFilter === 'all' ? failures : failures.filter((f) => f.type === typeFilter);

    return (
        <div className="space-y-2">
            <div className="flex items-center gap-1.5 flex-wrap">
                <button
                    onClick={() => setTypeFilter('all')}
                    className={`text-[11px] font-medium px-2 py-0.5 rounded border transition ${typeFilter === 'all'
                        ? 'bg-gray-900 text-white border-gray-900'
                        : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                        }`}
                >
                    All ({failures.length})
                </button>
                {typeOrder.map((t) => (
                    <button
                        key={t}
                        onClick={() => setTypeFilter(t)}
                        className={`text-[11px] font-medium px-2 py-0.5 rounded border transition ${typeFilter === t
                            ? 'bg-gray-900 text-white border-gray-900'
                            : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                            }`}
                    >
                        {FAILURE_TYPE_LABEL[t] ?? t} ({counts[t]})
                    </button>
                ))}
            </div>

            <div className="divide-y divide-gray-100 border border-gray-100 rounded">
                {filtered.map((f, i) => (
                    <div key={`${f.event_id}-${f.type}-${i}`} className="px-3 py-2">
                        <div className="flex items-center gap-2 mb-0.5">
                            <span className="text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">
                                {FAILURE_TYPE_LABEL[f.type] ?? f.type}
                            </span>
                            <button
                                type="button"
                                onClick={() => onOpenEvent?.(f.event_id)}
                                title={f.event_id}
                                className="text-[10px] font-mono text-blue-600 hover:underline"
                            >
                                {f.event_id.slice(0, 8)}
                            </button>
                            <span className="text-sm text-gray-900 truncate">{f.title}</span>
                        </div>
                        <div className="text-[11px] text-gray-500 break-words">{f.message}</div>
                        <div className="text-[10px] text-gray-400 mt-0.5">
                            {formatTimeShort(f.timestamp)} · stage: {f.stage}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
