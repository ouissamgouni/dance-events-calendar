import { useEffect, useState } from 'react';
import {
    applyEventRevision,
    approveSuggestion,
    discardAdminEventDraft,
    discardEventRevision,
    fetchAdminCalendars,
    publishAdminEventDraft,
    rejectSuggestion,
    revertEventRevision,
    updateEvent,
    updateSuggestion,
} from '../api';
import type { AdminEventModeration, CalendarEvent, CalendarSetting, ChangeScope, EventRevision, RevisionChange } from '../types';
import { describeRevisionValue, hasTimeChange, revisionFieldLabel, statusRequest } from '../utils/eventRevisions';
import { getAdminEventStatus } from '../utils/adminEventStatus';
import SubmissionDetails from './SubmissionDetails';

interface Props {
    event: CalendarEvent;
    moderation: AdminEventModeration;
    /** Reload the event and its moderation state after an action. */
    onChanged: () => void;
}

const cardCls = 'space-y-2 rounded-card border border-card-line bg-surface p-3';
const labelCls = 'text-[11px] font-medium uppercase tracking-wide text-ink-soft';
const primaryBtn = 'bg-action px-3 py-1 text-xs font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50';
const secondaryBtn = 'border border-line bg-surface px-3 py-1 text-xs font-semibold text-ink hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50';

const SOURCE_LABELS: Record<EventRevision['source'], string> = {
    sync: 'Google source',
    admin: 'Admin draft',
    submitter: 'Submitter',
    user: 'Suggested',
    organizer: 'Organizer',
};

const KIND_LABELS: Record<EventRevision['kind'], string> = {
    create: 'New event',
    go_public: 'Go public',
    edit: 'Edit',
    cancel: 'Cancellation',
    remove: 'Removal',
};

const SUBMISSION_STATUS: Record<string, { label: string; cls: string; hint: string }> = {
    private: { label: 'Private', cls: 'bg-blue-50 text-action', hint: 'The owner keeps it to themselves' },
    pending: { label: 'Public request', cls: 'bg-amber-100 text-amber-800', hint: 'The owner asked to make it public' },
    approved: { label: 'Public', cls: 'bg-emerald-50 text-success', hint: 'Made public by a curator' },
    declined: { label: 'Declined', cls: 'bg-blue-50 text-action', hint: 'Asked to go public; a curator kept it private' },
    blocked: { label: 'Removed', cls: 'bg-slate-200 text-ink', hint: 'Removed for everyone, owner included' },
    withdrawn: { label: 'Deleted by owner', cls: 'bg-slate-200 text-ink-soft', hint: 'The owner deleted it' },
};

const DECISION_LABEL: Record<string, string> = {
    approved: 'Made public',
    declined: 'Declined',
    blocked: 'Removed',
};

const OWNER_PRIVATE = ['private', 'declined'];

function DiffList({ changes }: { changes: Record<string, RevisionChange> }) {
    return (
        <ul className="space-y-1">
            {Object.entries(changes).map(([field, change]) => (
                <li key={field} className="text-xs text-ink">
                    <span className="font-medium">{revisionFieldLabel(field)}:</span>{' '}
                    <span className="text-ink-soft line-through">{describeRevisionValue(field, change.old)}</span>{' '}
                    → <span>{describeRevisionValue(field, change.new)}</span>
                </li>
            ))}
        </ul>
    );
}

/** Notify by default only when the time, venue or title changed. */
function notifyByDefault(revision: EventRevision): boolean {
    return revision.material_fields.length > 0;
}

