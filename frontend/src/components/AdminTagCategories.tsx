import { useState, useEffect } from 'react';
import type { AdminTag, AdminTagGroup } from '../api';
import { fetchAdminTagGroups, createTagGroup, updateTagGroup, createTag, updateTag } from '../api';

const CARD_BG_COLORS = [
    'bg-rose-50', 'bg-sky-50', 'bg-amber-50', 'bg-emerald-50',
    'bg-violet-50', 'bg-orange-50', 'bg-teal-50', 'bg-pink-50',
    'bg-indigo-50', 'bg-lime-50', 'bg-cyan-50', 'bg-fuchsia-50',
];

function moveGroup(groups: AdminTagGroup[], fromIndex: number, toIndex: number): AdminTagGroup[] {
    if (fromIndex === toIndex) return groups;
    const next = [...groups];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    return next;
}

export default function AdminTagCategories() {
    const [groups, setGroups] = useState<AdminTagGroup[]>([]);
    const [loading, setLoading] = useState(true);
    const [newGroupLabel, setNewGroupLabel] = useState('');
    const [addingGroup, setAddingGroup] = useState(false);
    const [newTagInputs, setNewTagInputs] = useState<Record<number, string>>({});
    const [editingGroupId, setEditingGroupId] = useState<number | null>(null);
    const [editingGroupLabel, setEditingGroupLabel] = useState('');
    const [draggingGroupId, setDraggingGroupId] = useState<number | null>(null);
    const [dragOverGroupId, setDragOverGroupId] = useState<number | null>(null);
    const [reorderError, setReorderError] = useState<string | null>(null);

    const load = () => {
        fetchAdminTagGroups()
            .then(setGroups)
            .catch(() => { })
            .finally(() => setLoading(false));
    };

    useEffect(() => { load(); }, []);

    const handleAddGroup = async () => {
        const label = newGroupLabel.trim();
        if (!label) return;
        setAddingGroup(false);
        setNewGroupLabel('');
        await createTagGroup({ label });
        load();
    };

    const handleColorChange = async (groupId: number, color: string) => {
        setGroups((prev) =>
            prev.map((g) => (g.id === groupId ? { ...g, color } : g)),
        );
        await updateTagGroup(groupId, { color });
    };

    const handleToggleGroup = async (groupId: number, enabled: boolean) => {
        setGroups((prev) =>
            prev.map((g) => (g.id === groupId ? { ...g, enabled } : g)),
        );
        await updateTagGroup(groupId, { enabled });
    };

    const handleToggleTag = async (tagId: number, enabled: boolean) => {
        setGroups((prev) =>
            prev.map((g) => ({
                ...g,
                tags: g.tags.map((t) => (t.id === tagId ? { ...t, enabled } : t)),
            })),
        );
        await updateTag(tagId, { enabled });
    };

    const handleToggleHero = async (tag: AdminTag) => {
        const nextHero = !tag.is_hero_filter;
        // Compute next hero_ordinal: end of current hero list, or null when removing
        let nextHeroOrdinal: number | null = null;
        if (nextHero) {
            const allTags = groups.flatMap((g) => g.tags);
            const maxOrdinal = allTags
                .filter((t) => t.is_hero_filter && t.id !== tag.id)
                .reduce((max, t) => Math.max(max, t.hero_ordinal ?? 0), -1);
            nextHeroOrdinal = maxOrdinal + 1;
        }
        setGroups((prev) =>
            prev.map((g) => ({
                ...g,
                tags: g.tags.map((t) =>
                    t.id === tag.id
                        ? { ...t, is_hero_filter: nextHero, hero_ordinal: nextHeroOrdinal }
                        : t,
                ),
            })),
        );
        await updateTag(tag.id, { is_hero_filter: nextHero, hero_ordinal: nextHeroOrdinal });
    };

    const handleGroupLabelEdit = (group: AdminTagGroup) => {
        setEditingGroupId(group.id);
        setEditingGroupLabel(group.label);
    };

    const handleGroupLabelSave = async (groupId: number) => {
        const label = editingGroupLabel.trim();
        setEditingGroupId(null);
        if (!label) return;
        await updateTagGroup(groupId, { label });
        load();
    };

    const handleAddTag = async (groupId: number) => {
        const label = (newTagInputs[groupId] || '').trim();
        if (!label) return;
        setNewTagInputs((prev) => ({ ...prev, [groupId]: '' }));
        await createTag({ group_id: groupId, label });
        load();
    };

    const persistGroupOrder = async (next: AdminTagGroup[], previous: AdminTagGroup[]) => {
        const previousOrdinals = new Map(previous.map((g) => [g.id, g.ordinal]));
        const changed = next.filter((g) => previousOrdinals.get(g.id) !== g.ordinal);
        if (!changed.length) return;

        try {
            await Promise.all(changed.map((g) => updateTagGroup(g.id, { ordinal: g.ordinal })));
            setReorderError(null);
        } catch {
            setReorderError('Failed to save category order. Reloaded latest order from server.');
            load();
        }
    };

    const handleGroupDrop = (targetGroupId: number) => {
        if (draggingGroupId == null || draggingGroupId === targetGroupId) {
            setDragOverGroupId(null);
            setDraggingGroupId(null);
            return;
        }

        setGroups((previous) => {
            const fromIndex = previous.findIndex((g) => g.id === draggingGroupId);
            const toIndex = previous.findIndex((g) => g.id === targetGroupId);
            if (fromIndex < 0 || toIndex < 0) return previous;

            const moved = moveGroup(previous, fromIndex, toIndex);
            const reOrdinaled = moved.map((group, index) => ({
                ...group,
                ordinal: index,
            }));
            void persistGroupOrder(reOrdinaled, previous);
            return reOrdinaled;
        });

        setDragOverGroupId(null);
        setDraggingGroupId(null);
    };

    return (
        <div className="mt-6 border border-gray-200 bg-white">
            <div className="px-4 py-2.5 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
                <h2 className="text-[11px] font-semibold text-gray-700 uppercase tracking-wide">
                    Tag Categories
                </h2>
                {!addingGroup ? (
                    <button
                        onClick={() => setAddingGroup(true)}
                        className="text-gray-400 hover:text-gray-700 text-sm font-bold leading-none transition"
                        title="Add category"
                    >
                        +
                    </button>
                ) : (
                    <div className="flex items-center gap-1">
                        <input
                            type="text"
                            value={newGroupLabel}
                            onChange={(e) => setNewGroupLabel(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') handleAddGroup();
                                if (e.key === 'Escape') { setAddingGroup(false); setNewGroupLabel(''); }
                            }}
                            autoFocus
                            placeholder="Category name"
                            className="border border-gray-300 px-2 py-0.5 text-[11px] text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 w-32"
                        />
                        <button
                            onClick={handleAddGroup}
                            disabled={!newGroupLabel.trim()}
                            className="bg-gray-800 text-white text-[10px] font-medium px-2 py-0.5 hover:bg-gray-700 disabled:opacity-50 transition"
                        >
                            Add
                        </button>
                        <button
                            onClick={() => { setAddingGroup(false); setNewGroupLabel(''); }}
                            className="text-gray-400 hover:text-gray-600 text-[10px] px-1"
                        >
                            ✕
                        </button>
                    </div>
                )}
            </div>

            <div className="p-4">
                {reorderError && (
                    <p className="mb-2 text-[11px] text-rose-600">{reorderError}</p>
                )}
                {loading ? (
                    <p className="text-[11px] text-gray-400">Loading…</p>
                ) : groups.length === 0 ? (
                    <p className="text-[11px] text-gray-400">No tag categories yet.</p>
                ) : (
                    <div className="space-y-3">
                        {groups.map((group, idx) => {
                            const groupColor = group.color || '#6b7280';
                            const bgClass = CARD_BG_COLORS[idx % CARD_BG_COLORS.length];
                            return (
                                <div
                                    key={group.id}
                                    className={`border border-gray-200 rounded ${bgClass} ${!group.enabled ? 'opacity-50' : ''} ${dragOverGroupId === group.id ? 'ring-2 ring-blue-300 ring-offset-1' : ''}`}
                                    draggable
                                    onDragStart={() => {
                                        setDraggingGroupId(group.id);
                                        setReorderError(null);
                                    }}
                                    onDragOver={(e) => {
                                        e.preventDefault();
                                        if (dragOverGroupId !== group.id) setDragOverGroupId(group.id);
                                    }}
                                    onDrop={(e) => {
                                        e.preventDefault();
                                        handleGroupDrop(group.id);
                                    }}
                                    onDragEnd={() => {
                                        setDraggingGroupId(null);
                                        setDragOverGroupId(null);
                                    }}
                                >
                                    {/* Category header */}
                                    <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-100/60">
                                        <span
                                            className="text-gray-400 cursor-grab active:cursor-grabbing select-none"
                                            title="Drag to reorder category"
                                            aria-label="Drag to reorder category"
                                        >
                                            ⋮⋮
                                        </span>
                                        <button
                                            onClick={() => handleToggleGroup(group.id, !group.enabled)}
                                            className={`relative inline-flex h-4 w-7 items-center rounded-full transition shrink-0 ${group.enabled ? 'bg-emerald-500' : 'bg-gray-300'}`}
                                            title={group.enabled ? 'Disable category' : 'Enable category'}
                                        >
                                            <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition ${group.enabled ? 'translate-x-3' : 'translate-x-0.5'}`} />
                                        </button>
                                        <input
                                            type="color"
                                            value={groupColor}
                                            onChange={(e) => handleColorChange(group.id, e.target.value)}
                                            className="h-4 w-4 cursor-pointer border-0 p-0 shrink-0"
                                            title="Change category color"
                                        />
                                        {editingGroupId === group.id ? (
                                            <input
                                                type="text"
                                                value={editingGroupLabel}
                                                onChange={(e) => setEditingGroupLabel(e.target.value)}
                                                onBlur={() => handleGroupLabelSave(group.id)}
                                                onKeyDown={(e) => {
                                                    if (e.key === 'Enter') handleGroupLabelSave(group.id);
                                                    if (e.key === 'Escape') setEditingGroupId(null);
                                                }}
                                                autoFocus
                                                className="text-[11px] font-semibold text-gray-700 border border-blue-400 px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-500 flex-1 min-w-0 bg-white"
                                            />
                                        ) : (
                                            <span
                                                className="text-[11px] font-semibold text-gray-700 cursor-pointer hover:text-blue-600 transition truncate"
                                                onClick={() => handleGroupLabelEdit(group)}
                                            >
                                                {group.label}
                                            </span>
                                        )}
                                    </div>

                                    {/* Tags */}
                                    <div className="px-3 py-2">
                                        <div className="flex flex-wrap gap-1.5 items-center">
                                            {group.tags.map((tag) => (
                                                <span
                                                    key={tag.id}
                                                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium text-white ${!tag.enabled ? 'opacity-40 line-through' : ''}`}
                                                    style={{ backgroundColor: groupColor }}
                                                >
                                                    {tag.label}
                                                    <span
                                                        className="inline-flex items-center justify-center rounded-full bg-white/30 text-[9px] font-semibold min-w-[14px] h-[14px] px-0.5"
                                                    >
                                                        {tag.event_count}
                                                    </span>
                                                    <button
                                                        onClick={() => handleToggleHero(tag)}
                                                        className={`ml-0.5 hover:opacity-80 transition text-[10px] leading-none ${tag.is_hero_filter ? 'opacity-100' : 'opacity-40'}`}
                                                        title={tag.is_hero_filter ? 'Remove from hero filters' : 'Mark as hero filter'}
                                                        aria-label={tag.is_hero_filter ? 'Remove from hero filters' : 'Mark as hero filter'}
                                                    >
                                                        ★
                                                    </button>
                                                    <button
                                                        onClick={() => handleToggleTag(tag.id, !tag.enabled)}
                                                        className="ml-0.5 hover:opacity-80 transition text-[9px]"
                                                        title={tag.enabled ? 'Disable tag' : 'Enable tag'}
                                                    >
                                                        {tag.enabled ? '●' : '○'}
                                                    </button>
                                                </span>
                                            ))}

                                            {/* Add tag inline */}
                                            {newTagInputs[group.id] !== undefined ? (
                                                <div className="flex items-center gap-0.5">
                                                    <input
                                                        type="text"
                                                        value={newTagInputs[group.id] || ''}
                                                        onChange={(e) =>
                                                            setNewTagInputs((prev) => ({
                                                                ...prev,
                                                                [group.id]: e.target.value,
                                                            }))
                                                        }
                                                        onKeyDown={(e) => {
                                                            if (e.key === 'Enter') handleAddTag(group.id);
                                                            if (e.key === 'Escape')
                                                                setNewTagInputs((prev) => {
                                                                    const next = { ...prev };
                                                                    delete next[group.id];
                                                                    return next;
                                                                });
                                                        }}
                                                        autoFocus
                                                        placeholder="Tag name"
                                                        className="border border-gray-300 rounded-full px-2 py-0.5 text-[10px] text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 w-20 bg-white"
                                                    />
                                                    <button
                                                        onClick={() => handleAddTag(group.id)}
                                                        disabled={!(newTagInputs[group.id] || '').trim()}
                                                        className="text-[10px] text-blue-600 hover:text-blue-800 font-medium disabled:opacity-40"
                                                    >
                                                        ✓
                                                    </button>
                                                    <button
                                                        onClick={() =>
                                                            setNewTagInputs((prev) => {
                                                                const next = { ...prev };
                                                                delete next[group.id];
                                                                return next;
                                                            })
                                                        }
                                                        className="text-[10px] text-gray-400 hover:text-gray-600"
                                                    >
                                                        ✕
                                                    </button>
                                                </div>
                                            ) : (
                                                <button
                                                    onClick={() =>
                                                        setNewTagInputs((prev) => ({
                                                            ...prev,
                                                            [group.id]: '',
                                                        }))
                                                    }
                                                    className="inline-flex items-center justify-center rounded-full border border-dashed border-gray-300 text-gray-400 hover:border-gray-400 hover:text-gray-600 w-5 h-5 text-xs transition"
                                                    title="Add tag"
                                                >
                                                    +
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}
