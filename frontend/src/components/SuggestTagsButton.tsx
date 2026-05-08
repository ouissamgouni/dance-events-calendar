import { useEffect, useMemo, useState } from 'react';
import type { TagGroup } from '../types';
import { submitTagSuggestion } from '../api';
import TagsPicker, { type TagsPickerValue } from './TagsPicker';

export interface InlineTagSuggestion {
    tag_id?: number;
    free_text?: string;
    group_slug?: string;
}

interface Props {
    eventId: string;
    tagGroups: TagGroup[];
    existingTagIds: Set<number>;
    deviceId: string;
    onClose: () => void;
    /**
     * 'standalone' (default): self-contained — submits via /api/tags/suggestions.
     * 'embedded': lifts selection state via onChange; hides Submit/Cancel/success UI.
     */
    mode?: 'standalone' | 'embedded';
    onChange?: (suggestions: InlineTagSuggestion[]) => void;
}

export default function SuggestTagsButton({
    eventId,
    tagGroups,
    existingTagIds,
    deviceId,
    onClose,
    mode = 'standalone',
    onChange,
}: Props) {
    const [value, setValue] = useState<TagsPickerValue>({ selectedTagIds: [], freeTexts: {} });
    const [website, setWebsite] = useState(''); // honeypot
    const [submitting, setSubmitting] = useState(false);
    const [success, setSuccess] = useState(false);
    const [error, setError] = useState('');

    const totalCount = useMemo(() => {
        return value.selectedTagIds.length
            + Object.values(value.freeTexts).filter((v) => v.trim()).length;
    }, [value]);

    // Embedded mode: emit collected suggestions whenever selection changes so
    // the parent (e.g. RateEventModal) can submit them in the unified envelope.
    useEffect(() => {
        if (mode !== 'embedded' || !onChange) return;
        const out: InlineTagSuggestion[] = [];
        for (const tagId of value.selectedTagIds) out.push({ tag_id: tagId });
        for (const [groupSlug, text] of Object.entries(value.freeTexts)) {
            const trimmed = text.trim();
            if (trimmed) out.push({ free_text: trimmed, group_slug: groupSlug });
        }
        onChange(out);
    }, [value, mode, onChange]);

    const handleSubmit = async () => {
        if (totalCount === 0) {
            setError('Select at least one tag or enter a suggestion.');
            return;
        }
        setSubmitting(true);
        setError('');
        try {
            for (const tagId of value.selectedTagIds) {
                await submitTagSuggestion({
                    event_id: eventId,
                    tag_id: tagId,
                    device_id: deviceId,
                    website: website || undefined,
                });
            }
            for (const [groupSlug, text] of Object.entries(value.freeTexts)) {
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
                <p className="text-emerald-600 font-medium text-sm">
                    Thank you! {totalCount} suggestion{totalCount !== 1 ? 's' : ''} submitted.
                </p>
                <button onClick={onClose} className="mt-2 text-xs text-gray-500 hover:text-gray-700">
                    Close
                </button>
            </div>
        );
    }

    const isEmbedded = mode === 'embedded';

    return (
        <div className={isEmbedded ? 'space-y-3' : 'p-4 space-y-3'}>
            {!isEmbedded && <h3 className="text-sm font-semibold text-gray-700">Suggest Tags</h3>}

            <TagsPicker
                tagGroups={tagGroups}
                value={value}
                onChange={setValue}
                excludeTagIds={existingTagIds}
            />

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

            {error && <p className="text-xs text-slate-700 bg-slate-100 px-2 py-1">{error}</p>}

            {!isEmbedded && (
                <div className="flex gap-2">
                    <button
                        onClick={handleSubmit}
                        disabled={submitting || totalCount === 0}
                        className="flex-1 bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                        {submitting ? 'Submitting…' : totalCount > 0 ? `Submit ${totalCount} suggestion${totalCount !== 1 ? 's' : ''}` : 'Submit'}
                    </button>
                    <button
                        onClick={onClose}
                        className="border border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
                    >
                        Cancel
                    </button>
                </div>
            )}
        </div>
    );
}
