import { useEffect, useState } from 'react';
import {
    fetchAdminSuggestion,
    fetchSuggestionAudit,
    fetchSuggestionOccurrences,
    syncSuggestionToGoogle,
    type SuggestionOccurrence,
} from '../api';
import type { EventSuggestion, SuggestionAuditEntry } from '../types';

const fmtDate = (iso: string) => {
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
};

const labelCls = 'text-[11px] font-medium uppercase tracking-wide text-ink-soft';

/** The "Show more" part of the submission card: submitter, dates, history. */
export default function SubmissionDetails({ suggestionId }: { suggestionId: string }) {
    const [suggestion, setSuggestion] = useState<EventSuggestion | null>(null);
    const [occurrences, setOccurrences] = useState<SuggestionOccurrence[]>([]);
    const [audit, setAudit] = useState<SuggestionAuditEntry[]>([]);
    const [syncing, setSyncing] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        let cancelled = false;
        fetchAdminSuggestion(suggestionId)
            .then((s) => { if (!cancelled) setSuggestion(s); })
            .catch(() => { if (!cancelled) setError('Failed to load the submission.'); });
        fetchSuggestionOccurrences(suggestionId)
            .then((data) => { if (!cancelled) setOccurrences(data.occurrences); })
            .catch(() => { if (!cancelled) setOccurrences([]); });
        fetchSuggestionAudit(suggestionId)
            .then((rows) => { if (!cancelled) setAudit(rows); })
            .catch(() => { if (!cancelled) setAudit([]); });
        return () => { cancelled = true; };
    }, [suggestionId]);

    const handleSync = async () => {
        setSyncing(true);
        setError('');
        try {
            setSuggestion(await syncSuggestionToGoogle(suggestionId));
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : 'Failed to sync.');
        } finally {
            setSyncing(false);
        }
    };

    if (!suggestion) {
        return error ? <p className="text-xs text-danger">{error}</p> : <p className="text-xs text-muted">Loading…</p>;
    }

    return (
        <div className="space-y-3 border-t border-card-line pt-2" data-testid="submission-details">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-ink-soft">
                <div><dt className="inline text-muted">Email: </dt><dd className="inline">{suggestion.submitter_email || '—'}</dd></div>
                {suggestion.submitter_timezone && <div><dt className="inline text-muted">Timezone: </dt><dd className="inline">{suggestion.submitter_timezone}</dd></div>}
            </dl>

            {occurrences.length > 1 && (
                <div>
                    <p className={labelCls}>Dates ({occurrences.length})</p>
                    <ul className="mt-1 max-h-40 divide-y divide-card-line overflow-y-auto border border-card-line">
                        {occurrences.map((o) => (
                            <li key={o.index} className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs text-ink">
                                <span className="min-w-0 truncate">{fmtDate(o.start)}</span>
                                {!o.materialised && <span className="shrink-0 text-[11px] text-ink-soft">created when public</span>}
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {suggestion.status === 'approved' && (
                suggestion.synced_to_google ? (
                    <p className="text-[11px] text-success">✓ Synced to Google Calendar</p>
                ) : (
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[11px] text-amber-700">Not synced to Google Calendar yet</span>
                        <button
                            type="button"
                            onClick={handleSync}
                            disabled={syncing}
                            className="bg-action px-3 py-1 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
                        >
                            {syncing ? 'Syncing…' : 'Sync to Google'}
                        </button>
                    </div>
                )
            )}

            {audit.length > 0 && (
                <div>
                    <p className={labelCls}>History ({audit.length})</p>
                    <ul className="mt-1 space-y-1 text-[11px] text-ink-soft">
                        {audit.map((entry) => (
                            <li key={entry.id}>
                                <span className="font-medium text-ink">{entry.action}</span>
                                {' · '}
                                {entry.actor_admin_email ?? 'owner'}
                                {' · '}
                                {fmtDate(entry.created_at)}
                                {entry.changes && Object.keys(entry.changes).length > 0 && (
                                    <span className="block text-muted">{Object.keys(entry.changes).join(', ')}</span>
                                )}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
            {error && <p className="text-xs text-danger">{error}</p>}
        </div>
    );
}
