import { useEffect, useRef, useState } from 'react';
import {
    approveTagSuggestion,
    bulkReviewTagSuggestions,
    fetchAdminTagSuggestions,
    rejectTagSuggestion,
    runTagSuggestionsForEvent,
} from '../api';
import type { TagSuggestionResponse } from '../types';

interface Props {
    eventId: string;
    /** Called after a suggestion is approved so the parent can refresh
     *  the event's applied-tags list. */
    onApproved?: () => void;
    /** Called whenever the suggestion list changes (approve/reject/re-run). */
    onChanged?: () => void;
}

/**
 * Admin-only block that lists pending auto-generated tag suggestions for a
 * single event and lets the admin approve / reject each one inline.
 *
 * On first mount, if no auto suggestions exist for the event, the heuristic
 * engine is auto-invoked once. The "Re-run" button discards existing pending
 * auto suggestions and asks the engine for a fresh set.
 *
 * Visual style mirrors the dashed-border placeholder boxes used elsewhere in
 * AdminEventDetailContent so the section blends with the surrounding fields.
 */
export default function AdminAutoTagSuggestions({ eventId, onApproved, onChanged }: Props) {
    const [suggestions, setSuggestions] = useState<TagSuggestionResponse[]>([]);
    const [loading, setLoading] = useState(false);
    const [running, setRunning] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [actionInFlight, setActionInFlight] = useState<number | null>(null);
    // Guards the initial auto-run so React strict-mode double-mount doesn't
    // hit the suggest endpoint twice for the same event.
    const autoRanFor = useRef<string | null>(null);

    const reload = async () => {
        setLoading(true);
        setError(null);
        try {
            // Show all pending suggestions for this event — user-submitted as
            // well as heuristic auto-suggestions — so the admin reviews
            // everything in one place.
            const rows = await fetchAdminTagSuggestions({
                status: 'pending',
                eventId,
            });
            setSuggestions(rows);
            return rows;
        } catch (e) {
            setError((e as Error).message || 'Failed to load suggestions');
            return [] as TagSuggestionResponse[];
        } finally {
            setLoading(false);
        }
    };

    // First load + auto-run when no auto suggestions exist yet.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const rows = await reload();
            if (cancelled) return;
            if (rows.length === 0 && autoRanFor.current !== eventId) {
                autoRanFor.current = eventId;
                await runEngine(false);
            }
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [eventId]);

    const runEngine = async (replace: boolean) => {
        setRunning(true);
        setError(null);
        try {
            await runTagSuggestionsForEvent(eventId, { replaceExistingPending: replace });
            await reload();
            onChanged?.();
        } catch (e) {
            setError((e as Error).message || 'Failed to generate suggestions');
        } finally {
            setRunning(false);
        }
    };

    const handleApprove = async (s: TagSuggestionResponse) => {
        setActionInFlight(s.id);
        try {
            await approveTagSuggestion(s.id);
            setSuggestions((prev) => prev.filter((row) => row.id !== s.id));
            onApproved?.();
            onChanged?.();
        } catch (e) {
            setError((e as Error).message || 'Approve failed');
        } finally {
            setActionInFlight(null);
        }
    };

    const handleReject = async (s: TagSuggestionResponse) => {
        setActionInFlight(s.id);
        try {
            await rejectTagSuggestion(s.id);
            setSuggestions((prev) => prev.filter((row) => row.id !== s.id));
            onChanged?.();
        } catch (e) {
            setError((e as Error).message || 'Reject failed');
        } finally {
            setActionInFlight(null);
        }
    };

    const [bulkBusy, setBulkBusy] = useState(false);

    const handleApproveAll = async () => {
        if (suggestions.length === 0) return;
        setBulkBusy(true);
        setError(null);
        try {
            const ids = suggestions.map((s) => s.id);
            const { ok, skipped } = await bulkReviewTagSuggestions(ids, 'approve');
            setSuggestions((prev) => prev.filter((s) => !ids.includes(s.id)));
            if (ok > 0) {
                onApproved?.();
                onChanged?.();
            }
            if (skipped > 0) setError(`${skipped} suggestion${skipped === 1 ? '' : 's'} skipped — need manual review.`);
        } catch (e) {
            setError((e as Error).message || 'Approve all failed');
        } finally {
            setBulkBusy(false);
        }
    };

    const handleRejectAll = async () => {
        if (suggestions.length === 0) return;
        setBulkBusy(true);
        setError(null);
        try {
            const ids = suggestions.map((s) => s.id);
            const { ok } = await bulkReviewTagSuggestions(ids, 'reject');
            setSuggestions((prev) => prev.filter((s) => !ids.includes(s.id)));
            if (ok > 0) onChanged?.();
        } catch (e) {
            setError((e as Error).message || 'Reject all failed');
        } finally {
            setBulkBusy(false);
        }
    };

    const busy = loading || running || bulkBusy;
    const hasAny = suggestions.length > 0;

    if (!hasAny && !busy && !error) {
        // Compact "no suggestions" footer with a re-run affordance, so admins
        // can still trigger the engine on events where it produced nothing.
        return (
            <div className="flex items-center justify-between text-[11px] text-slate-400 border border-dashed border-slate-200 rounded px-3 py-1.5">
                <span>No tag suggestions for this event.</span>
                <button
                    type="button"
                    onClick={() => runEngine(true)}
                    className="text-sky-600 hover:text-sky-800 font-medium"
                >
                    Re-run
                </button>
            </div>
        );
    }

    return (
        <div className="border border-slate-200 rounded-lg bg-slate-50 overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 border-b border-slate-200 bg-white">
                <div className="flex items-center gap-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                        Suggested tags
                    </span>
                    {busy && <span className="text-[10px] text-slate-400">Working…</span>}
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                        type="button"
                        onClick={() => runEngine(true)}
                        disabled={busy}
                        className="text-[11px] text-sky-600 hover:text-sky-800 disabled:text-slate-300 px-1"
                    >
                        Re-run
                    </button>
                    <button
                        type="button"
                        onClick={handleApproveAll}
                        disabled={busy || actionInFlight !== null}
                        className="px-2 py-0.5 text-[11px] bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-40"
                        aria-label="Approve all suggestions"
                        title="Approve all"
                    >
                        ✓
                    </button>
                    <button
                        type="button"
                        onClick={handleRejectAll}
                        disabled={busy || actionInFlight !== null}
                        className="px-2 py-0.5 text-[11px] bg-slate-200 text-slate-700 hover:bg-slate-300 disabled:opacity-40"
                        aria-label="Reject all suggestions"
                        title="Reject all"
                    >
                        ✗
                    </button>

                </div>
            </div>
            {error && <p className="px-3 py-1.5 text-[11px] text-slate-600">{error}</p>}
            <ul className="divide-y divide-slate-200">
                {suggestions.map((s) => (
                    <SuggestionRow
                        key={s.id}
                        suggestion={s}
                        disabled={actionInFlight !== null && actionInFlight !== s.id}
                        loading={actionInFlight === s.id}
                        onApprove={() => handleApprove(s)}
                        onReject={() => handleReject(s)}
                    />
                ))}
            </ul>
        </div>
    );
}

