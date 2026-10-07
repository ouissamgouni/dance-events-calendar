import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { deleteOwnSuggestion, fetchMySubmissions, fetchOwnEventChanges, requestOwnSuggestionPublic, withdrawOwnEventChange, withdrawOwnSuggestion, withdrawOwnSuggestionChanges } from '../api';
import { useAuth } from '../context/AuthContext';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import useSubmissionsChanged from '../hooks/useSubmissionsChanged';
import type { OwnEventChange, OwnSuggestion } from '../types';

const FIELD_LABELS: Record<string, string> = {
    title: 'Name',
    location: 'Venue',
    start: 'Time',
    end: 'Time',
    description: 'Description',
    recurrence_rule: 'Dates',
    recurrence_dates: 'Dates',
    price_min: 'Price',
    price_max: 'Price',
    price_currency: 'Price',
    price_is_free: 'Price',
    image_key: 'Picture',
    links: 'Links',
    suggested_tag_ids: 'Tags',
    tag_ids: 'Tags',
    is_cancelled: 'Cancellation',
    cancellation_note: 'Cancellation',
};

function dateLabel(suggestion: OwnSuggestion): string {
    const start = new Date(suggestion.start);
    const end = new Date(suggestion.end);
    if (Number.isNaN(start.getTime())) return '';
    if (suggestion.all_day) return start.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    const sameDay = start.toDateString() === end.toDateString();
    const startText = start.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const endText = Number.isNaN(end.getTime())
        ? null
        : end.toLocaleString(undefined, sameDay ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    return endText ? `${startText} – ${endText}` : startText;
}

function changedFieldLabels(changes: OwnSuggestion['pending_changes']): string[] {
    const labels = new Set<string>();
    Object.keys(changes ?? {}).forEach((field) => labels.add(FIELD_LABELS[field] ?? field.replaceAll('_', ' ')));
    return [...labels];
}

const chipCls = 'rounded-field border px-2 py-1 text-xs font-semibold';

const STATUS_CHIPS: Record<OwnSuggestion['status'], { label: string; cls: string; note?: string }> = {
    private: { label: 'Only you', cls: 'border-blue-100 bg-blue-50 text-action' },
    pending: {
        label: 'Waiting to go public',
        cls: 'border-amber-100 bg-amber-50 text-amber-700',
        note: 'Only you can see it until a curator makes it public.',
    },
    approved: { label: 'Public', cls: 'border-success/20 bg-success/10 text-success' },
    declined: {
        label: 'Only you',
        cls: 'border-blue-100 bg-blue-50 text-action',
        note: "Not published publicly — it's still in your events.",
    },
    blocked: { label: 'Removed', cls: 'border-line bg-canvas text-ink-soft' },
    withdrawn: { label: 'Deleted', cls: 'border-line bg-canvas text-ink-soft' },
};

const OWNED_STATUSES: OwnSuggestion['status'][] = ['private', 'pending', 'declined'];

function SubmissionCard({
    suggestion,
    busy,
    error,
    confirmingDelete,
    onEdit,
    onConfirmDelete,
    onCancelDelete,
    onDelete,
    onRequestPublic,
    onCancelRequest,
    onWithdrawChanges,
}: {
    suggestion: OwnSuggestion;
    busy: boolean;
    error: string;
    confirmingDelete: boolean;
    onEdit: () => void;
    onConfirmDelete: () => void;
    onCancelDelete: () => void;
    onDelete: () => void;
    onRequestPublic: () => void;
    onCancelRequest: () => void;
    onWithdrawChanges: () => void;
}) {
    const hasRecurrence = Boolean(suggestion.recurrence_rule || suggestion.recurrence_dates?.length);
    const changed = changedFieldLabels(suggestion.pending_changes);
    const owned = OWNED_STATUSES.includes(suggestion.status);
    const canView = Boolean(suggestion.created_event_id && (owned || suggestion.status === 'approved'));
    const chip = STATUS_CHIPS[suggestion.status];
    const secondaryBtn = 'rounded-field border border-line bg-surface px-3 py-1.5 text-sm font-semibold text-ink transition hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50';

    return (
        <li className="rounded-card border border-card-line bg-surface p-4">
            <div className="flex gap-3">
                {suggestion.image_thumb_url ? (
                    <img src={suggestion.image_thumb_url} alt="" className="h-20 w-20 shrink-0 rounded-card bg-canvas object-cover" />
                ) : null}
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                        <h2 className="text-base font-semibold text-ink">{suggestion.title}</h2>
                        <span className={`${chipCls} ${chip.cls}`}>{chip.label}</span>
                    </div>
                    <p className="mt-1 text-sm text-ink-soft">{dateLabel(suggestion)}{hasRecurrence ? ' · Repeats' : ''}</p>
                    {suggestion.location ? <p className="mt-1 text-sm text-ink-soft">{suggestion.location}</p> : null}
                    {chip.note ? <p className="mt-2 text-sm text-ink-soft">{chip.note}</p> : null}
                    {suggestion.rejection_reason && (suggestion.status === 'declined' || suggestion.status === 'blocked') ? (
                        <p className="mt-2 text-sm text-ink"><span className="font-medium">Curator note:</span> {suggestion.rejection_reason}</p>
                    ) : null}
                    {suggestion.status === 'approved' && changed.length > 0 ? (
                        <div className="mt-3 rounded-card border border-blue-100 bg-blue-50 p-3 text-sm text-ink">
                            <p className="font-medium">Changes awaiting review</p>
                            <p className="mt-1 text-ink-soft">Changed: {changed.join(', ')}</p>
                            <button type="button" onClick={onWithdrawChanges} disabled={busy} className={`mt-2 ${secondaryBtn} text-xs`}>
                                {busy ? 'Withdrawing…' : 'Withdraw changes'}
                            </button>
                        </div>
                    ) : null}
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                        {canView ? (
                            <Link to={`/event/${suggestion.created_event_id}`} className={secondaryBtn}>View</Link>
                        ) : null}
                        {suggestion.can_edit ? (
                            <button type="button" onClick={onEdit} className={secondaryBtn}>Edit</button>
                        ) : null}
                        {!suggestion.edit_locked && (suggestion.status === 'private' || suggestion.status === 'declined') ? (
                            <button type="button" onClick={onRequestPublic} disabled={busy} className={secondaryBtn}>Ask to make public</button>
                        ) : null}
                        {!suggestion.edit_locked && suggestion.status === 'pending' ? (
                            <button type="button" onClick={onCancelRequest} disabled={busy} className={secondaryBtn}>Keep it private</button>
                        ) : null}
                        {!suggestion.edit_locked && owned && !confirmingDelete ? (
                            <button type="button" onClick={onConfirmDelete} className={secondaryBtn}>Delete</button>
                        ) : null}
                    </div>
                    {confirmingDelete ? (
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                            <span className="text-sm text-ink">Delete this event? Its dates will be removed.</span>
                            <button
                                type="button"
                                onClick={onDelete}
                                disabled={busy}
                                className="rounded-field bg-danger px-3 py-1.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                {busy ? 'Deleting…' : 'Delete'}
                            </button>
                            <button type="button" onClick={onCancelDelete} className={secondaryBtn}>Keep</button>
                        </div>
                    ) : null}
                    {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
                </div>
            </div>
        </li>
    );
}

export default function MySubmissionsPage() {
    const { user } = useAuth();
    const { organizerClaimsEnabled } = useFeatureFlags();

    if (!user) {
        return <div className="mx-auto max-w-xl px-4 py-6 text-sm text-ink-soft"><Link to="/login?next=/me/submissions" className="text-action hover:underline">Sign in</Link> to manage your submissions.</div>;
    }
    if (user.is_verified_organizer && organizerClaimsEnabled) {
        return <Navigate to="/hosting?tab=added" replace />;
    }

    return (
        <div className="mx-auto max-w-xl px-4 py-4">
            <h1 className="text-2xl font-bold text-ink">Events I added</h1>
            <p className="mt-1 text-sm text-ink-soft">Events you added. They stay yours; ask to make one public and a curator will review it.</p>
            <MySubmissionsSection />
        </div>
    );
}

/** The user's submissions and suggested changes; also the Hosting hub's "Added by me" tab. */
export function MySubmissionsSection() {
    const navigate = useNavigate();
    const location = useLocation();
    const [submissions, setSubmissions] = useState<OwnSuggestion[] | null>(null);
    const [error, setError] = useState('');
    const [busyId, setBusyId] = useState<string | null>(null);
    const [rowError, setRowError] = useState<Record<string, string>>({});
    const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
    const [changesVersion, setChangesVersion] = useState(0);

    const load = useCallback(() => {
        setError('');
        fetchMySubmissions()
            .then(setSubmissions)
            .catch((err: unknown) => {
                setSubmissions([]);
                setError(err instanceof Error ? err.message : 'Failed to load your submissions');
            });
    }, []);

    useEffect(load, [load]);
    useSubmissionsChanged(() => {
        load();
        setChangesVersion((v) => v + 1);
    });

    const updateSubmission = (updated: OwnSuggestion) => {
        setSubmissions((rows) => rows?.map((row) => (row.id === updated.id ? updated : row)) ?? [updated]);
    };

    const withRowAction = async (id: string, action: () => Promise<OwnSuggestion>) => {
        setBusyId(id);
        setRowError((prev) => ({ ...prev, [id]: '' }));
        try {
            updateSubmission(await action());
            setConfirmingDeleteId(null);
        } catch (err: unknown) {
            setRowError((prev) => ({ ...prev, [id]: err instanceof Error ? err.message : 'Action failed' }));
        } finally {
            setBusyId(null);
        }
    };

    return (
        <>
            {error ? (
                <div className="mt-4 rounded-card border border-danger/20 bg-danger/10 p-3 text-sm text-danger">
                    {error}
                    <button type="button" onClick={load} className="ml-2 font-semibold underline">Try again</button>
                </div>
            ) : null}
            {submissions === null ? (
                <p className="py-8 text-sm text-muted">Loading...</p>
            ) : submissions.length === 0 ? (
                <div className="py-8 text-sm text-ink-soft">
                    <p>You haven't added any events yet.</p>
                    <Link to="/suggest" state={{ backgroundLocation: location }} className="mt-3 inline-flex min-h-11 items-center rounded-field bg-action px-4 text-sm font-semibold text-white hover:opacity-90">Add an event</Link>
                </div>
            ) : (
                <ul className="mt-4 space-y-3">
                    {submissions.map((suggestion) => (
                        <SubmissionCard
                            key={suggestion.id}
                            suggestion={suggestion}
                            busy={busyId === suggestion.id}
                            error={rowError[suggestion.id] ?? ''}
                            confirmingDelete={confirmingDeleteId === suggestion.id}
                            onEdit={() => navigate(`/suggest/${suggestion.id}/edit`, { state: { backgroundLocation: location } })}
                            onConfirmDelete={() => setConfirmingDeleteId(suggestion.id)}
                            onCancelDelete={() => setConfirmingDeleteId(null)}
                            onDelete={() => withRowAction(suggestion.id, () => deleteOwnSuggestion(suggestion.id))}
                            onRequestPublic={() => withRowAction(suggestion.id, () => requestOwnSuggestionPublic(suggestion.id))}
                            onCancelRequest={() => withRowAction(suggestion.id, () => withdrawOwnSuggestion(suggestion.id))}
                            onWithdrawChanges={() => withRowAction(suggestion.id, () => withdrawOwnSuggestionChanges(suggestion.id))}
                        />
                    ))}
                </ul>
            )}
            <SuggestedChanges version={changesVersion} />
        </>
    );
}

const CHANGE_STATUS: Record<OwnEventChange['status'], { label: string; cls: string }> = {
    pending: { label: 'Waiting for review', cls: 'border-amber-100 bg-amber-50 text-amber-700' },
    accepted: { label: 'Applied', cls: 'border-success/20 bg-success/10 text-success' },
    rejected: { label: 'Not applied', cls: 'border-line bg-canvas text-ink-soft' },
    superseded: { label: 'Replaced by a newer change', cls: 'border-line bg-canvas text-ink-soft' },
    reverted: { label: 'Reverted by a curator', cls: 'border-line bg-canvas text-ink-soft' },
    withdrawn: { label: 'Withdrawn', cls: 'border-line bg-canvas text-ink-soft' },
    closed: { label: 'Closed', cls: 'border-line bg-canvas text-ink-soft' },
};

/** Changes the user suggested to other people's events. */
function SuggestedChanges({ version }: { version: number }) {
    const [changes, setChanges] = useState<OwnEventChange[]>([]);
    const [busyId, setBusyId] = useState<number | null>(null);

    useEffect(() => {
        fetchOwnEventChanges().then(setChanges).catch(() => setChanges([]));
    }, [version]);

    if (changes.length === 0) return null;

    const withdraw = async (id: number) => {
        setBusyId(id);
        try {
            const updated = await withdrawOwnEventChange(id);
            setChanges((rows) => rows.map((row) => (row.id === id ? updated : row)));
        } finally {
            setBusyId(null);
        }
    };

    return (
        <section className="mt-8" aria-label="Changes I suggested">
            <h2 className="text-lg font-bold text-ink">Changes I suggested</h2>
            <ul className="mt-3 space-y-3">
                {changes.map((change) => (
                    <li key={change.id} className="rounded-card border border-card-line bg-surface p-3">
                        <div className="flex flex-wrap items-center gap-2">
                            <Link to={`/event/${change.event_id}`} className="min-w-0 flex-1 truncate text-sm font-semibold text-ink hover:underline">
                                {change.event_title ?? change.event_id}
                            </Link>
                            <span className={`${chipCls} ${CHANGE_STATUS[change.status].cls}`}>
                                {CHANGE_STATUS[change.status].label}
                            </span>
                        </div>
                        <p className="mt-1 text-xs text-ink-soft">Changed: {changedFieldLabels(change.changes).join(', ')}</p>
                        {change.status === 'pending' ? (
                            <button
                                type="button"
                                disabled={busyId === change.id}
                                onClick={() => withdraw(change.id)}
                                className="mt-2 rounded-field border border-line bg-surface px-3 py-1 text-xs font-semibold text-ink hover:bg-canvas disabled:opacity-50"
                            >
                                {busyId === change.id ? 'Withdrawing…' : 'Withdraw'}
                            </button>
                        ) : null}
                    </li>
                ))}
            </ul>
        </section>
    );
}
