import { useState, useEffect } from 'react';
import type { TagSuggestionResponse, TagGroup } from '../types';
import { fetchAdminTagSuggestions, approveTagSuggestion, rejectTagSuggestion, fetchTagGroups } from '../api';

export default function TagSuggestionsPanel() {
    const [suggestions, setSuggestions] = useState<TagSuggestionResponse[]>([]);
    const [tagGroups, setTagGroups] = useState<TagGroup[]>([]);
    const [filter, setFilter] = useState<string>('pending');
    const [loading, setLoading] = useState(true);

    const load = async () => {
        setLoading(true);
        try {
            const [s, g] = await Promise.all([
                fetchAdminTagSuggestions(filter || undefined),
                fetchTagGroups(),
            ]);
            setSuggestions(s);
            setTagGroups(g);
        } catch {
            // silently fail
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        load();
    }, [filter]);

    const handleApprove = async (id: number, tagId?: number) => {
        await approveTagSuggestion(id, tagId);
        load();
    };

    const handleReject = async (id: number) => {
        const notes = prompt('Admin notes (optional):');
        await rejectTagSuggestion(id, notes || undefined);
        load();
    };

    // Flat list of all tags for the assign dropdown
    const allTags = tagGroups.flatMap((g) =>
        g.tags.map((t) => ({ ...t, groupLabel: g.label }))
    );

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-gray-700">Tag Suggestions</h3>
                <select
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    className="rounded border border-gray-300 px-2 py-1 text-xs"
                >
                    <option value="pending">Pending</option>
                    <option value="approved">Approved</option>
                    <option value="rejected">Rejected</option>
                    <option value="">All</option>
                </select>
            </div>

            {loading ? (
                <p className="text-sm text-gray-400">Loading…</p>
            ) : suggestions.length === 0 ? (
                <p className="text-sm text-gray-400">No suggestions found.</p>
            ) : (
                <div className="space-y-2">
                    {suggestions.map((s) => (
                        <div key={s.id} className="rounded border border-gray-200 p-3 text-sm">
                            <div className="flex items-start justify-between">
                                <div>
                                    <p className="font-medium text-gray-800">
                                        {s.event_title || s.event_id}
                                    </p>
                                    {s.tag ? (
                                        <span
                                            className="inline-block rounded-full px-2 py-0.5 text-xs mt-1"
                                            style={{
                                                backgroundColor: `${s.tag.group_color ?? s.tag.color ?? '#6b7280'}20`,
                                                color: s.tag.group_color ?? s.tag.color ?? '#6b7280',
                                            }}
                                        >
                                            {s.tag.group_label}: {s.tag.label}
                                        </span>
                                    ) : s.free_text ? (
                                        <p className="text-gray-500 text-xs mt-1">
                                            Free text: &ldquo;{s.free_text}&rdquo;
                                        </p>
                                    ) : null}
                                    <p className="text-gray-400 text-[10px] mt-1">
                                        {new Date(s.created_at).toLocaleDateString()} · {s.status}
                                    </p>
                                    {s.admin_notes && (
                                        <p className="text-gray-500 text-xs mt-1 italic">
                                            Note: {s.admin_notes}
                                        </p>
                                    )}
                                </div>
                                {s.status === 'pending' && (
                                    <div className="flex gap-1 ml-2 shrink-0">
                                        {s.free_text && !s.tag ? (
                                            <FreeTextApprover
                                                allTags={allTags}
                                                onApprove={(tagId) => handleApprove(s.id, tagId)}
                                            />
                                        ) : (
                                            <button
                                                onClick={() => handleApprove(s.id, s.tag?.id)}
                                                className="rounded bg-green-500 px-2 py-1 text-xs text-white hover:bg-green-600"
                                            >
                                                Approve
                                            </button>
                                        )}
                                        <button
                                            onClick={() => handleReject(s.id)}
                                            className="rounded bg-red-500 px-2 py-1 text-xs text-white hover:bg-red-600"
                                        >
                                            Reject
                                        </button>
                                    </div>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

function FreeTextApprover({
    allTags,
    onApprove,
}: {
    allTags: { id: number; label: string; groupLabel: string }[];
    onApprove: (tagId: number) => void;
}) {
    const [tagId, setTagId] = useState<number | ''>('');

    return (
        <div className="flex gap-1 items-center">
            <select
                value={tagId}
                onChange={(e) => setTagId(Number(e.target.value) || '')}
                className="rounded border border-gray-300 px-1 py-0.5 text-xs max-w-[140px]"
            >
                <option value="">Assign tag…</option>
                {allTags.map((t) => (
                    <option key={t.id} value={t.id}>
                        {t.groupLabel}: {t.label}
                    </option>
                ))}
            </select>
            <button
                onClick={() => tagId && onApprove(tagId as number)}
                disabled={!tagId}
                className="rounded bg-green-500 px-2 py-1 text-xs text-white hover:bg-green-600 disabled:opacity-50"
            >
                Approve
            </button>
        </div>
    );
}
