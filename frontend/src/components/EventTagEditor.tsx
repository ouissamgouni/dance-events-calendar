import { useState, useEffect } from 'react';
import type { TagGroup, Tag } from '../types';
import { updateEventTags, fetchTagGroups } from '../api';

interface Props {
    eventId: string;
    currentTags: Tag[];
    onUpdated: () => void;
}

export default function EventTagEditor({ eventId, currentTags, onUpdated }: Props) {
    const [tagGroups, setTagGroups] = useState<TagGroup[]>([]);
    const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set(currentTags.map((t) => t.id)));
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        fetchTagGroups().then(setTagGroups).catch(() => { });
    }, []);

    useEffect(() => {
        setSelectedIds(new Set(currentTags.map((t) => t.id)));
    }, [currentTags]);

    const toggle = (tagId: number) => {
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(tagId)) next.delete(tagId);
            else next.add(tagId);
            return next;
        });
    };

    const save = async () => {
        setSaving(true);
        try {
            await updateEventTags(eventId, [...selectedIds]);
            onUpdated();
        } catch {
            // silently fail
        } finally {
            setSaving(false);
        }
    };

    const hasChanges =
        selectedIds.size !== currentTags.length ||
        currentTags.some((t) => !selectedIds.has(t.id));

    return (
        <div className="space-y-2">
            <h4 className="text-xs font-semibold text-gray-600 uppercase tracking-wider">Tags</h4>
            {tagGroups.map((group) => (
                <div key={group.slug}>
                    <p className="text-xs text-gray-500 mb-0.5">{group.label}</p>
                    <div className="flex flex-wrap gap-1">
                        {group.tags.map((tag) => {
                            const active = selectedIds.has(tag.id);
                            const c = tag.group_color ?? tag.color ?? '#6b7280';
                            return (
                                <button
                                    key={tag.id}
                                    onClick={() => toggle(tag.id)}
                                    className={`rounded-full px-2 py-0.5 text-xs border transition-colors ${active ? 'text-white' : 'bg-white'
                                        }`}
                                    style={
                                        active
                                            ? { backgroundColor: c, borderColor: c }
                                            : { borderColor: `${c}60`, color: c }
                                    }
                                >
                                    {tag.label}
                                </button>
                            );
                        })}
                    </div>
                </div>
            ))}
            {hasChanges && (
                <button
                    onClick={save}
                    disabled={saving}
                    className="rounded bg-blue-500 px-3 py-1 text-xs font-medium text-white hover:bg-blue-600 disabled:opacity-50"
                >
                    {saving ? 'Saving…' : 'Save Tags'}
                </button>
            )}
        </div>
    );
}
