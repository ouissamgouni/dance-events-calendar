import { useEffect, useState } from 'react';
import { ExternalLink, X } from 'lucide-react';
import useBackToClose from '../hooks/useBackToClose';
import { decideOrganizerClaim, fetchAdminOrganizerClaims } from '../api';
import { notifyAdminDataChanged } from '../hooks/useAdminCounters';
import type { OrganizerClaimAdmin } from '../types';
import BottomSheet from './BottomSheet';

interface Props {
    isOpen: boolean;
    onClose: () => void;
}

const TABS = ['pending', 'approved', 'rejected'] as const;
type Tab = typeof TABS[number];
const TAB_LABELS: Record<Tab, string> = { pending: 'To review', approved: 'Approved', rejected: 'Not approved' };

const REJECT_REASONS = [
    "We couldn't confirm you organize these events.",
    'Please add links that show your organizer activity.',
    'This event is organized by someone else.',
];

function formatDate(iso: string | null | undefined) {
    return iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
}

function claimantName(c: OrganizerClaimAdmin) {
    return c.user_display_name ?? (c.user_handle ? `@${c.user_handle}` : c.user_email ?? 'user');
}

function Avatar({ url, size }: { url: string | null; size: 'sm' | 'lg' }) {
    const cls = size === 'lg' ? 'h-12 w-12' : 'h-10 w-10';
    return url ? (
        // eslint-disable-next-line no-restricted-syntax -- avatar is a circle by design
        <img src={url} alt="" className={`${cls} shrink-0 rounded-full object-cover`} />
    ) : (
        // eslint-disable-next-line no-restricted-syntax -- avatar placeholder is a circle by design
        <span className={`${cls} shrink-0 rounded-full bg-canvas`} aria-hidden />
    );
}

/**
 * Admin review queue for organizer requests: full-screen on mobile, a wide
 * side panel on desktop. Tapping a request opens a review sheet with the
 * claimant's trust signals and one decision per event.
 */
