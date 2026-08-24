import { useMemo } from 'react';
import type { TagGroup } from '../types';

// Get the PNG image path for a reach tag based on its label.
function reachIconSrcFor(tagLabel: string): string {
    const l = tagLabel.toLowerCase();
    if (l.includes('local')) return '/local-reach.png';
    if (l.includes('regional')) return '/regional-reach.png';
    return '/international-reach.png';
}

interface Props {
    tagGroups: TagGroup[];
    activeTagIds: Set<number>;
    onToggle: (tagId: number) => void;
    onClear: () => void;
    /**
     * Optional map of tagId -> residual count under the currently active filters
     * (disjunctive faceting). Overrides static `tag.event_count` for display
     * and renders zero-count pills as disabled.
     */
    countOverrides?: Map<number, number>;
    /**
     * Sort order for non-hero pills within each group's row:
     *  - "group" (default): respect admin tag ordinals
     *  - "event_count": sort by event_count descending
     * Hero pills are always rendered first within their group's row,
     * regardless of this setting.
     */
    sortMode?: 'group' | 'event_count';
    /**
     * Optional content rendered as the last row, after the last tag
     * group's row. Used by the explorer to surface a "save as default"
     * link.
     */
    trailingSlot?: React.ReactNode;
}

type EnrichedTag = TagGroup['tags'][number] & {
    _groupColor: string;
};

interface GroupRow {
    key: string;
    label: string;
    tags: EnrichedTag[];
}

function selectHeroes(tags: EnrichedTag[]): EnrichedTag[] {
    return tags
        .filter((t) => t.is_hero_filter)
        .sort((a, b) => {
            const ao = a.hero_ordinal ?? Infinity;
            const bo = b.hero_ordinal ?? Infinity;
            if (ao !== bo) return ao - bo;
            if (a.ordinal !== b.ordinal) return a.ordinal - b.ordinal;
            return a.label.localeCompare(b.label);
        });
}

function selectRemainder(
    tags: EnrichedTag[],
    heroTags: EnrichedTag[],
    sortMode: 'group' | 'event_count',
): EnrichedTag[] {
    const heroIds = new Set(heroTags.map((t) => t.id));
    const rest = tags.filter((t) => !heroIds.has(t.id));
    if (sortMode === 'event_count') {
        return [...rest].sort((a, b) => {
            const ac = a.event_count ?? 0;
            const bc = b.event_count ?? 0;
            if (ac !== bc) return bc - ac;
            return a.label.localeCompare(b.label);
        });
    }
    return [...rest].sort((a, b) => {
        if (a.ordinal !== b.ordinal) return a.ordinal - b.ordinal;
        return a.label.localeCompare(b.label);
    });
}

/**
 * Move pills with no remaining matches (residual count = 0 and not active)
 * to the end, preserving order otherwise.
 */
function partitionEnabledFirst(
    arr: EnrichedTag[],
    activeTagIds: Set<number>,
    countOverrides: Map<number, number> | undefined,
): EnrichedTag[] {
    const enabled: EnrichedTag[] = [];
    const disabled: EnrichedTag[] = [];
    for (const t of arr) {
        const isActive = activeTagIds.has(t.id);
        const c = countOverrides?.get(t.id) ?? t.event_count ?? null;
        const isDisabled = !isActive && c === 0;
        (isDisabled ? disabled : enabled).push(t);
    }
    return [...enabled, ...disabled];
}