export function NotifyToggle({ revision, checked, onChange, count = revision.affected_attendees }: {
    revision: EventRevision;
    checked: boolean;
    onChange: (v: boolean) => void;
    /** Attendees for the chosen scope; this date's by default. */
    count?: number;
}) {
    return (
        <div>
            <label className={`flex items-center gap-2 text-xs ${count === 0 ? 'text-muted' : 'text-ink'}`}>
                <input
                    type="checkbox"
                    checked={count > 0 && checked}
                    disabled={count === 0}
                    onChange={(e) => onChange(e.target.checked)}
                    className="h-3.5 w-3.5 disabled:cursor-not-allowed"
                />
                {count === 0
                    ? 'Notify attendees (nobody has saved or is going yet)'
                    : `Notify ${count} attendee${count === 1 ? '' : 's'} about this change`}
            </label>
            {count > 0 && (
                <p className="ml-5 text-[11px] text-muted">
                    {notifyByDefault(revision)
                        ? 'On by default: the time, venue or title changed.'
                        : 'Off by default: minor change.'}
                </p>
            )}
        </div>
    );
}

/** Whether a change goes to this date only or to the rest of its series too. */
export function ScopeChoice({ revision, value, onChange, submissionDate = false }: {
    revision: EventRevision;
    value: ChangeScope;
    onChange: (v: ChangeScope) => void;
    /** A date of a submission: the owner's series edits rewrite it. */
    submissionDate?: boolean;
}) {
    if (revision.source === 'submitter') {
        return revision.series_dates > 1 ? (
            <p className="text-[11px] text-ink-soft" data-testid="change-scope">Applies to all {revision.series_dates} upcoming dates.</p>
        ) : null;
    }
    const grouped = revision.group_size > 1;
    if (!grouped && !(revision.series_dates > 1)) return null;
    const timeOnly = !grouped && hasTimeChange(revision.changes);
    return (
        <div className="space-y-0.5" data-testid="change-scope">
            <div role="radiogroup" aria-label="Apply to" className="flex flex-wrap items-center gap-3 text-xs text-ink">
                <label className="flex items-center gap-1.5">
                    <input type="radio" checked={value === 'date'} onChange={() => onChange('date')} className="h-3.5 w-3.5" />
                    This date only
                </label>
                <label className={`flex items-center gap-1.5 ${timeOnly ? 'text-muted' : ''}`}>
                    <input
                        type="radio"
                        checked={value === 'series'}
                        disabled={timeOnly}
                        onChange={() => onChange('series')}
                        className="h-3.5 w-3.5 disabled:cursor-not-allowed"
                    />
                    {grouped ? `All ${revision.group_size} dates with this change` : `All ${revision.series_dates} upcoming dates`}
                </label>
            </div>
            {timeOnly && <p className="text-[11px] text-muted">Time changes apply to this date only.</p>}
            {!timeOnly && value === 'date' && submissionDate && (
                <p className="text-[11px] text-muted">The owner's next edit to the series replaces this date's values.</p>
            )}
        </div>
    );
}

