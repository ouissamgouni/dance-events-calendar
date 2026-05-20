import { useEffect, useMemo, useState } from 'react';
import { decideOrganizerClaim, fetchAdminOrganizerClaims } from '../api';
import { notifyAdminDataChanged } from '../hooks/useAdminCounters';
import type { OrganizerClaimAdmin, OrganizerClaimEvent } from '../types';

interface Props {
    isOpen: boolean;
    onClose: () => void;
}

const TABS = ['pending', 'approved', 'rejected', 'all'] as const;
type Tab = typeof TABS[number];

const KIND_FILTERS = ['all', 'badge', 'events'] as const;
type KindFilter = typeof KIND_FILTERS[number];

function statusBadge(status: string) {
    const colors: Record<string, string> = {
        pending: 'bg-amber-100 text-amber-700',
        approved: 'bg-emerald-100 text-emerald-700',
        rejected: 'bg-slate-200 text-slate-700',
    };
    return (
        <span
            className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 ${colors[status] ?? 'bg-gray-100 text-gray-600'
                }`}
        >
            {status}
        </span>
    );
}

interface DraftState {
    grantBadge: boolean;
    decisions: Record<string, 'approved' | 'rejected' | 'pending'>;
    adminNotes: string;
    overwrite: boolean;
}

function initialDraft(claim: OrganizerClaimAdmin): DraftState {
    const decisions: Record<string, 'approved' | 'rejected' | 'pending'> = {};
    for (const ev of claim.events) {
        decisions[ev.event_id] = ev.decision;
    }
    return {
        // Badge claims: default the grant checkbox ON.
        // Events claims: badge grant has no effect server-side, keep OFF.
        grantBadge: claim.kind === 'badge',
        decisions,
        adminNotes: claim.admin_notes ?? '',
        overwrite: false,
    };
}

export default function OrganizerClaimsAdminPanel({ isOpen, onClose }: Props) {
    const [activeTab, setActiveTab] = useState<Tab>('pending');
    const [kindFilter, setKindFilter] = useState<KindFilter>('all');
    const [rows, setRows] = useState<OrganizerClaimAdmin[]>([]);
    const [loading, setLoading] = useState(false);
    const [acting, setActing] = useState<string | null>(null);
    const [drafts, setDrafts] = useState<Record<string, DraftState>>({});
    const [error, setError] = useState<string | null>(null);

    const load = () => {
        setLoading(true);
        setError(null);
        const status = activeTab === 'all' ? undefined : activeTab;
        const kind = kindFilter === 'all' ? undefined : kindFilter;
        fetchAdminOrganizerClaims(status, kind)
            .then((data) => {
                setRows(data);
                setDrafts(
                    Object.fromEntries(data.map((c) => [c.id, initialDraft(c)])),
                );
            })
            .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
            .finally(() => setLoading(false));
    };

    useEffect(() => {
        if (!isOpen) return;
        load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, activeTab, kindFilter]);

    const updateDraft = (claimId: string, patch: Partial<DraftState>) => {
        setDrafts((prev) => ({
            ...prev,
            [claimId]: { ...prev[claimId], ...patch },
        }));
    };

    const setDecision = (
        claimId: string,
        eventId: string,
        decision: 'approved' | 'rejected' | 'pending',
    ) => {
        setDrafts((prev) => {
            const cur = prev[claimId];
            return {
                ...prev,
                [claimId]: {
                    ...cur,
                    decisions: { ...cur.decisions, [eventId]: decision },
                },
            };
        });
    };

    const save = async (claim: OrganizerClaimAdmin) => {
        const draft = drafts[claim.id];
        if (!draft) return;
        const approved_event_ids = Object.entries(draft.decisions)
            .filter(([, d]) => d === 'approved')
            .map(([id]) => id);
        const rejected_event_ids = Object.entries(draft.decisions)
            .filter(([, d]) => d === 'rejected')
            .map(([id]) => id);
        setActing(claim.id);
        try {
            const updated = await decideOrganizerClaim(claim.id, {
                grant_badge: draft.grantBadge,
                approved_event_ids,
                rejected_event_ids,
                admin_notes: draft.adminNotes.trim() || null,
                overwrite: draft.overwrite,
            });
            setRows((prev) => prev.map((r) => (r.id === claim.id ? updated : r)));
            setDrafts((prev) => ({ ...prev, [claim.id]: initialDraft(updated) }));
            if (activeTab === 'pending' && updated.status !== 'pending') {
                setRows((prev) => prev.filter((r) => r.id !== claim.id));
            }
            notifyAdminDataChanged();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to save');
        } finally {
            setActing(null);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-40 flex">
            <div
                className="flex-1 bg-black/30"
                onClick={onClose}
                aria-hidden="true"
            />
            <div className="w-full max-w-3xl bg-white shadow-xl flex flex-col">
                <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
                    <h2 className="text-sm font-semibold text-slate-800">
                        Organizer claims
                    </h2>
                    <button
                        onClick={onClose}
                        className="text-slate-400 hover:text-slate-700 text-sm px-2"
                    >
                        ✕
                    </button>
                </div>

                <div className="flex border-b border-slate-200">
                    {TABS.map((t) => (
                        <button
                            key={t}
                            onClick={() => setActiveTab(t)}
                            className={`px-3 py-2 text-xs font-medium capitalize ${activeTab === t
                                ? 'text-blue-600 border-b-2 border-blue-500'
                                : 'text-slate-500 hover:text-slate-700'
                                }`}
                        >
                            {t}
                        </button>
                    ))}
                </div>

                <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-200 text-[11px] text-slate-500">
                    <span>Kind:</span>
                    {KIND_FILTERS.map((k) => (
                        <button
                            key={k}
                            type="button"
                            onClick={() => setKindFilter(k)}
                            className={`px-2 py-0.5 capitalize ${kindFilter === k
                                ? 'bg-slate-800 text-white'
                                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                                }`}
                        >
                            {k === 'badge'
                                ? 'Verified badge'
                                : k === 'events'
                                    ? 'Events'
                                    : 'All'}
                        </button>
                    ))}
                </div>

                {error && (
                    <div className="px-4 py-2 text-xs text-red-600 border-b border-red-200 bg-red-50">
                        {error}
                    </div>
                )}

                <div className="flex-1 overflow-y-auto">
                    {loading ? (
                        <div className="p-6 text-center text-xs text-slate-400">
                            Loading…
                        </div>
                    ) : rows.length === 0 ? (
                        <div className="p-6 text-center text-xs text-slate-400">
                            No claims
                        </div>
                    ) : (
                        <ul className="divide-y divide-slate-100">
                            {rows.map((claim) => (
                                <ClaimRow
                                    key={claim.id}
                                    claim={claim}
                                    draft={drafts[claim.id]}
                                    saving={acting === claim.id}
                                    onChangeDraft={(patch) => updateDraft(claim.id, patch)}
                                    onSetDecision={(eventId, decision) =>
                                        setDecision(claim.id, eventId, decision)
                                    }
                                    onSave={() => save(claim)}
                                />
                            ))}
                        </ul>
                    )}
                </div>
            </div>
        </div>
    );
}

interface RowProps {
    claim: OrganizerClaimAdmin;
    draft: DraftState | undefined;
    saving: boolean;
    onChangeDraft: (patch: Partial<DraftState>) => void;
    onSetDecision: (
        eventId: string,
        decision: 'approved' | 'rejected' | 'pending',
    ) => void;
    onSave: () => void;
}

function ClaimRow({
    claim,
    draft,
    saving,
    onChangeDraft,
    onSetDecision,
    onSave,
}: RowProps) {
    const dirty = useMemo(() => {
        if (!draft) return false;
        if ((draft.adminNotes ?? '') !== (claim.admin_notes ?? '')) return true;
        for (const ev of claim.events) {
            if (draft.decisions[ev.event_id] !== ev.decision) return true;
        }
        const initialGrant = claim.kind === 'badge';
        return draft.overwrite || draft.grantBadge !== initialGrant;
    }, [draft, claim]);

    const isBadgeClaim = claim.kind === 'badge';
    const isEventsClaim = claim.kind === 'events';

    return (
        <li className="p-3">
            <div className="flex items-start gap-3">
                {claim.user_avatar_url ? (
                    <img
                        src={claim.user_avatar_url}
                        alt=""
                        className="h-8 w-8 rounded-full object-cover"
                    />
                ) : (
                    <div className="h-8 w-8 rounded-full bg-slate-200" />
                )}
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm text-slate-900">
                            {claim.user_handle
                                ? `@${claim.user_handle}`
                                : claim.user_display_name ?? claim.user_email ?? 'user'}
                        </span>
                        <span
                            className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 ${isBadgeClaim
                                ? 'bg-indigo-100 text-indigo-700'
                                : 'bg-sky-100 text-sky-700'
                                }`}
                        >
                            {isBadgeClaim ? 'Verified badge' : 'Events'}
                        </span>
                        {statusBadge(claim.status)}
                        <span className="text-[10px] text-slate-400">
                            {new Date(claim.created_at).toLocaleString()}
                        </span>
                    </div>
                    {claim.user_bio && (
                        <p className="mt-1 text-xs text-slate-600 line-clamp-3">
                            {claim.user_bio}
                        </p>
                    )}
                    <div className="mt-1 flex gap-3 text-[11px]">
                        {claim.user_instagram_url && (
                            <a
                                href={claim.user_instagram_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-600 hover:underline"
                            >
                                Instagram
                            </a>
                        )}
                        {claim.user_facebook_url && (
                            <a
                                href={claim.user_facebook_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-600 hover:underline"
                            >
                                Facebook
                            </a>
                        )}
                    </div>
                </div>
            </div>

            {isEventsClaim && claim.events.length > 0 && (
                <>
                    <div className="mt-3 text-[11px] text-slate-500">
                        Approving an event attributes it to this user and adds it
                        to their public calendar as Going.
                    </div>
                    <ul className="mt-2 divide-y divide-slate-100 border border-slate-200">
                        {claim.events.map((ev) => (
                            <EventDecisionRow
                                key={ev.event_id}
                                ev={ev}
                                decision={draft?.decisions[ev.event_id] ?? ev.decision}
                                disabled={saving || ev.decision !== 'pending'}
                                onSet={(d) => onSetDecision(ev.event_id, d)}
                            />
                        ))}
                    </ul>
                </>
            )}

            <div className="mt-3 flex items-center gap-3 text-xs">
                {isBadgeClaim && (
                    <label className="flex items-center gap-1.5">
                        <input
                            type="checkbox"
                            checked={draft?.grantBadge ?? true}
                            onChange={(e) =>
                                onChangeDraft({ grantBadge: e.target.checked })
                            }
                        />
                        Grant verified-organizer badge
                    </label>
                )}
                {isEventsClaim && (
                    <label className="flex items-center gap-1.5">
                        <input
                            type="checkbox"
                            checked={draft?.overwrite ?? false}
                            onChange={(e) =>
                                onChangeDraft({ overwrite: e.target.checked })
                            }
                        />
                        Overwrite existing organizer
                    </label>
                )}
            </div>

            <textarea
                value={draft?.adminNotes ?? ''}
                onChange={(e) => onChangeDraft({ adminNotes: e.target.value })}
                placeholder="Admin notes (shown to claimer)"
                rows={2}
                maxLength={500}
                className="mt-2 w-full text-xs border border-slate-300 px-2 py-1 focus:outline-none focus:border-blue-400"
            />

            {claim.status === 'pending' && (
                <div className="mt-2 flex justify-end">
                    <button
                        disabled={saving || !dirty}
                        onClick={onSave}
                        className="text-[11px] bg-blue-500 text-white px-3 py-1 hover:bg-blue-600 disabled:opacity-50"
                    >
                        {saving ? 'Saving…' : 'Save decision'}
                    </button>
                </div>
            )}
        </li>
    );
}

interface EventRowProps {
    ev: OrganizerClaimEvent;
    decision: 'approved' | 'rejected' | 'pending';
    disabled: boolean;
    onSet: (d: 'approved' | 'rejected' | 'pending') => void;
}

function EventDecisionRow({ ev, decision, disabled, onSet }: EventRowProps) {
    return (
        <li className="p-2 flex items-center gap-2 text-xs">
            <div className="flex-1 min-w-0">
                <div className="truncate text-slate-800">
                    {ev.event_title ?? ev.event_id}
                </div>
                {ev.event_start && (
                    <div className="text-[10px] text-slate-400">
                        {new Date(ev.event_start).toLocaleString()}
                    </div>
                )}
            </div>
            <div className="flex gap-1">
                {(['approved', 'rejected', 'pending'] as const).map((d) => (
                    <button
                        key={d}
                        type="button"
                        disabled={disabled}
                        onClick={() => onSet(d)}
                        className={`px-2 py-0.5 text-[10px] uppercase font-semibold ${decision === d
                            ? d === 'approved'
                                ? 'bg-blue-500 text-white'
                                : d === 'rejected'
                                    ? 'bg-red-600 text-white'
                                    : 'bg-slate-300 text-slate-700'
                            : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                            } disabled:opacity-50`}
                    >
                        {d}
                    </button>
                ))}
            </div>
        </li>
    );
}
