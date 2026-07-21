import { useEffect, useState } from 'react';
import {
    approveAdminPromoCode,
    fetchAdminPromoCodes,
    rejectAdminPromoCode,
    updateAdminPromoCode,
} from '../api';
import { notifyAdminDataChanged } from '../hooks/useAdminCounters';
import type { PromoCodeAdmin } from '../types';
import { VisibilityOverrideControl } from './AdminEventDetailContent';

interface Props {
    eventId: string;
    overrideValue: boolean | null;
    onOverrideChange: (value: boolean | null) => void;
    overrideDisabled?: boolean;
}

interface EditForm {
    code: string;
    description: string;
    source_url: string;
    expires_at: string; // yyyy-mm-dd
}

function statusBadge(status: string) {
    const colors: Record<string, string> = {
        pending: 'bg-amber-100 text-amber-700',
        approved: 'bg-emerald-100 text-emerald-700',
        rejected: 'bg-slate-200 text-slate-700',
    };
    return (
        <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 ${colors[status] ?? 'bg-gray-100 text-gray-600'}`}>
            {status}
        </span>
    );
}

function toEditForm(p: PromoCodeAdmin): EditForm {
    return {
        code: p.code,
        description: p.description ?? '',
        source_url: p.source_url ?? '',
        expires_at: p.expires_at ? p.expires_at.slice(0, 10) : '',
    };
}

/**
 * Collapsible, admin-only "Promo codes" section embedded in the per-event
 * side panel. Lists every promo code submitted for this event (any status)
 * with inline approve/reject/edit controls — this is admin moderation, not
 * behind the ``promo_codes_enabled`` flag (admins must be able to triage the
 * backlog even while the feature is globally off). The show/hide override
 * for the public-facing section lives in this section's header.
 */
export default function AdminEventPromoCodes({
    eventId,
    overrideValue,
    onOverrideChange,
    overrideDisabled,
}: Props) {
    const [expanded, setExpanded] = useState(false);
    const [rows, setRows] = useState<PromoCodeAdmin[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [acting, setActing] = useState<string | null>(null);
    const [rejectingId, setRejectingId] = useState<string | null>(null);
    const [rejectNotes, setRejectNotes] = useState('');
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editForm, setEditForm] = useState<EditForm | null>(null);

    const load = () => {
        setLoading(true);
        setError(null);
        fetchAdminPromoCodes(undefined, eventId)
            .then((r) => {
                setRows(r);
                setLoaded(true);
            })
            .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load promo codes'))
            .finally(() => setLoading(false));
    };

    useEffect(() => {
        if (expanded && !loaded) load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [expanded]);

    const approve = async (id: string) => {
        setActing(id);
        setError(null);
        try {
            const updated = await approveAdminPromoCode(id);
            setRows((prev) => prev.map((r) => (r.id === id ? updated : r)));
            notifyAdminDataChanged();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to approve');
        } finally {
            setActing(null);
        }
    };

    const reject = async (id: string) => {
        setActing(id);
        setError(null);
        try {
            const updated = await rejectAdminPromoCode(id, rejectNotes.trim() || undefined);
            setRows((prev) => prev.map((r) => (r.id === id ? updated : r)));
            setRejectingId(null);
            setRejectNotes('');
            notifyAdminDataChanged();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to reject');
        } finally {
            setActing(null);
        }
    };

    const saveEdit = async (id: string) => {
        if (!editForm) return;
        setActing(id);
        setError(null);
        try {
            const updated = await updateAdminPromoCode(id, {
                code: editForm.code.trim(),
                description: editForm.description.trim() || null,
                source_url: editForm.source_url.trim() || null,
                expires_at: editForm.expires_at ? new Date(editForm.expires_at).toISOString() : null,
            });
            setRows((prev) => prev.map((r) => (r.id === id ? updated : r)));
            setEditingId(null);
            setEditForm(null);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to save changes');
        } finally {
            setActing(null);
        }
    };

    return (
        <div className="border border-slate-200 rounded-lg bg-slate-50 overflow-hidden">
            <div className="w-full flex items-center gap-2 px-3 py-1.5">
                <button
                    type="button"
                    onClick={() => setExpanded((v) => !v)}
                    className="flex flex-1 min-w-0 items-center gap-2 text-left hover:opacity-80 transition"
                >
                    <span className="text-slate-400 text-[10px]">{expanded ? '▾' : '▸'}</span>
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Promo codes</span>
                    {loaded && rows.length > 0 && (
                        <span className="text-[10px] text-slate-400">({rows.length})</span>
                    )}
                </button>
                <VisibilityOverrideControl
                    value={overrideValue}
                    disabled={overrideDisabled}
                    onChange={onOverrideChange}
                />
            </div>
            {expanded && (
                <div className="border-t border-slate-200 bg-white p-3 space-y-2">
                    {error && <p className="text-[11px] text-red-500">{error}</p>}
                    {loading ? (
                        <p className="text-[11px] text-slate-400">Loading…</p>
                    ) : rows.length === 0 ? (
                        <p className="text-[11px] text-slate-400 italic">No promo codes submitted for this event</p>
                    ) : (
                        <ul className="divide-y divide-slate-100">
                            {rows.map((p) => (
                                <li key={p.id} className="py-2">
                                    {editingId === p.id && editForm ? (
                                        <div className="flex flex-col gap-1.5">
                                            <input
                                                type="text"
                                                value={editForm.code}
                                                maxLength={64}
                                                onChange={(e) => setEditForm({ ...editForm, code: e.target.value })}
                                                className="border border-slate-300 px-2 py-1 text-[11px] font-mono focus:outline-none focus:border-blue-400"
                                            />
                                            <input
                                                type="text"
                                                placeholder="Description"
                                                value={editForm.description}
                                                maxLength={200}
                                                onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                                                className="border border-slate-300 px-2 py-1 text-[11px] focus:outline-none focus:border-blue-400"
                                            />
                                            <input
                                                type="url"
                                                placeholder="Source URL"
                                                value={editForm.source_url}
                                                maxLength={500}
                                                onChange={(e) => setEditForm({ ...editForm, source_url: e.target.value })}
                                                className="border border-slate-300 px-2 py-1 text-[11px] focus:outline-none focus:border-blue-400"
                                            />
                                            <label className="text-[10px] text-slate-500 flex items-center gap-2">
                                                Expires
                                                <input
                                                    type="date"
                                                    value={editForm.expires_at}
                                                    onChange={(e) => setEditForm({ ...editForm, expires_at: e.target.value })}
                                                    className="border border-slate-300 px-2 py-1 text-[11px] focus:outline-none focus:border-blue-400"
                                                />
                                            </label>
                                            <div className="flex gap-2 pt-0.5">
                                                <button
                                                    type="button"
                                                    disabled={acting === p.id}
                                                    onClick={() => saveEdit(p.id)}
                                                    className="text-[11px] bg-blue-500 text-white px-2 py-1 hover:bg-blue-600 disabled:opacity-50"
                                                >
                                                    Save
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => { setEditingId(null); setEditForm(null); }}
                                                    className="text-[11px] text-slate-500 hover:text-slate-700 px-2"
                                                >
                                                    Cancel
                                                </button>
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="flex items-start justify-between gap-3">
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2 flex-wrap">
                                                    <span className="font-mono text-xs text-slate-900">{p.code}</span>
                                                    {statusBadge(p.status)}
                                                    {p.expires_at && (
                                                        <span className="text-[10px] text-slate-500">
                                                            expires {new Date(p.expires_at).toLocaleDateString()}
                                                        </span>
                                                    )}
                                                </div>
                                                {p.description && (
                                                    <div className="mt-1 text-[11px] text-slate-600">{p.description}</div>
                                                )}
                                                {p.admin_notes && (
                                                    <div className="mt-1 text-[11px] text-slate-500 italic">Notes: {p.admin_notes}</div>
                                                )}
                                            </div>
                                            <div className="flex flex-col gap-1 shrink-0">
                                                <button
                                                    type="button"
                                                    disabled={acting === p.id}
                                                    onClick={() => { setEditingId(p.id); setEditForm(toEditForm(p)); }}
                                                    className="text-[11px] border border-slate-200 bg-white text-slate-600 px-2 py-1 hover:bg-slate-50 disabled:opacity-50"
                                                >
                                                    Edit
                                                </button>
                                                {p.status !== 'approved' && (
                                                    <button
                                                        type="button"
                                                        disabled={acting === p.id}
                                                        onClick={() => approve(p.id)}
                                                        className="text-[11px] bg-blue-500 text-white px-2 py-1 hover:bg-blue-600 disabled:opacity-50"
                                                    >
                                                        Approve
                                                    </button>
                                                )}
                                                {p.status !== 'rejected' && (
                                                    <button
                                                        type="button"
                                                        disabled={acting === p.id}
                                                        onClick={() => { setRejectingId(p.id); setRejectNotes(''); }}
                                                        className="text-[11px] bg-red-600 text-white px-2 py-1 hover:bg-red-700 disabled:opacity-50"
                                                    >
                                                        Reject
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    )}
                                    {rejectingId === p.id && (
                                        <div className="mt-2 border border-slate-200 bg-slate-50 p-2 flex flex-col gap-2">
                                            <textarea
                                                value={rejectNotes}
                                                onChange={(e) => setRejectNotes(e.target.value)}
                                                placeholder="Reason (optional, shown to submitter)"
                                                rows={2}
                                                maxLength={500}
                                                className="text-[11px] border border-slate-300 px-2 py-1 focus:outline-none focus:border-blue-400"
                                            />
                                            <div className="flex gap-2">
                                                <button
                                                    type="button"
                                                    disabled={acting === p.id}
                                                    onClick={() => reject(p.id)}
                                                    className="text-[11px] bg-red-600 text-white px-2 py-1 hover:bg-red-700 disabled:opacity-50"
                                                >
                                                    Confirm reject
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => setRejectingId(null)}
                                                    className="text-[11px] text-slate-500 px-2"
                                                >
                                                    Cancel
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}
        </div>
    );
}
