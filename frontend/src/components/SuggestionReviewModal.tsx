import { useState } from 'react';
import type { EventSuggestion, CalendarSetting, LinkItem } from '../types';
import { updateSuggestion, approveSuggestion, rejectSuggestion, syncSuggestionToGoogle } from '../api';

interface Props {
    suggestion: EventSuggestion;
    calendars: CalendarSetting[];
    onClose: () => void;
    onUpdated: (s: EventSuggestion) => void;
}

const STATUS_COLORS: Record<string, string> = {
    pending: 'bg-amber-100 text-amber-700',
    approved: 'bg-emerald-100 text-emerald-700',
    rejected: 'bg-red-100 text-red-700',
};

export default function SuggestionReviewModal({ suggestion, calendars, onClose, onUpdated }: Props) {
    const [title, setTitle] = useState(suggestion.title);
    const [description, setDescription] = useState(suggestion.description ?? '');
    const [location, setLocation] = useState(suggestion.location ?? '');
    const [start, setStart] = useState(suggestion.start.slice(0, 16));
    const [end, setEnd] = useState(suggestion.end.slice(0, 16));
    const [allDay, setAllDay] = useState(suggestion.all_day);
    const [editLinks, setEditLinks] = useState<{ url: string; label: string }[]>(
        suggestion.links?.map((l) => ({ url: l.url, label: l.label ?? '' })) ?? [],
    );
    const [adminNotes, setAdminNotes] = useState(suggestion.admin_notes ?? '');
    const [selectedCalendarId, setSelectedCalendarId] = useState(
        suggestion.assigned_calendar_id ?? calendars.find((c) => c.enabled)?.calendar_id ?? '',
    );
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [rejectMode, setRejectMode] = useState(false);

    const isPending = suggestion.status === 'pending';
    const isApproved = suggestion.status === 'approved';

    const handleSave = async () => {
        setSaving(true);
        setError('');
        try {
            const data: Record<string, unknown> = {};
            if (title !== suggestion.title) data.title = title;
            if (description !== (suggestion.description ?? '')) data.description = description;
            if (location !== (suggestion.location ?? '')) data.location = location;
            if (start !== suggestion.start.slice(0, 16)) data.start = new Date(start).toISOString();
            if (end !== suggestion.end.slice(0, 16)) data.end = new Date(end).toISOString();
            if (allDay !== suggestion.all_day) data.all_day = allDay;
            if (adminNotes !== (suggestion.admin_notes ?? '')) data.admin_notes = adminNotes;

            const linksPayload: LinkItem[] = editLinks
                .filter((l) => l.url.trim())
                .map((l) => ({ url: l.url.trim(), label: l.label.trim() || null }));
            if (JSON.stringify(linksPayload) !== JSON.stringify(suggestion.links ?? [])) {
                data.links = linksPayload;
            }

            if (Object.keys(data).length > 0) {
                const updated = await updateSuggestion(suggestion.id, data);
                onUpdated(updated);
            }
        } catch {
            setError('Failed to save changes.');
        } finally {
            setSaving(false);
        }
    };

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

    const fmtDate = (iso: string) => {
        try { return new Date(iso).toLocaleString(); } catch { return iso; }
    };

    return (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40">
            <div className="mx-4 w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl bg-white p-6 shadow-xl">
                {/* Header */}
                <div className="flex items-start justify-between mb-4">
                    <div>
                        <h2 className="text-base font-semibold text-slate-800">Review Suggestion</h2>
                        <div className="mt-1 flex items-center gap-2">
                            <span className={`text-[10px] font-semibold uppercase px-2 py-0.5 rounded ${STATUS_COLORS[suggestion.status] ?? 'bg-gray-100 text-gray-600'}`}>
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

                {/* Editable fields */}
                <div className="space-y-3 mb-4">
                    <div>
                        <label className="mb-1 block text-xs font-medium text-slate-600">Title</label>
                        <input type="text" value={title} onChange={(e) => setTitle(e.target.value)}
                            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                    </div>
                    <div>
                        <label className="mb-1 block text-xs font-medium text-slate-600">Description</label>
                        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3}
                            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                    </div>
                    <div>
                        <label className="mb-1 block text-xs font-medium text-slate-600">Location</label>
                        <input type="text" value={location} onChange={(e) => setLocation(e.target.value)}
                            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="mb-1 block text-xs font-medium text-slate-600">Start</label>
                            <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)}
                                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                        </div>
                        <div>
                            <label className="mb-1 block text-xs font-medium text-slate-600">End</label>
                            <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)}
                                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                        </div>
                    </div>
                    <label className="flex items-center gap-2 text-sm text-slate-600">
                        <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} className="rounded border-slate-300" />
                        All day event
                    </label>

                    {/* Links editor */}
                    <div className="border-t border-slate-200 pt-3">
                        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Links</p>
                        {editLinks.map((link, i) => (
                            <div key={i} className="flex gap-2 mb-1.5">
                                <input type="url" value={link.url}
                                    onChange={(e) => setEditLinks((prev) => prev.map((l, j) => (j === i ? { ...l, url: e.target.value } : l)))}
                                    placeholder="https://…"
                                    className="flex-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                                <input type="text" value={link.label}
                                    onChange={(e) => setEditLinks((prev) => prev.map((l, j) => (j === i ? { ...l, label: e.target.value } : l)))}
                                    placeholder="Label"
                                    className="w-24 rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                                <button type="button" onClick={() => setEditLinks((prev) => prev.filter((_, j) => j !== i))}
                                    className="text-slate-400 hover:text-red-500 text-sm px-1">✕</button>
                            </div>
                        ))}
                        {editLinks.length < 3 && (
                            <button type="button" onClick={() => setEditLinks((prev) => [...prev, { url: '', label: '' }])}
                                className="text-xs text-blue-600 hover:text-blue-700">+ Add link</button>
                        )}
                    </div>

                    {/* Admin notes */}
                    <div className="border-t border-slate-200 pt-3">
                        <label className="mb-1 block text-xs font-medium text-slate-600">Admin Notes</label>
                        <textarea value={adminNotes} onChange={(e) => setAdminNotes(e.target.value)} rows={2}
                            placeholder="Internal notes…"
                            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                    </div>
                </div>

                {/* Submitter metadata */}
                <div className="border-t border-slate-200 pt-3 mb-4">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Submitter Info</p>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-slate-600">
                        {suggestion.submitter_name && <div><span className="text-slate-400">Name:</span> {suggestion.submitter_name}</div>}
                        {suggestion.submitter_email && <div><span className="text-slate-400">Email:</span> {suggestion.submitter_email}</div>}
                        {suggestion.submitter_ip && <div><span className="text-slate-400">IP:</span> {suggestion.submitter_ip}</div>}
                        {(suggestion.submitter_city || suggestion.submitter_country) && (
                            <div><span className="text-slate-400">Location:</span> {[suggestion.submitter_city, suggestion.submitter_country].filter(Boolean).join(', ')}</div>
                        )}
                        {suggestion.submitter_timezone && <div><span className="text-slate-400">Timezone:</span> {suggestion.submitter_timezone}</div>}
                        {suggestion.submitter_language && <div><span className="text-slate-400">Language:</span> {suggestion.submitter_language}</div>}
                        {suggestion.submitter_referrer && <div className="col-span-2"><span className="text-slate-400">Referrer:</span> {suggestion.submitter_referrer}</div>}
                        {suggestion.submitter_screen_size && <div><span className="text-slate-400">Screen:</span> {suggestion.submitter_screen_size}</div>}
                        {suggestion.submitter_user_agent && <div className="col-span-2 truncate"><span className="text-slate-400">UA:</span> {suggestion.submitter_user_agent}</div>}
                        <div><span className="text-slate-400">Created:</span> {fmtDate(suggestion.created_at)}</div>
                        {suggestion.reviewed_at && <div><span className="text-slate-400">Reviewed:</span> {fmtDate(suggestion.reviewed_at)}</div>}
                        {suggestion.reviewed_by && <div><span className="text-slate-400">Reviewer:</span> {suggestion.reviewed_by}</div>}
                    </div>
                </div>

                {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

                {/* Action buttons */}
                <div className="flex items-center gap-2 flex-wrap">
                    <button onClick={handleSave} disabled={saving}
                        className="bg-gray-800 text-white text-xs font-medium px-3 py-1.5 rounded hover:bg-gray-700 disabled:opacity-50 transition">
                        {saving ? 'Saving…' : 'Save Changes'}
                    </button>

                    {isPending && !rejectMode && (
                        <>
                            <div className="w-px h-5 bg-slate-200 mx-1" />
                            <select value={selectedCalendarId} onChange={(e) => setSelectedCalendarId(e.target.value)}
                                className="border border-slate-300 rounded text-xs px-2 py-1.5 focus:border-blue-500 focus:outline-none">
                                <option value="">Select calendar…</option>
                                {calendars.filter((c) => c.enabled).map((c) => (
                                    <option key={c.calendar_id} value={c.calendar_id}>{c.name}</option>
                                ))}
                            </select>
                            <button onClick={handleApprove} disabled={saving || !selectedCalendarId}
                                className="bg-emerald-600 text-white text-xs font-medium px-3 py-1.5 rounded hover:bg-emerald-700 disabled:opacity-50 transition">
                                Approve
                            </button>
                            <button onClick={() => setRejectMode(true)}
                                className="bg-red-600 text-white text-xs font-medium px-3 py-1.5 rounded hover:bg-red-700 transition">
                                Reject
                            </button>
                        </>
                    )}

                    {isPending && rejectMode && (
                        <>
                            <div className="w-px h-5 bg-slate-200 mx-1" />
                            <button onClick={handleReject} disabled={saving}
                                className="bg-red-600 text-white text-xs font-medium px-3 py-1.5 rounded hover:bg-red-700 disabled:opacity-50 transition">
                                Confirm Reject
                            </button>
                            <button onClick={() => setRejectMode(false)}
                                className="text-xs text-slate-500 hover:text-slate-700">
                                Cancel
                            </button>
                        </>
                    )}

                    {isApproved && !suggestion.synced_to_google && (
                        <>
                            <div className="w-px h-5 bg-slate-200 mx-1" />
                            <button onClick={handleSync} disabled={saving}
                                className="bg-blue-600 text-white text-xs font-medium px-3 py-1.5 rounded hover:bg-blue-700 disabled:opacity-50 transition">
                                Sync to Google
                            </button>
                        </>
                    )}

                    <button onClick={onClose} className="ml-auto text-xs text-slate-500 hover:text-slate-700">
                        Close
                    </button>
                </div>
            </div>
        </div>
    );
}
