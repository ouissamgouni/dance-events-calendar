import { useState } from 'react';
import type { EventSuggestion, CalendarSetting } from '../types';
import { approveSuggestion, rejectSuggestion, syncSuggestionToGoogle } from '../api';
import AdminEventDetailPanel from './AdminEventDetailPanel';

interface Props {
    suggestion: EventSuggestion;
    calendars: CalendarSetting[];
    onClose: () => void;
    onUpdated: (s: EventSuggestion) => void;
}

const STATUS_COLORS: Record<string, string> = {
    pending: 'bg-amber-100 text-amber-700',
    approved: 'bg-emerald-100 text-emerald-700',
    rejected: 'bg-slate-200 text-slate-700',
};

const fmtDate = (iso: string) => {
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
};

const fmtPrice = (s: EventSuggestion): string | null => {
    if (s.price_is_free) return 'Free';
    const cur = s.price_currency ?? '';
    if (s.price_min != null && s.price_max != null) return `${s.price_min} – ${s.price_max} ${cur}`.trim();
    if (s.price_min != null) return `From ${s.price_min} ${cur}`.trim();
    if (s.price_max != null) return `Up to ${s.price_max} ${cur}`.trim();
    return null;
};

export default function SuggestionReviewModal({ suggestion, calendars, onClose, onUpdated }: Props) {
    const [selectedCalendarId, setSelectedCalendarId] = useState(
        suggestion.assigned_calendar_id ?? calendars.find((c) => c.enabled)?.calendar_id ?? '',
    );
    const [adminNotes, setAdminNotes] = useState(suggestion.admin_notes ?? '');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [rejectMode, setRejectMode] = useState(false);
    const [adminDetailEventId, setAdminDetailEventId] = useState<string | null>(null);

    const isPending = suggestion.status === 'pending';
    const isApproved = suggestion.status === 'approved';

    const handleApprove = async () => {
        if (!selectedCalendarId) {
            setError('Select a calendar first.');
            return;
        }
        setSaving(true);
        setError('');
        try {
            const updated = await approveSuggestion(suggestion.id, selectedCalendarId);
            onUpdated(updated);
        } catch (err: any) {
            setError(err.message || 'Failed to approve.');
        } finally {
            setSaving(false);
        }
    };

    const handleReject = async () => {
        setSaving(true);
        setError('');
        try {
            const updated = await rejectSuggestion(suggestion.id, adminNotes || undefined);
            onUpdated(updated);
            setRejectMode(false);
        } catch {
            setError('Failed to reject.');
        } finally {
            setSaving(false);
        }
    };

    const handleSync = async () => {
        setSaving(true);
        setError('');
        try {
            const updated = await syncSuggestionToGoogle(suggestion.id);
            onUpdated(updated);
        } catch (err: any) {
            setError(err.message || 'Failed to sync.');
        } finally {
            setSaving(false);
        }
    };

    const price = fmtPrice(suggestion);

    return (
        <>
            <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40">
                <div className="mx-4 w-full max-w-2xl max-h-[90vh] overflow-y-auto bg-white p-6 shadow-xl">
                    {/* Header */}
                    <div className="flex items-start justify-between mb-4">
                        <div>
                            <h2 className="text-base font-semibold text-slate-800">Review Suggestion</h2>
                            <div className="mt-1 flex items-center gap-2">
                                <span className={`text-[10px] font-semibold uppercase px-2 py-0.5 ${STATUS_COLORS[suggestion.status] ?? 'bg-gray-100 text-gray-600'}`}>
                                    {suggestion.status}
                                </span>
                                {suggestion.synced_to_google && (
                                    <span className="text-[10px] text-emerald-600 font-medium">✓ Synced to Google</span>
                                )}
                                {isApproved && !suggestion.synced_to_google && (
                                    <span className="text-[10px] text-amber-600 font-medium">⚠ Not synced</span>
                                )}
                            </div>
                        </div>
                        <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-lg p-1">✕</button>
                    </div>

                    {/* APPROVED → collapsed view: link to created event + suggest sync */}
                    {isApproved ? (
                        <div className="space-y-4">
                            <div className="border border-slate-200 bg-slate-50 p-4">
                                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Approved Suggestion</p>
                                <p className="text-sm font-medium text-slate-800">{suggestion.title}</p>
                                <p className="text-[11px] text-slate-500 mt-0.5">
                                    {fmtDate(suggestion.start)}
                                    {suggestion.location && ` • ${suggestion.location}`}
                                </p>
                                {suggestion.created_event_id && (
                                    <button
                                        onClick={() => setAdminDetailEventId(suggestion.created_event_id!)}
                                        className="mt-3 inline-flex items-center gap-1 bg-blue-600 text-white text-xs font-medium px-3 py-1.5 hover:bg-blue-700 transition"
                                    >
                                        Open created event →
                                    </button>
                                )}
                            </div>

                            {!suggestion.synced_to_google && (
                                <div className="border border-amber-200 bg-amber-50 p-4">
                                    <p className="text-xs text-amber-800 mb-2">
                                        This event isn't synced to Google Calendar yet. Sync it so it appears on the source calendar.
                                    </p>
                                    <button
                                        onClick={handleSync}
                                        disabled={saving}
                                        className="bg-blue-600 text-white text-xs font-medium px-3 py-1.5 hover:bg-blue-700 disabled:opacity-50 transition"
                                    >
                                        {saving ? 'Syncing…' : 'Sync to Google Calendar'}
                                    </button>
                                </div>
                            )}

                            {error && <p className="text-sm text-slate-700 bg-slate-100 px-2 py-1">{error}</p>}

                            <div className="flex justify-end pt-2">
                                <button onClick={onClose} className="text-xs text-slate-500 hover:text-slate-700">Close</button>
                            </div>
                        </div>
                    ) : (
                        <>
                            {/* Submitter info — shown first */}
                            <div className="mb-4 border border-slate-200 bg-slate-50 p-3">
                                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Submitter</p>
                                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-slate-600">
                                    <div><span className="text-slate-400">Name:</span> {suggestion.submitter_name || '—'}</div>
                                    <div><span className="text-slate-400">Email:</span> {suggestion.submitter_email || '—'}</div>
                                    {suggestion.submitter_ip && <div><span className="text-slate-400">IP:</span> {suggestion.submitter_ip}</div>}
                                    {(suggestion.submitter_city || suggestion.submitter_country) && (
                                        <div><span className="text-slate-400">Location:</span> {[suggestion.submitter_city, suggestion.submitter_country].filter(Boolean).join(', ')}</div>
                                    )}
                                    {suggestion.submitter_timezone && <div><span className="text-slate-400">Timezone:</span> {suggestion.submitter_timezone}</div>}
                                    <div><span className="text-slate-400">Submitted:</span> {fmtDate(suggestion.created_at)}</div>
                                </div>
                            </div>

                            {/* Suggestion details — read-only (event is editable after approval) */}
                            <div className="space-y-3 mb-4">
                                <Field label="Title" value={suggestion.title} />
                                {suggestion.description && (
                                    <Field label="Description" value={suggestion.description} multiline />
                                )}
                                {suggestion.location && (
                                    <Field label="Location" value={suggestion.location} />
                                )}
                                <div className="grid grid-cols-2 gap-3">
                                    <Field label="Start" value={fmtDate(suggestion.start)} />
                                    <Field label="End" value={fmtDate(suggestion.end)} />
                                </div>
                                {suggestion.all_day && (
                                    <p className="text-[11px] text-slate-500">All day event</p>
                                )}

                                {price && <Field label="Price" value={price} />}

                                {suggestion.links && suggestion.links.length > 0 && (
                                    <div>
                                        <p className="mb-1 text-xs font-medium text-slate-600">Links</p>
                                        <ul className="text-xs space-y-1">
                                            {suggestion.links.map((l, i) => (
                                                <li key={i}>
                                                    <a
                                                        href={l.url}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        className="text-blue-600 hover:text-blue-800 hover:underline break-all"
                                                    >
                                                        {l.label || l.url}
                                                    </a>
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                )}

                                {suggestion.suggested_tag_ids && suggestion.suggested_tag_ids.length > 0 && (
                                    <div>
                                        <p className="mb-1 text-xs font-medium text-slate-600">Suggested tag IDs</p>
                                        <p className="text-xs text-slate-500">{suggestion.suggested_tag_ids.join(', ')}</p>
                                    </div>
                                )}
                            </div>

                            {/* Admin notes */}
                            <div className="mb-4">
                                <label className="mb-1 block text-xs font-medium text-slate-600">Admin Notes</label>
                                <textarea
                                    value={adminNotes}
                                    onChange={(e) => setAdminNotes(e.target.value)}
                                    rows={2}
                                    placeholder="Internal notes…"
                                    className="w-full border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                />
                            </div>

                            {error && <p className="mb-3 text-sm text-slate-700 bg-slate-100 px-2 py-1">{error}</p>}

                            {/* Actions */}
                            <div className="flex items-center gap-2 flex-wrap">
                                {isPending && !rejectMode && (
                                    <>
                                        <select
                                            value={selectedCalendarId}
                                            onChange={(e) => setSelectedCalendarId(e.target.value)}
                                            className="border border-slate-300 text-xs px-2 py-1.5 focus:border-blue-500 focus:outline-none"
                                        >
                                            <option value="">Select calendar…</option>
                                            {calendars.filter((c) => c.enabled).map((c) => (
                                                <option key={c.calendar_id} value={c.calendar_id}>{c.name}</option>
                                            ))}
                                        </select>
                                        <button
                                            onClick={handleApprove}
                                            disabled={saving || !selectedCalendarId}
                                            className="bg-sky-600 text-white text-xs font-medium px-3 py-1.5 hover:bg-sky-700 disabled:opacity-50 transition"
                                        >
                                            {saving ? 'Saving…' : 'Approve'}
                                        </button>
                                        <button
                                            onClick={() => setRejectMode(true)}
                                            className="bg-slate-200 text-slate-700 text-xs font-medium px-3 py-1.5 hover:bg-slate-300 transition"
                                        >
                                            Reject
                                        </button>
                                    </>
                                )}

                                {isPending && rejectMode && (
                                    <>
                                        <button
                                            onClick={handleReject}
                                            disabled={saving}
                                            className="bg-slate-700 text-white text-xs font-medium px-3 py-1.5 hover:bg-slate-800 disabled:opacity-50 transition"
                                        >
                                            Confirm Reject
                                        </button>
                                        <button
                                            onClick={() => setRejectMode(false)}
                                            className="text-xs text-slate-500 hover:text-slate-700"
                                        >
                                            Cancel
                                        </button>
                                    </>
                                )}

                                <button onClick={onClose} className="ml-auto text-xs text-slate-500 hover:text-slate-700">
                                    Close
                                </button>
                            </div>
                        </>
                    )}
                </div>
            </div>

            <AdminEventDetailPanel
                eventId={adminDetailEventId}
                onClose={() => setAdminDetailEventId(null)}
            />
        </>
    );
}

function Field({ label, value, multiline = false }: { label: string; value: string; multiline?: boolean }) {
    return (
        <div>
            <p className="mb-1 text-xs font-medium text-slate-600">{label}</p>
            <p className={`text-sm text-slate-800 ${multiline ? 'whitespace-pre-wrap' : ''}`}>{value}</p>
        </div>
    );
}