function SuggestionRow({
    suggestion,
    disabled,
    loading,
    onApprove,
    onReject,
}: {
    suggestion: TagSuggestionResponse;
    disabled: boolean;
    loading: boolean;
    onApprove: () => void;
    onReject: () => void;
}) {
    const tag = suggestion.tag;
    const isHeuristic = suggestion.source === 'heuristic';
    const confidencePct = suggestion.confidence != null
        ? Math.round(suggestion.confidence * 100)
        : null;
    const matchedTitle = suggestion.matched_terms && suggestion.matched_terms.length > 0
        ? `Matched: ${suggestion.matched_terms.join(', ')}`
        : isHeuristic
            ? 'Heuristic match'
            : 'User-submitted suggestion';

    return (
        <li className="flex items-center justify-between gap-2 px-3 py-2">
            <div className="flex items-center gap-2 min-w-0">
                <ConfidenceDot confidence={suggestion.confidence ?? 0} />
                <span
                    className="text-xs font-medium text-slate-700 truncate"
                    title={matchedTitle}
                >
                    {tag ? (
                        <>
                            <span className="text-slate-400">{tag.group_label}:</span>{' '}
                            <span style={tag.color ? { color: tag.color } : undefined}>{tag.label}</span>
                        </>
                    ) : (
                        suggestion.free_text || '(unnamed)'
                    )}
                </span>
                <SourceBadge source={suggestion.source} />
                {confidencePct != null && (
                    <span className="text-[10px] text-slate-400 tabular-nums">{confidencePct}%</span>
                )}
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
                <button
                    type="button"
                    onClick={onApprove}
                    disabled={disabled || loading}
                    className="px-2 py-0.5 text-[11px] bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-40"
                    aria-label="Approve suggestion"
                >
                    ✓
                </button>
                <button
                    type="button"
                    onClick={onReject}
                    disabled={disabled || loading}
                    className="px-2 py-0.5 text-[11px] bg-slate-200 text-slate-700 hover:bg-slate-300 disabled:opacity-40"
                    aria-label="Reject suggestion"
                >
                    ✗
                </button>
            </div>
        </li>
    );
}

function ConfidenceDot({ confidence }: { confidence: number }) {
    // Colour-codes the dot so admins can visually triage high-confidence rows
    // without reading the percentage.
    let cls = 'bg-slate-300';
    if (confidence >= 0.9) cls = 'bg-emerald-500';
    else if (confidence >= 0.75) cls = 'bg-emerald-400';
    else if (confidence >= 0.6) cls = 'bg-amber-400';
    else if (confidence > 0) cls = 'bg-slate-400';
    return <span className={`inline-block w-2 h-2 rounded-full ${cls}`} aria-hidden="true" />;
}

function SourceBadge({ source }: { source?: string }) {
    // Surface where the suggestion came from so admins can distinguish
    // heuristic engine output from end-user submissions at a glance.
    if (source === 'heuristic') {
        return (
            <span
                className="px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide bg-indigo-50 text-indigo-700"
                title="Generated by the heuristic tag engine"
            >
                Auto
            </span>
        );
    }
    if (source === 'user') {
        return (
            <span
                className="px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide bg-amber-50 text-amber-700"
                title="Submitted by an end user"
            >
                User
            </span>
        );
    }
    if (!source) return null;
    return (
        <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide bg-slate-100 text-slate-600">
            {source}
        </span>
    );
}
