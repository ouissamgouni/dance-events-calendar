import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { X } from 'lucide-react';
import {
    cancelOrganizerClaim,
    fetchMyOrganizerClaims,
    fetchPublicProfile,
    removeEventFromClaim,
} from '../api';
import type { OrganizerClaim } from '../types';
import { ConfirmDialog } from './AppDialog';
import OrganizerClaimSheet from './OrganizerClaimSheet';

interface Props {
    handle: string | null;
}

function formatDate(iso?: string | null) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * Settings status card for the organizer role: pitch → request in review
 * (events removable, add more, withdraw) → verified (claim more, Hosting).
 * All submission happens in ``OrganizerClaimSheet``.
 */
export default function OrganizerClaimSection({ handle }: Props) {
    const [verified, setVerified] = useState(false);
    const [claims, setClaims] = useState<OrganizerClaim[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [sheetOpen, setSheetOpen] = useState(false);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [confirmWithdraw, setConfirmWithdraw] = useState<OrganizerClaim | null>(null);

    const load = useCallback(() => {
        Promise.all([
            handle ? fetchPublicProfile(handle).catch(() => null) : Promise.resolve(null),
            fetchMyOrganizerClaims().catch(() => []),
        ])
            .then(([profile, rows]) => {
                setVerified(Boolean(profile?.is_verified_organizer));
                setClaims(rows);
            })
            .finally(() => setLoading(false));
    }, [handle]);

    useEffect(load, [load]);

    const pending = claims.find((c) => c.status === 'pending') ?? null;
    const history = claims.filter((c) => c.status !== 'pending');
    const lastRejected = history[0]?.status === 'rejected' ? history[0] : null;

    const removeEvent = async (claimId: string, eventId: string) => {
        setError(null);
        try {
            await removeEventFromClaim(claimId, eventId);
            load();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not remove the event');
        }
    };

    const withdraw = async () => {
        if (!confirmWithdraw) return;
        const target = confirmWithdraw;
        setConfirmWithdraw(null);
        setError(null);
        try {
            await cancelOrganizerClaim(target.id);
            load();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not withdraw the request');
        }
    };

    const headerTitle = verified ? 'Organizer' : 'Are you an event organizer?';
    const headerSubtitle = verified
        ? 'Claim more events you organize and manage them from Hosting.'
        : 'Get verified to show your name on your events and propose updates.';

    return (
        <section id="organizer" className="scroll-mt-4 rounded-card border border-card-line bg-surface p-4">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <h2 className="text-base font-semibold text-ink">{headerTitle}</h2>
                    <p className="mt-0.5 text-sm text-ink-soft">{headerSubtitle}</p>
                </div>
                {verified && (
                    <span className="inline-flex shrink-0 items-center gap-1 bg-emerald-50 px-2 py-1 text-xs font-semibold text-success">
                        <img src="/orga.png" alt="" aria-hidden="true" className="h-3.5 w-3.5 object-contain" />
                        Verified
                    </span>
                )}
            </div>

            {loading ? (
                <p className="mt-3 text-sm text-muted">Loading…</p>
            ) : (
                <div className="mt-4 space-y-4">
                    {error && <p role="alert" className="text-sm text-danger">{error}</p>}

                    {pending && (
                        <div className="rounded-field border border-blue-100 bg-blue-50 p-3">
                            <p className="text-sm font-semibold text-ink">In review</p>
                            <p className="mt-0.5 text-xs text-ink-soft">
                                Sent {formatDate(pending.created_at)} · usually reviewed within two days
                            </p>
                            {pending.events.length > 0 && (
                                <ul className="mt-3 space-y-1">
                                    {pending.events.map((e) => (
                                        <li key={e.event_id} className="flex min-h-10 items-center gap-2 rounded-field bg-surface pl-3 text-sm text-ink">
                                            <span className="min-w-0 flex-1 truncate">{e.event_title ?? e.event_id}</span>
                                            <span className="shrink-0 text-xs text-muted">{formatDate(e.event_start)}</span>
                                            <button
                                                type="button"
                                                onClick={() => removeEvent(pending.id, e.event_id)}
                                                aria-label={`Remove ${e.event_title ?? 'event'} from request`}
                                                className="flex h-10 w-10 shrink-0 items-center justify-center text-ink-soft hover:text-ink"
                                            >
                                                <X className="h-4 w-4" aria-hidden />
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    )}

                    {!pending && lastRejected && !verified && (
                        <div className="rounded-field border border-line bg-canvas p-3">
                            <p className="text-sm font-semibold text-ink">Your last request wasn&apos;t approved</p>
                            {lastRejected.admin_notes && (
                                <p className="mt-1 text-sm text-ink-soft">“{lastRejected.admin_notes}”</p>
                            )}
                        </div>
                    )}

                    {!pending && !verified && !lastRejected && (
                        <ul className="space-y-1 text-sm text-ink-soft">
                            <li>• A verified badge on your profile and posts</li>
                            <li>• “Organized by” with your name on your events</li>
                            <li>• Propose updates to your events and manage them in one place</li>
                        </ul>
                    )}

                    <div className="flex flex-wrap gap-2">
                        <button
                            type="button"
                            onClick={() => setSheetOpen(true)}
                            className="min-h-11 rounded-field bg-action px-4 text-sm font-semibold text-white hover:opacity-90"
                        >
                            {verified ? 'Claim more events' : pending ? 'Add events' : lastRejected ? 'Request again' : 'Become an organizer'}
                        </button>
                        {verified && (
                            <Link
                                to="/hosting"
                                className="flex min-h-11 items-center rounded-field border border-line bg-surface px-4 text-sm font-semibold text-ink hover:bg-canvas"
                            >
                                Open Hosting
                            </Link>
                        )}
                        {pending && (
                            <button
                                type="button"
                                onClick={() => setConfirmWithdraw(pending)}
                                className="min-h-11 rounded-field px-3 text-sm font-semibold text-danger hover:bg-canvas"
                            >
                                Withdraw request
                            </button>
                        )}
                    </div>

                    {history.length > 0 && (
                        <div className="border-t border-card-line pt-3">
                            <button
                                type="button"
                                onClick={() => setHistoryOpen((v) => !v)}
                                aria-expanded={historyOpen}
                                className="text-sm font-medium text-ink-soft hover:text-ink"
                            >
                                Past requests ({history.length}) {historyOpen ? '▲' : '▼'}
                            </button>
                            {historyOpen && (
                                <ul className="mt-2 divide-y divide-card-line">
                                    {history.map((c) => (
                                        <li key={c.id} className="py-2 text-sm">
                                            <div className="flex items-center justify-between gap-2">
                                                <span className="text-ink">
                                                    {c.kind === 'badge' ? 'Organizer request' : 'Event claim'} · {formatDate(c.created_at)}
                                                </span>
                                                <span className={`text-xs font-semibold ${c.status === 'approved' ? 'text-success' : 'text-ink-soft'}`}>
                                                    {c.status === 'approved' ? 'Approved' : 'Not approved'}
                                                </span>
                                            </div>
                                            {c.events.length > 0 && (
                                                <ul className="mt-1 space-y-0.5 text-xs text-ink-soft">
                                                    {c.events.map((e) => (
                                                        <li key={e.event_id} className="flex justify-between gap-2">
                                                            <span className="truncate">{e.event_title ?? e.event_id}</span>
                                                            <span>{e.decision === 'approved' ? '✓' : '—'}</span>
                                                        </li>
                                                    ))}
                                                </ul>
                                            )}
                                            {c.admin_notes && <p className="mt-1 text-xs italic text-ink-soft">“{c.admin_notes}”</p>}
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    )}
                </div>
            )}

            {sheetOpen && (
                <OrganizerClaimSheet
                    onClose={() => { setSheetOpen(false); load(); }}
                    onSubmitted={load}
                />
            )}
            <ConfirmDialog
                open={confirmWithdraw !== null}
                title="Withdraw your request?"
                message="Your request and the events in it will no longer be reviewed."
                confirmLabel="Withdraw"
                destructive
                onConfirm={withdraw}
                onCancel={() => setConfirmWithdraw(null)}
            />
        </section>
    );
}