export default function AdminEventModerationSection({ event, moderation, onChanged }: Props) {
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState('');
    const [notify, setNotify] = useState<Record<number, boolean>>({});
    const [scopes, setScopes] = useState<Record<number, ChangeScope>>({});
    const [calendars, setCalendars] = useState<CalendarSetting[]>([]);
    const [approveCalendar, setApproveCalendar] = useState('');
    const [rejecting, setRejecting] = useState(false);
    const [rejectReason, setRejectReason] = useState('');
    const [historyOpen, setHistoryOpen] = useState(false);
    const [detailsOpen, setDetailsOpen] = useState(false);
    const [revertingId, setRevertingId] = useState<number | null>(null);
    const [revertNotify, setRevertNotify] = useState(false);

    const submission = moderation.submission;
    const [ownerNote, setOwnerNote] = useState(submission?.admin_notes ?? '');
    const awaitingApproval = submission?.status === 'pending';
    const lockable = Boolean(submission && !['blocked', 'withdrawn'].includes(submission.status));
    const markable = Boolean(
        submission && OWNER_PRIVATE.includes(submission.status) && getAdminEventStatus(event) === 'new',
    );

    useEffect(() => {
        if (!awaitingApproval) return;
        fetchAdminCalendars()
            .then((rows) => {
                const choices = rows.filter((c) => c.calendar_id !== 'user-submissions');
                setCalendars(choices);
                setApproveCalendar((prev) => prev || choices[0]?.calendar_id || '');
            })
            .catch(() => setCalendars([]));
    }, [awaitingApproval]);

    const run = async (key: string, action: () => Promise<unknown>) => {
        setBusy(key);
        setError('');
        try {
            await action();
            setRejecting(false);
            setRevertingId(null);
            onChanged();
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : 'Action failed');
        } finally {
            setBusy(null);
        }
    };

    const scopeFor = (revision: EventRevision): ChangeScope =>
        revision.source === 'submitter' ? 'date' : scopes[revision.id] ?? 'date';
    const countFor = (revision: EventRevision) =>
        scopeFor(revision) === 'series' ? revision.series_affected_attendees : revision.affected_attendees;
    const notifyFor = (revision: EventRevision) =>
        countFor(revision) > 0 && (notify[revision.id] ?? notifyByDefault(revision));

    return (
        <section className="space-y-3" aria-label="Moderation">
            {submission && (
                <div className={cardCls} data-testid="submission-card">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className={labelCls}>Submitted by</span>
                        {submission.submitter ? (
                            <a href={`/u/${submission.submitter.handle ?? ''}`} className="flex items-center gap-1.5 text-xs font-medium text-action hover:underline">
                                {submission.submitter.avatar_url && (
                                    // eslint-disable-next-line no-restricted-syntax -- circular avatar
                                    <img src={submission.submitter.avatar_url} alt="" className="h-5 w-5 rounded-full object-cover" />
                                )}
                                {submission.submitter.display_name ?? submission.submitter.handle}
                                {submission.submitter.handle && <span className="text-ink-soft">@{submission.submitter.handle}</span>}
                            </a>
                        ) : (
                            <>
                                <span className="text-xs text-ink">{submission.submitter_name ?? submission.submitter_email ?? 'Unknown'}</span>
                                <span className="bg-slate-200 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-soft">Anonymous</span>
                            </>
                        )}
                        <span
                            title={SUBMISSION_STATUS[submission.status]?.hint}
                            className={`ml-auto px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${SUBMISSION_STATUS[submission.status]?.cls ?? 'bg-slate-100 text-ink-soft'}`}
                        >
                            {SUBMISSION_STATUS[submission.status]?.label ?? submission.status}
                        </span>
                    </div>
                    <p className="text-[11px] text-ink-soft">
                        Submitted {new Date(submission.submitted_at).toLocaleString()}
                        {submission.submitter && ` · ${submission.approved_count} made public · ${submission.rejected_count} refused before`}
                        {submission.edit_locked && ' · locked for editing'}
                    </p>
                    {submission.reviewed_by && DECISION_LABEL[submission.status] && (
                        <p className="text-[11px] text-ink-soft">
                            {DECISION_LABEL[submission.status]} by {submission.reviewed_by}
                            {submission.reviewed_at && ` on ${new Date(submission.reviewed_at).toLocaleDateString()}`}
                            {submission.status !== 'approved' && submission.admin_notes && ` — ${submission.admin_notes}`}
                        </p>
                    )}
                    {awaitingApproval && (
                        <p className="text-[11px] text-ink-soft">
                            On approval: {submission.followers_to_notify} follower{submission.followers_to_notify === 1 ? '' : 's'} notified ·{' '}
                            {submission.dates_total} date{submission.dates_total === 1 ? '' : 's'} created ({submission.dates_materialised} previewed now)
                        </p>
                    )}
                    <button
                        type="button"
                        aria-expanded={detailsOpen}
                        onClick={() => setDetailsOpen((v) => !v)}
                        className="text-[11px] font-medium text-action hover:underline"
                    >
                        {detailsOpen ? 'Show less' : 'Show more'}
                    </button>
                    {detailsOpen && <SubmissionDetails suggestionId={submission.suggestion_id} />}
                    {lockable && (
                        <label className="flex items-center gap-1.5 text-xs text-ink">
                            <input
                                type="checkbox"
                                checked={submission.edit_locked}
                                disabled={busy !== null}
                                onChange={(e) => {
                                    const locked = e.target.checked;
                                    run('lock', () => updateSuggestion(submission.suggestion_id, { edit_locked: locked }));
                                }}
                                className="h-3.5 w-3.5"
                            />
                            Lock owner edits
                        </label>
                    )}
                    {lockable && (
                        <div className="space-y-1">
                            <label htmlFor="submission-owner-note" className={labelCls}>
                                Note to the owner (shown if declined or removed)
                            </label>
                            <div className="flex items-start gap-2">
                                <textarea
                                    id="submission-owner-note"
                                    value={ownerNote}
                                    onChange={(e) => setOwnerNote(e.target.value)}
                                    rows={2}
                                    className="min-w-0 flex-1 border border-line px-2 py-1 text-xs"
                                />
                                <button
                                    type="button"
                                    disabled={busy !== null || ownerNote.trim() === (submission.admin_notes ?? '')}
                                    onClick={() => run('note', () => updateSuggestion(submission.suggestion_id, { admin_notes: ownerNote.trim() || null }))}
                                    className={secondaryBtn}
                                >
                                    {busy === 'note' ? 'Saving…' : 'Save note'}
                                </button>
                            </div>
                        </div>
                    )}
                    {rejecting ? (
                        <div className="flex flex-wrap items-center gap-2">
                            <input
                                type="text"
                                value={rejectReason}
                                onChange={(e) => setRejectReason(e.target.value)}
                                placeholder="Reason shown to the owner"
                                aria-label="Reason"
                                className="min-w-0 flex-1 rounded-field border border-line px-2 py-1 text-xs"
                            />
                            <button
                                type="button"
                                disabled={busy !== null}
                                onClick={() =>
                                    run('decline', () => rejectSuggestion(submission.suggestion_id, rejectReason.trim() || undefined))
                                }
                                className={primaryBtn}
                            >
                                {busy === 'decline' ? 'Saving…' : 'Keep private'}
                            </button>
                            <button type="button" onClick={() => setRejecting(false)} className={secondaryBtn}>Cancel</button>
                        </div>
                    ) : (awaitingApproval || markable) && (
                        <div className="flex flex-wrap items-center gap-2" data-testid="submission-actions">
                            <span className="ml-auto" />
                            {markable && (
                                <button
                                    type="button"
                                    disabled={busy !== null}
                                    onClick={() => run('review', () => updateEvent(event.event_id, { status: 'published' }))}
                                    className={primaryBtn}
                                >
                                    {busy === 'review' ? 'Saving…' : 'Mark reviewed'}
                                </button>
                            )}
                            {awaitingApproval && (
                                <>
                                    <select
                                        value={approveCalendar}
                                        onChange={(e) => setApproveCalendar(e.target.value)}
                                        aria-label="Calendar to publish to"
                                        className="rounded-field border border-line bg-surface px-2 py-1 text-xs"
                                    >
                                        {calendars.map((c) => (
                                            <option key={c.calendar_id} value={c.calendar_id}>{c.name}</option>
                                        ))}
                                    </select>
                                    <button
                                        type="button"
                                        disabled={busy !== null || !approveCalendar}
                                        onClick={() => run('approve', () => approveSuggestion(submission.suggestion_id, approveCalendar))}
                                        className={primaryBtn}
                                    >
                                        {busy === 'approve' ? 'Publishing…' : 'Make public'}
                                    </button>
                                    <button type="button" onClick={() => setRejecting(true)} className={secondaryBtn}>Keep private…</button>
                                </>
                            )}
                        </div>
                    )}
                </div>
            )}

            {moderation.draft && (
                <div className={`${cardCls} border-action`} data-testid="draft-bar">
                    <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-ink">
                            Unpublished changes ({Object.keys(moderation.draft.changes).length})
                        </span>
                        <span className="text-[11px] text-ink-soft">The live event is unchanged until you publish.</span>
                    </div>
                    <DiffList changes={moderation.draft.changes} />
                    <ScopeChoice
                        revision={moderation.draft}
                        value={scopeFor(moderation.draft)}
                        onChange={(v) => setScopes((prev) => ({ ...prev, [moderation.draft!.id]: v }))}
                        submissionDate={Boolean(submission)}
                    />
                    <NotifyToggle
                        revision={moderation.draft}
                        count={countFor(moderation.draft)}
                        checked={notifyFor(moderation.draft)}
                        onChange={(v) => setNotify((prev) => ({ ...prev, [moderation.draft!.id]: v }))}
                    />
                    <div className="flex gap-2">
                        <button
                            type="button"
                            disabled={busy !== null}
                            onClick={() => run('publish', () => publishAdminEventDraft(
                                event.event_id,
                                notifyFor(moderation.draft!),
                                scopeFor(moderation.draft!),
                            ))}
                            className={primaryBtn}
                        >
                            {busy === 'publish' ? 'Publishing…' : 'Publish changes'}
                        </button>
                        <button type="button" disabled={busy !== null} onClick={() => run('discard-draft', () => discardAdminEventDraft(event.event_id))} className={secondaryBtn}>
                            Discard
                        </button>
                    </div>
                </div>
            )}

            {moderation.open_revisions.map((revision) => {
                const request = statusRequest(revision.changes);
                return (
                    <div key={revision.id} className={`${cardCls} ${request ? 'border-danger/40' : 'border-amber-300'}`} data-testid="pending-revision">
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs font-semibold text-ink">
                                {request === 'removal' ? 'Removal requested' : request === 'cancellation' ? 'Cancellation requested' : 'Changes pending'}
                            </span>
                            <span className="bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800">
                                {SOURCE_LABELS[revision.source]}
                                {revision.proposed_by && `: ${revision.proposed_by.display_name ?? revision.proposed_by.handle}`}
                            </span>
                            <span className="text-[11px] text-ink-soft">{new Date(revision.updated_at).toLocaleString()}</span>
                        </div>
                        <p className="text-[11px] text-ink-soft">
                            {request
                                ? 'The event stays listed until you decide.'
                                : 'Attendees still see the current version until you apply this.'}
                        </p>
                        <DiffList changes={revision.changes} />
                        <ScopeChoice
                            revision={revision}
                            value={scopeFor(revision)}
                            onChange={(v) => setScopes((prev) => ({ ...prev, [revision.id]: v }))}
                            submissionDate={Boolean(submission)}
                        />
                        <NotifyToggle
                            revision={revision}
                            count={countFor(revision)}
                            checked={notifyFor(revision)}
                            onChange={(v) => setNotify((prev) => ({ ...prev, [revision.id]: v }))}
                        />
                        <div className="flex flex-wrap gap-2">
                            <button
                                type="button"
                                disabled={busy !== null}
                                onClick={() => run(`apply-${revision.id}`, () => applyEventRevision(
                                    revision.id,
                                    notifyFor(revision),
                                    undefined,
                                    scopeFor(revision),
                                ))}
                                className={primaryBtn}
                            >
                                {busy === `apply-${revision.id}`
                                    ? 'Applying…'
                                    : request === 'removal' ? 'Remove' : request === 'cancellation' ? 'Mark cancelled' : 'Apply'}
                            </button>
                            {request && (
                                <button
                                    type="button"
                                    disabled={busy !== null}
                                    onClick={() => run(`apply-${revision.id}`, () => applyEventRevision(
                                        revision.id,
                                        notifyFor(revision),
                                        request === 'removal' ? 'cancelled' : 'removed',
                                        scopeFor(revision),
                                    ))}
                                    className={secondaryBtn}
                                >
                                    {request === 'removal' ? 'Mark cancelled instead' : 'Remove instead'}
                                </button>
                            )}
                            <button
                                type="button"
                                disabled={busy !== null}
                                onClick={() => run(`discard-${revision.id}`, () => discardEventRevision(revision.id, scopeFor(revision)))}
                                className={secondaryBtn}
                            >
                                {request ? 'Keep event' : 'Discard'}
                            </button>
                        </div>
                    </div>
                );
            })}

            {moderation.history.length > 0 && (
                <div>
                    <button type="button" onClick={() => setHistoryOpen((v) => !v)} className="text-xs font-medium text-action hover:underline">
                        {historyOpen ? 'Hide' : 'Show'} change history ({moderation.history.length})
                    </button>
                    {historyOpen && (
                        <ul className="mt-2 space-y-2" data-testid="revision-history">
                            {moderation.history.map((revision) => (
                                <li key={revision.id} className="border-l-2 border-line pl-2">
                                    <p className="text-[11px] text-ink-soft">
                                        <span className="font-medium text-ink">{revision.status}</span> · {KIND_LABELS[revision.kind] ?? revision.kind} · {SOURCE_LABELS[revision.source]}
                                        {revision.proposed_by && ` (${revision.proposed_by.display_name ?? revision.proposed_by.handle})`}
                                        {revision.decided_by && ` · by ${revision.decided_by}`}
                                        {revision.decided_at && ` · ${new Date(revision.decided_at).toLocaleString()}`}
                                        {revision.status === 'accepted' && ` · ${revision.notified_count} notified`}
                                    </p>
                                    <DiffList changes={revision.changes} />
                                    {revision.status === 'accepted' && (revision.source === 'organizer' || revision.source === 'user') && (
                                        revertingId === revision.id ? (
                                            <div className={`${cardCls} mt-2 border-danger/30`} data-testid="revert-confirm">
                                                <p className="text-xs font-semibold text-ink">Revert this change?</p>
                                                <DiffList
                                                    changes={Object.fromEntries(
                                                        Object.entries(revision.changes).map(([f, c]) => [f, { old: c.new, new: c.old }]),
                                                    )}
                                                />
                                                <p className="text-[11px] text-ink-soft">
                                                    Fields edited since this change are left alone.
                                                    {revision.proposed_by && ' The proposer is told it was reverted.'}
                                                </p>
                                                <label className={`flex items-center gap-2 text-xs ${revision.notified_count === 0 ? 'text-muted' : 'text-ink'}`}>
                                                    <input
                                                        type="checkbox"
                                                        checked={revertNotify}
                                                        onChange={(e) => setRevertNotify(e.target.checked)}
                                                        className="h-3.5 w-3.5"
                                                    />
                                                    Notify attendees
                                                    {revision.notified_count > 0 && ` (${revision.notified_count} heard about the change)`}
                                                </label>
                                                <div className="flex gap-2">
                                                    <button
                                                        type="button"
                                                        disabled={busy !== null}
                                                        onClick={() => run(`revert-${revision.id}`, () => revertEventRevision(revision.id, revertNotify))}
                                                        className="bg-danger px-3 py-1 text-xs font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                                                    >
                                                        {busy === `revert-${revision.id}` ? 'Reverting…' : 'Revert'}
                                                    </button>
                                                    <button type="button" disabled={busy !== null} onClick={() => setRevertingId(null)} className={secondaryBtn}>
                                                        Cancel
                                                    </button>
                                                </div>
                                            </div>
                                        ) : (
                                            <button
                                                type="button"
                                                disabled={busy !== null}
                                                onClick={() => {
                                                    setRevertingId(revision.id);
                                                    setRevertNotify(revision.notified_count > 0);
                                                }}
                                                className="mt-1 text-[11px] font-medium text-danger hover:underline disabled:opacity-50"
                                            >
                                                Revert…
                                            </button>
                                        )
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}

            {error && <p className="text-xs text-danger">{error}</p>}
        </section>
    );
}
