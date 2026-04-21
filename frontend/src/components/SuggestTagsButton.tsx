import { useState } from 'react';
import type { TagGroup } from '../types';
import { submitTagSuggestion } from '../api';

interface Props {
    eventId: string;
    tagGroups: TagGroup[];
    existingTagIds: Set<number>;
    deviceId: string;
    onClose: () => void;
}

export default function SuggestTagsButton({ eventId, tagGroups, existingTagIds, deviceId, onClose }: Props) {
    const [selectedGroupSlug, setSelectedGroupSlug] = useState<string | null>(tagGroups[0]?.slug ?? null);
    const [selectedTagIds, setSelectedTagIds] = useState<Set<number>>(new Set());
    const [freeTexts, setFreeTexts] = useState<Record<string, string>>({});
    const [showFreeText, setShowFreeText] = useState(false);
    const [website, setWebsite] = useState(''); // honeypot
    const [submitting, setSubmitting] = useState(false);
    const [success, setSuccess] = useState(false);
    const [error, setError] = useState('');

    const activeGroup = tagGroups.find((g) => g.slug === selectedGroupSlug);
    const availableTags = activeGroup?.tags.filter((t) => !existingTagIds.has(t.id)) ?? [];

    const totalCount =
        selectedTagIds.size +
        Object.values(freeTexts).filter((v) => v.trim()).length;

    const toggleTag = (tagId: number) => {
        setSelectedTagIds((prev) => {
            const next = new Set(prev);
            if (next.has(tagId)) next.delete(tagId);
            else next.add(tagId);
            return next;
        });
    };

    const handleFreeTextChange = (text: string) => {
        if (!selectedGroupSlug) return;
        setFreeTexts((prev) => ({ ...prev, [selectedGroupSlug]: text }));
    };

    const currentFreeText = selectedGroupSlug ? (freeTexts[selectedGroupSlug] ?? '') : '';

    const handleSubmit = async () => {
        if (totalCount === 0) {
            setError('Select at least one tag or enter a suggestion.');
            return;
        }
        setSubmitting(true);
        setError('');
        try {
            // Submit selected tags
            for (const tagId of selectedTagIds) {
                await submitTagSuggestion({
                    event_id: eventId,
                    tag_id: tagId,
                    device_id: deviceId,
                    website: website || undefined,
                });
            }
            // Submit free-text entries
            for (const [groupSlug, text] of Object.entries(freeTexts)) {
                if (!text.trim()) continue;
                await submitTagSuggestion({
                    event_id: eventId,
                    free_text: text.trim(),
                    group_slug: groupSlug,
                    device_id: deviceId,
                    website: website || undefined,
                });
            }
            setSuccess(true);
        } catch {
            setError('Failed to submit. Please try again.');
        } finally {
            setSubmitting(false);
        }
    };

    if (success) {
        return (
            <div className="p-4 text-center">
                <p className="text-green-600 font-medium text-sm">
                    Thank you! {totalCount} suggestion{totalCount !== 1 ? 's' : ''} submitted.
                </p>
                <button onClick={onClose} className="mt-2 text-xs text-gray-500 hover:text-gray-700">
                    Close
                </button>
            </div>
        );
    }

    return (
        <div className="p-4 space-y-3">
            <h3 className="text-sm font-semibold text-gray-700">Suggest Tags</h3>

            {/* Category pills */}
            <div className="flex flex-wrap gap-1.5">
                {tagGroups.map((group) => {
                    const c = group.color ?? '#6b7280';
                    const active = group.slug === selectedGroupSlug;
                    return (
                        <button
                            key={group.slug}
                            onClick={() => { setSelectedGroupSlug(group.slug); setShowFreeText(false); }}
                            className={`px-2.5 py-1 text-xs font-medium border transition-colors ${active ? 'text-white' : ''
                                }`}
                            style={
                                active
                                    ? { backgroundColor: c, borderColor: c }
                                    : { borderColor: `${c}50`, color: c, backgroundColor: `${c}10` }
                            }
                        >
                            {group.label}
                        </button>
                    );
                })}
            </div>

            {/* Tags for selected category */}
            {activeGroup && (
                <div className="space-y-2">
                    {availableTags.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                            {availableTags.map((tag) => {
                                const c = tag.group_color ?? tag.color ?? '#6b7280';
                                const selected = selectedTagIds.has(tag.id);
                                return (
                                    <button
                                        key={tag.id}
                                        onClick={() => toggleTag(tag.id)}
                                        className={`px-2 py-0.5 text-xs border transition-colors ${selected ? 'text-white' : 'bg-white'
                                            }`}
                                        style={
                                            selected
                                                ? { backgroundColor: c, borderColor: c }
                                                : { borderColor: `${c}60`, color: c }
                                        }
                                    >
                                        {selected && '✓ '}{tag.label}
                                    </button>
                                );
                            })}
                        </div>
                    ) : (
                        <p className="text-xs text-gray-400 italic">All tags in this category are already on this event.</p>
                    )}

                    {/* Suggest new tag toggle */}
                    {!showFreeText ? (
                        <button
                            onClick={() => setShowFreeText(true)}
                            className="text-xs text-rose-500 hover:text-rose-700 font-medium"
                        >
                            + Suggest new tag
                        </button>
                    ) : (
                        <div>
                            <label className="text-xs text-gray-500">
                                New tag for <span className="font-medium">{activeGroup.label}</span>:
                            </label>
                            <input
                                type="text"
                                value={currentFreeText}
                                onChange={(e) => handleFreeTextChange(e.target.value)}
                                placeholder={`e.g. new ${activeGroup.label.toLowerCase()} tag`}
                                className="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-rose-400"
                                maxLength={100}
                            />
                        </div>
                    )}
                </div>
            )}

            {/* Honeypot */}
            <input
                type="text"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                className="hidden"
                tabIndex={-1}
                autoComplete="off"
                aria-hidden="true"
            />

            {error && <p className="text-xs text-red-500">{error}</p>}

            <div className="flex gap-2">
                <button
                    onClick={handleSubmit}
                    disabled={submitting || totalCount === 0}
                    className="flex-1 rounded bg-rose-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-600 disabled:opacity-50"
                >
                    {submitting ? 'Submitting…' : totalCount > 0 ? `Submit ${totalCount} suggestion${totalCount !== 1 ? 's' : ''}` : 'Submit'}
                </button>
                <button
                    onClick={onClose}
                    className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
                >
                    Cancel
                </button>
            </div>
        </div>
    );
}