export default function OrganizerClaimsAdminPanel({ isOpen, onClose }: Props) {
    const [tab, setTab] = useState<Tab>('pending');
    const [rows, setRows] = useState<OrganizerClaimAdmin[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [selected, setSelected] = useState<OrganizerClaimAdmin | null>(null);
    const [counts, setCounts] = useState<Partial<Record<Tab, number>>>({});
    const [countsToken, setCountsToken] = useState(0);
    useBackToClose(onClose, isOpen && selected === null);

    useEffect(() => {
        if (!isOpen) return;
        let cancelled = false;
        Promise.all(TABS.map((t) => fetchAdminOrganizerClaims(t).then((list) => [t, list.length] as const)))
            .then((entries) => { if (!cancelled) setCounts(Object.fromEntries(entries)); })
            .catch(() => { });
        return () => { cancelled = true; };
    }, [isOpen, countsToken]);

    useEffect(() => {
        if (!isOpen) return;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- per-tab fetch lifecycle
        setLoading(true);
        setError(null);
        fetchAdminOrganizerClaims(tab)
            .then(setRows)
            .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
            .finally(() => setLoading(false));
    }, [isOpen, tab]);

    if (!isOpen) return null;

    const onDecided = (updated: OrganizerClaimAdmin) => {
        setSelected(null);
        setRows((prev) => prev.filter((r) => r.id !== updated.id));
        setCountsToken((n) => n + 1);
        notifyAdminDataChanged();
    };

    return (
        <div className="fixed inset-0 z-[9000] flex justify-end" role="dialog" aria-modal="true" aria-label="Organizer requests">
            <button type="button" aria-label="Close" className="hidden flex-1 bg-black/30 md:block" onClick={onClose} />
            <div className="flex h-full w-full flex-col bg-canvas shadow-xl md:max-w-2xl">
                <div className="flex items-center justify-between border-b border-line bg-surface px-4 py-3" style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}>
                    <h2 className="text-lg font-bold text-ink">Organizer requests</h2>
                    <button type="button" onClick={onClose} aria-label="Close" className="flex h-11 w-11 items-center justify-center text-ink-soft hover:text-ink">
                        <X className="h-5 w-5" aria-hidden />
                    </button>
                </div>

                <div role="tablist" className="flex gap-2 overflow-x-auto border-b border-line bg-surface px-4 py-2">
                    {TABS.map((t) => (
                        <button
                            key={t}
                            type="button"
                            role="tab"
                            aria-selected={tab === t}
                            onClick={() => setTab(t)}
                            className={`min-h-9 shrink-0 rounded-field border px-3 text-sm font-semibold ${tab === t ? 'border-action bg-action text-white' : 'border-line bg-surface text-ink-soft hover:border-action hover:text-action'}`}
                        >
                            {TAB_LABELS[t]}{counts[t] !== undefined ? ` (${counts[t]})` : ''}
                        </button>
                    ))}
                </div>

                {error && <p role="alert" className="border-b border-danger/20 bg-danger/10 px-4 py-2 text-sm text-danger">{error}</p>}

                <div className="flex-1 overflow-y-auto px-4 py-3" style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
                    {loading ? (
                        <p className="py-8 text-center text-sm text-muted">Loading…</p>
                    ) : rows.length === 0 ? (
                        <p className="py-8 text-center text-sm text-ink-soft">
                            {tab === 'pending' ? 'Nothing to review. 🎉' : 'No requests.'}
                        </p>
                    ) : (
                        <ul className="space-y-3">
                            {rows.map((c) => (
                                <li key={c.id}>
                                    <button
                                        type="button"
                                        onClick={() => setSelected(c)}
                                        className="flex w-full items-center gap-3 rounded-card border border-card-line bg-surface p-3 text-left hover:border-action"
                                    >
                                        <Avatar url={c.user_avatar_url} size="sm" />
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate text-sm font-semibold text-ink">{claimantName(c)}</span>
                                            <span className="block truncate text-xs text-ink-soft">
                                                {c.kind === 'badge' && !c.user_is_verified_organizer ? 'Organizer request' : 'Event claim'}
                                                {c.events.length > 0 ? ` · ${c.events.length} event${c.events.length === 1 ? '' : 's'}` : ''}
                                                {' · '}{formatDate(c.created_at)}
                                            </span>
                                        </span>
                                        {c.events.some((e) => e.current_organizer_handle || e.competing_pending_claims) && (
                                            <span className="shrink-0 bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700">Conflict</span>
                                        )}
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </div>
            {selected && (
                <ClaimReviewSheet key={selected.id} claim={selected} onClose={() => setSelected(null)} onDecided={onDecided} />
            )}
        </div>
    );
}

function ClaimReviewSheet({
    claim,
    onClose,
    onDecided,
}: {
    claim: OrganizerClaimAdmin;
    onClose: () => void;
    onDecided: (c: OrganizerClaimAdmin) => void;
}) {
    const pending = claim.status === 'pending';
    const takenByOther = (e: OrganizerClaimAdmin['events'][number]) =>
        Boolean(e.current_organizer_handle && e.current_organizer_handle !== claim.user_handle);
    const [decisions, setDecisions] = useState<Record<string, 'approved' | 'rejected'>>(() =>
        Object.fromEntries(claim.events.map((e) => [
            e.event_id,
            e.decision === 'pending' ? (takenByOther(e) ? 'rejected' : 'approved') : e.decision,
        ])),
    );
    const [notes, setNotes] = useState(claim.admin_notes ?? '');
    const [rejecting, setRejecting] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const isBadge = claim.kind === 'badge';

    const decide = async (approve: boolean) => {
        setSaving(true);
        setError(null);
        const ids = claim.events.map((e) => e.event_id);
        const approved = approve ? ids.filter((id) => decisions[id] === 'approved') : [];
        try {
            const updated = await decideOrganizerClaim(claim.id, {
                grant_badge: approve,
                approved_event_ids: approved,
                rejected_event_ids: ids.filter((id) => !approved.includes(id)),
                admin_notes: notes.trim() || null,
                overwrite: claim.events.some((e) => approved.includes(e.event_id) && takenByOther(e)),
            });
            onDecided(updated);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to save');
        } finally {
            setSaving(false);
        }
    };

    const approvedCount = Object.values(decisions).filter((d) => d === 'approved').length;
    const approveLabel = isBadge
        ? claim.events.length ? `Approve organizer + ${approvedCount} event${approvedCount === 1 ? '' : 's'}` : 'Approve organizer'
        : `Approve ${approvedCount} event${approvedCount === 1 ? '' : 's'}`;

    const footer = !pending ? undefined : rejecting ? (
        <div className="space-y-2">
            {error && <p role="alert" className="text-sm text-danger">{error}</p>}
            <button type="button" onClick={() => decide(false)} disabled={saving} className="flex min-h-12 w-full items-center justify-center rounded-field bg-danger px-4 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50">
                {saving ? 'Saving…' : 'Confirm rejection'}
            </button>
            <button type="button" onClick={() => setRejecting(false)} className="flex min-h-11 w-full items-center justify-center text-sm font-semibold text-ink-soft hover:text-ink">
                Back
            </button>
        </div>
    ) : (
        <div className="space-y-2">
            {error && <p role="alert" className="text-sm text-danger">{error}</p>}
            <div className="flex gap-2">
                <button type="button" onClick={() => setRejecting(true)} disabled={saving} className="min-h-12 flex-1 rounded-field border border-line bg-surface px-4 text-sm font-semibold text-danger hover:bg-canvas disabled:opacity-50">
                    Reject
                </button>
                <button
                    type="button"
                    onClick={() => decide(true)}
                    disabled={saving || (!isBadge && approvedCount === 0)}
                    className="min-h-12 flex-[2] rounded-field bg-action px-4 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
                >
                    {saving ? 'Saving…' : approveLabel}
                </button>
            </div>
        </div>
    );

    return (
        <BottomSheet
            title={claimantName(claim)}
            subtitle={[claim.user_handle ? `@${claim.user_handle}` : null, claim.user_email].filter(Boolean).join(' · ')}
            headerLeading={<Avatar url={claim.user_avatar_url} size="lg" />}
            onClose={onClose}
            footer={footer}
        >
            <div className="space-y-5 pb-2">
                <dl className="grid grid-cols-3 gap-2 text-center">
                    <div className="rounded-field bg-canvas p-2">
                        <dt className="text-xs text-ink-soft">Joined</dt>
                        <dd className="text-sm font-semibold text-ink">{formatDate(claim.user_created_at) || '—'}</dd>
                    </div>
                    <div className="rounded-field bg-canvas p-2">
                        <dt className="text-xs text-ink-soft">Organizes</dt>
                        <dd className="text-sm font-semibold text-ink">{claim.user_organized_count} events</dd>
                    </div>
                    <div className="rounded-field bg-canvas p-2">
                        <dt className="text-xs text-ink-soft">Badge</dt>
                        <dd className="text-sm font-semibold text-ink">{claim.user_is_verified_organizer ? 'Verified' : 'No'}</dd>
                    </div>
                </dl>

                <section>
                    <h3 className="text-sm font-semibold text-ink">Bio</h3>
                    <p className="mt-1 whitespace-pre-line text-sm text-ink-soft">{claim.user_bio || '—'}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                        {claim.user_instagram_url && (
                            <a href={claim.user_instagram_url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-10 items-center gap-1.5 rounded-field border border-line px-3 text-sm font-semibold text-ink hover:bg-canvas">
                                Instagram <ExternalLink className="h-4 w-4" aria-hidden />
                            </a>
                        )}
                        {claim.user_facebook_url && (
                            <a href={claim.user_facebook_url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-10 items-center gap-1.5 rounded-field border border-line px-3 text-sm font-semibold text-ink hover:bg-canvas">
                                Facebook <ExternalLink className="h-4 w-4" aria-hidden />
                            </a>
                        )}
                        {claim.user_handle && (
                            <a href={`/u/${claim.user_handle}`} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center gap-1.5 rounded-field border border-line px-3 text-sm font-semibold text-ink hover:bg-canvas">
                                Profile <ExternalLink className="h-4 w-4" aria-hidden />
                            </a>
                        )}
                    </div>
                </section>

                {claim.events.length > 0 && (
                    <section>
                        <h3 className="text-sm font-semibold text-ink">Events</h3>
                        <p className="mt-0.5 text-xs text-ink-soft">Approved events show this person as organizer and add them as Going.</p>
                        <ul className="mt-2 space-y-2">
                            {claim.events.map((e) => {
                                const d = decisions[e.event_id];
                                return (
                                    <li key={e.event_id} className="rounded-field border border-card-line bg-surface p-3">
                                        <a href={`/event/${e.event_id}`} target="_blank" rel="noreferrer" className="block text-sm font-medium text-ink hover:underline">
                                            {e.event_title ?? e.event_id}
                                        </a>
                                        <p className="text-xs text-ink-soft">{formatDate(e.event_start)}</p>
                                        {takenByOther(e) && (
                                            <p className="mt-1 text-xs font-semibold text-amber-700">Currently organized by @{e.current_organizer_handle}. Approving reassigns it.</p>
                                        )}
                                        {Boolean(e.competing_pending_claims) && (
                                            <p className="mt-1 text-xs font-semibold text-amber-700">Also claimed by {e.competing_pending_claims} other request{e.competing_pending_claims === 1 ? '' : 's'}.</p>
                                        )}
                                        {pending && !rejecting ? (
                                            <div className="mt-2 grid grid-cols-2 gap-1" role="radiogroup" aria-label={`Decision for ${e.event_title ?? 'event'}`}>
                                                {(['approved', 'rejected'] as const).map((opt) => (
                                                    <button
                                                        key={opt}
                                                        type="button"
                                                        role="radio"
                                                        aria-checked={d === opt}
                                                        onClick={() => setDecisions((prev) => ({ ...prev, [e.event_id]: opt }))}
                                                        className={`min-h-10 rounded-field border text-sm font-semibold ${d === opt ? (opt === 'approved' ? 'border-action bg-action text-white' : 'border-danger bg-danger text-white') : 'border-line bg-surface text-ink-soft'}`}
                                                    >
                                                        {opt === 'approved' ? 'Approve' : 'Reject'}
                                                    </button>
                                                ))}
                                            </div>
                                        ) : (
                                            <p className={`mt-1 text-xs font-semibold ${e.decision === 'approved' ? 'text-success' : 'text-ink-soft'}`}>
                                                {e.decision === 'approved' ? 'Approved' : e.decision === 'rejected' ? 'Rejected' : 'Will be rejected'}
                                            </p>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    </section>
                )}

                {(rejecting || !pending || notes) && (
                    <section>
                        <label htmlFor="claim-notes" className="text-sm font-semibold text-ink">
                            {rejecting ? 'Reason (shown to the requester)' : 'Note to the requester'}
                        </label>
                        {rejecting && (
                            <div className="mt-2 flex flex-wrap gap-2">
                                {REJECT_REASONS.map((r) => (
                                    <button key={r} type="button" onClick={() => setNotes(r)} className="rounded-field border border-line bg-surface px-3 py-1.5 text-left text-xs text-ink hover:border-action">
                                        {r}
                                    </button>
                                ))}
                            </div>
                        )}
                        <textarea
                            id="claim-notes"
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            readOnly={!pending}
                            rows={3}
                            maxLength={500}
                            className="mt-2 w-full rounded-field border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-action focus:outline-none"
                        />
                    </section>
                )}
                {!pending && claim.reviewed_at && (
                    <p className="text-xs text-muted">Decided {formatDate(claim.reviewed_at)}{claim.reviewed_by ? ` by ${claim.reviewed_by}` : ''}</p>
                )}
            </div>
        </BottomSheet>
    );
}
