import { useMemo, useState } from 'react';
import type { TagGroup } from '../types';

export interface TagsPickerValue {
    selectedTagIds: number[];
    freeTexts: Record<string, string>; // group_slug -> text
}

interface Props {
    tagGroups: TagGroup[];
    value: TagsPickerValue;
    onChange: (next: TagsPickerValue) => void;
    /** Tags to hide (e.g. already on the event). */
    excludeTagIds?: Set<number>;
    /** Show the search input. Default true. */
    searchable?: boolean;
    /** Allow user-entered free-text tag suggestions. Default true. */
    allowFreeText?: boolean;
    /** Container className override. */
    className?: string;
}

/**
 * Reusable tag-suggestion picker.
 *
 * Supports:
 *  - Selecting existing tags (multi-select, multi-group)
 *  - Free-text "suggest new tag" entry per group
 *  - Cross-group search box
 *
 * Shared by event-tag suggestions (per-event) and the public event submission
 * form so the UX stays consistent across the app.
 */
export default function TagsPicker({
    tagGroups,
    value,
    onChange,
    excludeTagIds,
    searchable = true,
    allowFreeText = true,
    className,
}: Props) {
    const [activeGroupSlug, setActiveGroupSlug] = useState<string | 'all'>('all');
    const [search, setSearch] = useState('');

    const enabledGroups = useMemo(
        () => tagGroups.filter((g) => g.enabled !== false),
        [tagGroups],
    );
    const [newTagGroupSlug, setNewTagGroupSlug] = useState<string>(
        () => enabledGroups[0]?.slug ?? '',
    );
    const [newTagText, setNewTagText] = useState('');

    const selectedSet = useMemo(() => new Set(value.selectedTagIds), [value.selectedTagIds]);

    const visibleGroups = useMemo(() => {
        const term = search.trim().toLowerCase();
        return enabledGroups
            .map((g) => ({
                ...g,
                tags: (g.tags ?? [])
                    .filter((t) => t.enabled !== false)
                    .filter((t) => !excludeTagIds || !excludeTagIds.has(t.id))
                    .filter((t) => !term || t.label.toLowerCase().includes(term)),
            }))
            .filter((g) =>
                activeGroupSlug === 'all' || g.slug === activeGroupSlug,
            );
    }, [enabledGroups, search, excludeTagIds, activeGroupSlug]);

    const toggleTag = (tagId: number) => {
        const set = new Set(value.selectedTagIds);
        if (set.has(tagId)) set.delete(tagId);
        else set.add(tagId);
        onChange({ ...value, selectedTagIds: Array.from(set) });
    };

    const setFreeText = (slug: string, text: string) => {
        const next = { ...value.freeTexts };
        if (text.trim()) next[slug] = text;
        else delete next[slug];
        onChange({ ...value, freeTexts: next });
    };

    const addNewTag = () => {
        const trimmed = newTagText.trim();
        if (!trimmed || !newTagGroupSlug) return;
        setFreeText(newTagGroupSlug, trimmed);
        setNewTagText('');
    };

    const newTagEntries = useMemo(() => {
        return Object.entries(value.freeTexts)
            .filter(([, v]) => v.trim().length > 0)
            .map(([slug, text]) => {
                const group = enabledGroups.find((g) => g.slug === slug);
                return {
                    slug,
                    text,
                    label: group?.label ?? slug,
                    color: group?.color ?? '#6b7280',
                };
            });
    }, [value.freeTexts, enabledGroups]);

    const totalTagsAcrossGroups = visibleGroups.reduce((n, g) => n + g.tags.length, 0);

    return (
        <div className={className ?? 'space-y-2'}>
            {/* Search */}
            {searchable && (
                <input
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search tags…"
                    className="w-full border border-slate-300 px-2 py-1 text-xs placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
            )}

            {/* Group filter chips */}
            {tagGroups.length > 1 && (
                <div className="flex flex-wrap gap-1">
                    <button
                        type="button"
                        onClick={() => setActiveGroupSlug('all')}
                        className={`px-2 py-0.5 text-[11px] font-medium border transition-colors ${activeGroupSlug === 'all'
                            ? 'bg-slate-700 text-white border-slate-700'
                            : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                            }`}
                    >
                        All
                    </button>
                    {tagGroups.filter((g) => g.enabled !== false).map((group) => {
                        const c = group.color ?? '#6b7280';
                        const active = activeGroupSlug === group.slug;
                        return (
                            <button
                                key={group.slug}
                                type="button"
                                onClick={() => setActiveGroupSlug(group.slug)}
                                className="px-2 py-0.5 text-[11px] font-medium border transition-colors"
                                style={
                                    active
                                        ? { backgroundColor: c, borderColor: c, color: 'white' }
                                        : { borderColor: `${c}50`, color: c, backgroundColor: `${c}10` }
                                }
                            >
                                {group.label}
                            </button>
                        );
                    })}
                </div>
            )}

            {/* Tags grouped */}
            <div className="space-y-2">
                {visibleGroups.map((group) => {
                    const c = group.color ?? '#6b7280';
                    const fullGroupTags = (tagGroups.find((g) => g.slug === group.slug)?.tags ?? [])
                        .filter((t) => t.enabled !== false);
                    const searching = !!search.trim();
                    const noResults = group.tags.length === 0 && searching && fullGroupTags.length > 0;
                    const allFiltered = fullGroupTags.length === 0
                        || (excludeTagIds && fullGroupTags.every((t) => excludeTagIds.has(t.id)));

                    // While searching, hide groups that have no matching
                    // tags so the user only sees relevant rows.
                    if (searching && noResults) return null;

                    return (
                        <div key={group.slug}>
                            <p className="text-[10px] font-medium uppercase tracking-wide mb-1" style={{ color: c }}>
                                {group.label}
                            </p>
                            {allFiltered ? (
                                <p className="text-[11px] text-slate-400 italic">No tags available.</p>
                            ) : (
                                <div className="flex flex-wrap gap-1">
                                    {group.tags.map((tag) => {
                                        const tc = tag.group_color ?? tag.color ?? c;
                                        const selected = selectedSet.has(tag.id);
                                        return (
                                            <button
                                                key={tag.id}
                                                type="button"
                                                onClick={() => toggleTag(tag.id)}
                                                className="px-2 py-0.5 text-[11px] border transition-colors"
                                                style={
                                                    selected
                                                        ? { backgroundColor: tc, borderColor: tc, color: 'white' }
                                                        : { borderColor: `${tc}60`, color: tc, backgroundColor: 'white' }
                                                }
                                            >
                                                {selected && '✓ '}{tag.label}
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    );
                })}

                {totalTagsAcrossGroups === 0 && search.trim() && (
                    <p className="text-[11px] text-slate-400 italic">No tags match "{search}".</p>
                )}
            </div>

            {/* Single "Suggest new" section: category selector + text box */}
            {allowFreeText && enabledGroups.length > 0 && (
                <div className="border-t border-slate-200 pt-2 mt-2 space-y-1.5">
                    <p className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
                        Suggest new tag
                    </p>
                    <div className="flex gap-1.5">
                        <select
                            value={newTagGroupSlug}
                            onChange={(e) => setNewTagGroupSlug(e.target.value)}
                            className="border border-slate-300 px-1.5 py-1 text-[11px] focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 shrink-0 max-w-[40%]"
                        >
                            {enabledGroups.map((g) => (
                                <option key={g.slug} value={g.slug}>{g.label}</option>
                            ))}
                        </select>
                        <input
                            type="text"
                            value={newTagText}
                            onChange={(e) => setNewTagText(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    e.preventDefault();
                                    addNewTag();
                                }
                            }}
                            placeholder="New tag…"
                            maxLength={100}
                            className="flex-1 min-w-0 border border-slate-300 px-2 py-1 text-[11px] placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                        />
                        <button
                            type="button"
                            onClick={addNewTag}
                            disabled={!newTagText.trim() || !newTagGroupSlug}
                            className="bg-blue-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-blue-700 disabled:opacity-50 shrink-0"
                        >
                            Add
                        </button>
                    </div>

                    {newTagEntries.length > 0 && (
                        <div className="flex flex-wrap gap-1 pt-1">
                            {newTagEntries.map((entry) => (
                                <span
                                    key={entry.slug}
                                    className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] border"
                                    style={{ borderColor: `${entry.color}60`, color: entry.color, backgroundColor: 'white' }}
                                >
                                    <span className="opacity-70">{entry.label}:</span>
                                    <span>{entry.text}</span>
                                    <button
                                        type="button"
                                        onClick={() => setFreeText(entry.slug, '')}
                                        className="text-slate-400 hover:text-slate-700"
                                        aria-label={`Remove ${entry.text}`}
                                    >
                                        ✕
                                    </button>
                                </span>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
