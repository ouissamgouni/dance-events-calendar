import { useEffect, useState } from 'react';
import type { Tag, TagGroup } from '../types';
import { fetchTagGroups, updateEventTags } from '../api';
import TagsPicker, { type TagsPickerValue } from './TagsPicker';

interface Props {
    eventId: string;
    currentTags: Tag[];
    onUpdated?: () => void;
}

/**
 * Tag picker that auto-saves on every selection change. Same UX as
 * `TagsPicker` (searchable + group filter chips) but without free-text
 * suggestions and without a Save button — toggling a tag persists
 * immediately.
 */
export default function InlineTagsPicker({ eventId, currentTags, onUpdated }: Props) {
    const [tagGroups, setTagGroups] = useState<TagGroup[]>([]);
    const [value, setValue] = useState<TagsPickerValue>({
        selectedTagIds: currentTags.map((t) => t.id),
        freeTexts: {},
    });
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        fetchTagGroups().then(setTagGroups).catch(() => { });
    }, []);

    useEffect(() => {
        setValue({ selectedTagIds: currentTags.map((t) => t.id), freeTexts: {} });
    }, [currentTags]);

    const handleChange = async (next: TagsPickerValue) => {
        const prev = value;
        setValue(next);
        setSaving(true);
        setError(null);
        try {
            await updateEventTags(eventId, next.selectedTagIds);
            onUpdated?.();
        } catch {
            setError('Failed to save');
            setValue(prev);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="space-y-1">
            <TagsPicker
                tagGroups={tagGroups}
                value={value}
                onChange={handleChange}
                allowFreeText={false}
                searchable
            />
            <div className="flex items-center gap-2 min-h-[14px]">
                {saving && <span className="text-[10px] text-slate-400">Saving…</span>}
                {error && <span className="text-[10px] text-red-500">{error}</span>}
            </div>
        </div>
    );
}