// One row per tag group, sorted by group ordinal. Within a row, that
// group's hero tags come first (by hero_ordinal), then the rest per
// `sortMode`; zero-residual-count pills are pushed to the row's end.
function buildGroupRows(
    tagGroups: TagGroup[],
    sortMode: 'group' | 'event_count',
    activeTagIds: Set<number>,
    countOverrides: Map<number, number> | undefined,
): GroupRow[] {
    return tagGroups
        .filter((g) => g.enabled !== false)
        .slice()
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((g) => {
            const tags: EnrichedTag[] = g.tags
                .filter((t) => t.enabled !== false && (t.event_count == null || t.event_count > 0))
                .map((t) => ({ ...t, _groupColor: g.color ?? t.color ?? '#6b7280' }));
            const heroTags = selectHeroes(tags);
            const remainderTags = selectRemainder(tags, heroTags, sortMode);
            const ordered = [
                ...partitionEnabledFirst(heroTags, activeTagIds, countOverrides),
                ...partitionEnabledFirst(remainderTags, activeTagIds, countOverrides),
            ];
            return { key: g.slug, label: g.label, tags: ordered };
        })
        .filter((row) => row.tags.length > 0);
}

export default function TagFilterPills({
    tagGroups,
    activeTagIds,
    onToggle,
    onClear,
    countOverrides,
    sortMode = 'group',
    trailingSlot,
}: Props) {
    const groupRows = useMemo(
        () => buildGroupRows(tagGroups, sortMode, activeTagIds, countOverrides),
        [tagGroups, sortMode, activeTagIds, countOverrides],
    );

    if (!groupRows.length) return null;

    const showLabels = groupRows.length > 1;

    const renderPill = (tag: EnrichedTag, groupKey: string) => {
        const active = activeTagIds.has(tag.id);
        const displayCount = countOverrides?.get(tag.id) ?? tag.event_count ?? null;
        const disabled = !active && displayCount === 0;
        const isReachGroup = groupKey === 'reach';

        return (
            <button
                key={tag.id}
                onClick={() => { if (!disabled) onToggle(tag.id); }}
                disabled={disabled}
                aria-disabled={disabled}
                aria-pressed={active}
                // eslint-disable-next-line no-restricted-syntax -- pill-shaped tag chips match the provided filter-sheet design reference
                className={`relative flex w-full items-center justify-between rounded-full border-2 px-3 py-2 text-xs font-medium transition ${active ? 'border-blue-600 bg-blue-50 text-gray-900' : 'border-gray-300 bg-white text-gray-900 hover:bg-gray-50'
                    } ${disabled ? 'cursor-not-allowed opacity-40' : ''}`}
            >
                <span className="flex items-center gap-2 truncate flex-1">
                    {isReachGroup && (
                        <img
                            src={reachIconSrcFor(tag.label)}
                            alt={tag.label}
                            className="h-4 w-4 shrink-0"
                            aria-hidden="true"
                        />
                    )}
                    <span className="truncate text-center flex-1">{tag.label}</span>
                </span>
                {active && (
                    // eslint-disable-next-line no-restricted-syntax -- checkmark badge inside selected pill
                    <span className="ml-2 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-600">
                        <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4 text-white" aria-hidden="true">
                            <path fillRule="evenodd" d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0l-3.5-3.5a1 1 0 1 1 1.4-1.4l2.8 2.79 6.8-6.8a1 1 0 0 1 1.4 0Z" clipRule="evenodd" />
                        </svg>
                    </span>
                )}
            </button>
        );
    };

    return (
        <div className="flex flex-col gap-3">
            {groupRows.map((row) => (
                <div key={row.key} className="flex flex-col gap-2">
                    {showLabels && (
                        <span className="text-[11px] font-bold uppercase tracking-wide text-ink-soft">
                            {row.label}
                        </span>
                    )}
                    <div className="grid grid-cols-3 gap-2.5">
                        {row.tags.map((tag) => renderPill(tag, row.key))}
                    </div>
                </div>
            ))}
            {activeTagIds.size > 0 && (
                <div className="flex justify-end pt-2">
                    <button
                        onClick={onClear}
                        className="text-xs font-medium text-ink-soft hover:text-ink transition"
                        aria-label="Clear selection"
                    >
                        Clear selection
                    </button>
                </div>
            )}
            {trailingSlot}
        </div>
    );
}
