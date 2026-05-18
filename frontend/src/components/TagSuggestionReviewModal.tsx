import { useState } from 'react';
import type { TagSuggestionResponse, TagGroup } from '../types';
import { approveTagSuggestion, rejectTagSuggestion, createTag } from '../api';

interface FlatTag {
    id: number;
    label: string;
    groupLabel: string;
    groupId: number;
}

interface Props {
    suggestion: TagSuggestionResponse;
    allTags: FlatTag[];
    tagGroups: TagGroup[];
    onClose: () => void;
    onUpdated: (s: TagSuggestionResponse) => void;
    /** Open the admin event-detail side panel for the suggestion's event. */
    onViewEvent?: (eventId: string) => void;
}

const STATUS_COLORS: Record<string, string> = {
    pending: 'bg-amber-100 text-amber-700',
    approved: 'bg-emerald-100 text-emerald-700',
    rejected: 'bg-slate-200 text-slate-700',
};

type FreeTextMode = 'assign' | 'create';

export default function TagSuggestionReviewModal({
    suggestion,
    allTags,
    tagGroups,
    onClose,
    onUpdated,
    onViewEvent,
}: Props) {
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [rejectMode, setRejectMode] = useState(false);
    const [adminNotes, setAdminNotes] = useState(suggestion.admin_notes ?? '');
    const [descExpanded, setDescExpanded] = useState(false);

    // Assign-existing-tag state
    const [assignTagId, setAssignTagId] = useState<number | ''>('');

    // Create-new-tag state
    const [freeTextMode, setFreeTextMode] = useState<FreeTextMode>('assign');
    const [newTagLabel, setNewTagLabel] = useState(suggestion.free_text ?? '');
    const [newTagGroupId, setNewTagGroupId] = useState<number | ''>(
        () => {
            if (suggestion.group_slug) {
                const match = tagGroups.find((g) => g.slug === suggestion.group_slug);
                if (match) return match.id;
            }
            return '';
        }
    );

    // Event detail overlay handled by parent via onViewEvent.

    const isPending = suggestion.status === 'pending';
    const isFreeText = !suggestion.tag && !!suggestion.free_text;

    const handleApprove = async () => {
        setSaving(true);
        setError('');
        try {
            let tagId: number | undefined;

            if (isFreeText) {
                if (freeTextMode === 'assign') {
                    if (!assignTagId) { setError('Select a tag to assign.'); setSaving(false); return; }
                    tagId = assignTagId as number;
                } else {
                    // create new tag first
                    if (!newTagLabel.trim()) { setError('Tag label is required.'); setSaving(false); return; }
                    if (!newTagGroupId) { setError('Select a tag group.'); setSaving(false); return; }
                    const created = await createTag({ group_id: newTagGroupId as number, label: newTagLabel.trim() });
                    tagId = created.id;
                }
            } else {
                tagId = suggestion.tag?.id;
            }

            const updated = await approveTagSuggestion(suggestion.id, tagId);
            onUpdated(updated);
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : 'Failed to approve.');
        } finally {
            setSaving(false);
        }
    };

    const handleReject = async () => {
        setSaving(true);
        setError('');
        try {
            const updated = await rejectTagSuggestion(suggestion.id, adminNotes || undefined);
            onUpdated(updated);
            setRejectMode(false);
        } catch {
            setError('Failed to reject.');
        } finally {
            setSaving(false);
        }
    };

    const handleViewEvent = () => {
        if (onViewEvent) {
            onViewEvent(suggestion.event_id);
            onClose();
        }
    };

    const fmtDate = (iso: string) => {
        try { return new Date(iso).toLocaleString(); } catch { return iso; }
    };

    return (
        <>
            <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40">
                <div className="mx-4 w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl bg-white p-6 shadow-xl">
                    {/* Header */}
                    <div className="flex items-start justify-between mb-4">
                        <div>
                            <h2 className="text-base font-semibold text-slate-800">Review Tag Suggestion</h2>
                            <div className="mt-1 flex items-center gap-2">
                                <span className={`text-[10px] font-semibold uppercase px-2 py-0.5 rounded ${STATUS_COLORS[suggestion.status] ?? 'bg-gray-100 text-gray-600'}`}>
                                    {suggestion.status}
                                </span>
                            </div>
                        </div>
                        <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-lg p-1">✕</button>
                    </div>

                    {/* Event info */}
                    <div className="mb-4 p-3 bg-slate-50 rounded-lg">
                        <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-0.5">Event</p>
                                <p className="text-sm font-medium text-slate-800 truncate">
                                    {suggestion.event_title || suggestion.event_id}
                                </p>
                                <p className="text-[10px] text-slate-400 mt-0.5 font-mono">{suggestion.event_id}</p>
                            </div>
                            {onViewEvent && (
                                <button
                                    onClick={handleViewEvent}
                                    className="shrink-0 text-[11px] text-sky-700 hover:text-sky-900 font-medium"
                                >
                                    View event →
                                </button>
                            )}
                        </div>
                        {suggestion.event_description && (
                            <div className="mt-2 text-[12px] text-slate-600 leading-snug">
                                <p className={descExpanded ? '' : 'line-clamp-3'}>
                                    {suggestion.event_description}
                                </p>
                                {suggestion.event_description.length > 180 && (
                                    <button
                                        type="button"
                                        onClick={() => setDescExpanded((v) => !v)}
                                        className="mt-1 text-[10px] uppercase tracking-wide text-slate-400 hover:text-slate-600"
                                    >
                                        {descExpanded ? 'See less' : 'See more'}
                                    </button>
                                )}
                            </div>
                        )}
                        {(suggestion.event_start || suggestion.event_location) && (
                            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-slate-500">
                                {suggestion.event_start && (
                                    <span>📅 {fmtDate(suggestion.event_start)}</span>
                                )}
                                {suggestion.event_location && (
                                    <span className="truncate">📍 {suggestion.event_location}</span>
                                )}
                            </div>
                        )}
                    </div>

                    {/* Tag suggestion */}
                    <div className="mb-4">
                        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Suggested Tag</p>
                        {suggestion.tag ? (
                            <span
                                className="inline-flex items-center gap-1 rounded-full px-3 py-1 text-sm font-medium"
                                style={{
                                    backgroundColor: `${suggestion.tag.group_color ?? suggestion.tag.color ?? '#6b7280'}20`,
                                    color: suggestion.tag.group_color ?? suggestion.tag.color ?? '#6b7280',
                                }}
                            >
                                <span className="text-xs opacity-70">{suggestion.tag.group_label}:</span>
                                {suggestion.tag.label}
                            </span>
                        ) : suggestion.free_text ? (
                            <div className="space-y-3">
                                <p className="text-sm text-slate-700 italic">
                                    Free text: &ldquo;{suggestion.free_text}&rdquo;
                                    {suggestion.group_slug && (
                                        <span className="ml-2 text-[10px] text-slate-400 not-italic">
                                            (category hint: {suggestion.group_slug})
                                        </span>
                                    )}
                                </p>

                                {isPending && (
                                    <>
                                        {/* Mode toggle */}
                                        <div className="flex gap-2">
                                            <button
                                                onClick={() => setFreeTextMode('assign')}
                                                className={`text-[11px] px-2.5 py-1 rounded border transition ${freeTextMode === 'assign' ? 'bg-violet-500 text-white border-violet-500' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'}`}
                                            >
                                                Assign existing tag
                                            </button>
                                            <button
                                                onClick={() => setFreeTextMode('create')}
                                                className={`text-[11px] px-2.5 py-1 rounded border transition ${freeTextMode === 'create' ? 'bg-violet-500 text-white border-violet-500' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'}`}
                                            >
                                                Create new tag
                                            </button>
                                        </div>

                                        {freeTextMode === 'assign' ? (
                                            <select
                                                value={assignTagId}
                                                onChange={(e) => setAssignTagId(Number(e.target.value) || '')}
                                                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
                                            >
                                                <option value="">Assign existing tag…</option>
                                                {allTags.map((t) => (
                                                    <option key={t.id} value={t.id}>
                                                        {t.groupLabel}: {t.label}
                                                    </option>
                                                ))}
                                            </select>
                                        ) : (
                                            <div className="space-y-2">
                                                <div>
                                                    <label className="mb-1 block text-xs font-medium text-slate-600">New tag label</label>
                                                    <input
                                                        type="text"
                                                        value={newTagLabel}
                                                        onChange={(e) => setNewTagLabel(e.target.value)}
                                                        placeholder="Tag label…"
                                                        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
                                                    />
                                                </div>
                                                <div>
                                                    <label className="mb-1 block text-xs font-medium text-slate-600">Tag group / category</label>
                                                    <select
                                                        value={newTagGroupId}
                                                        onChange={(e) => setNewTagGroupId(Number(e.target.value) || '')}
                                                        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
                                                    >
                                                        <option value="">Select group…</option>
                                                        {tagGroups.filter((g) => g.enabled !== false).map((g) => (
                                                            <option key={g.id} value={g.id}>
                                                                {g.label}
                                                                {g.slug === suggestion.group_slug ? ' (suggested)' : ''}
                                                            </option>
                                                        ))}
                                                    </select>
                                                </div>
                                            </div>
                                        )}
                                    </>
                                )}
                            </div>
                        ) : (
                            <p className="text-sm text-slate-400 italic">No tag information</p>
                        )}
                    </div>

                    {/* Admin notes (always shown for context on non-pending) */}
                    {(isPending || suggestion.admin_notes) && (
                        <div className="mb-4">
                            <label className="mb-1 block text-xs font-medium text-slate-600">Admin Notes</label>
                            {isPending ? (
                                <textarea
                                    value={adminNotes}
                                    onChange={(e) => setAdminNotes(e.target.value)}
                                    rows={2}
                                    placeholder="Internal notes…"
                                    className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                />
                            ) : (
                                <p className="text-sm text-slate-600 italic">{suggestion.admin_notes}</p>
                            )}
                        </div>
                    )}

                    {/* Metadata */}
                    <div className="border-t border-slate-200 pt-3 mb-4">
                        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Details</p>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-slate-600">
                            <div><span className="text-slate-400">Submitted:</span> {fmtDate(suggestion.created_at)}</div>
                            {suggestion.reviewed_at && (
                                <div><span className="text-slate-400">Reviewed:</span> {fmtDate(suggestion.reviewed_at)}</div>
                            )}
                            {suggestion.submitter_device_id && (
                                <div className="col-span-2 truncate">
                                    <span className="text-slate-400">Device:</span> {suggestion.submitter_device_id}
                                </div>
                            )}
                        </div>
                    </div>

                    {error && <p className="mb-3 text-sm text-slate-600 bg-slate-100 px-2 py-1 rounded">{error}</p>}

                    {/* Actions */}
                    <div className="flex items-center gap-2 flex-wrap">
                        {isPending && !rejectMode && (
                            <>
                                <button
                                    onClick={handleApprove}
                                    disabled={saving}
                                    className="bg-sky-600 text-white text-xs font-medium px-3 py-1.5 rounded hover:bg-sky-700 disabled:opacity-50 transition"
                                >
                                    {saving ? 'Saving…' : 'Approve'}
                                </button>
                                <button
                                    onClick={() => setRejectMode(true)}
                                    className="bg-slate-200 text-slate-700 text-xs font-medium px-3 py-1.5 rounded hover:bg-slate-300 transition"
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
                                    className="bg-slate-700 text-white text-xs font-medium px-3 py-1.5 rounded hover:bg-slate-800 disabled:opacity-50 transition"
                                >
                                    {saving ? 'Saving…' : 'Confirm Reject'}
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
                </div>
            </div>
        </>
    );
}
