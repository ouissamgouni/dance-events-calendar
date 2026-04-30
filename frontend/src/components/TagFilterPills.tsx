import { useState } from 'react';
import type { TagGroup } from '../types';

const MAX_VISIBLE = 8;

interface Props {
    tagGroups: TagGroup[];
    activeTagIds: Set<number>;
    onToggle: (tagId: number) => void;
    onClear: () => void;
}

export default function TagFilterPills({ tagGroups, activeTagIds, onToggle, onClear }: Props) {
    const [expanded, setExpanded] = useState(false);

    const allTags = tagGroups
        .filter((g) => g.enabled !== false)
        .flatMap((g) =>
            g.tags
                .filter((t) => t.enabled !== false && (t.event_count == null || t.event_count > 0))
                .map((t) => ({
                    ...t,
                    _groupColor: g.color ?? t.color ?? '#6b7280',
                    _groupOrdinal: g.ordinal,
                })),
        )
        // Respect admin ordering: group ordinal, then tag ordinal, then label.
        .sort((a, b) => {
            if (a._groupOrdinal !== b._groupOrdinal) return a._groupOrdinal - b._groupOrdinal;
            if (a.ordinal !== b.ordinal) return a.ordinal - b.ordinal;
            return a.label.localeCompare(b.label);
        });

    // Hero tags: sorted by hero_ordinal (nulls last), then canonical fallback
    const heroTags = allTags
        .filter((t) => t.is_hero_filter)
        .sort((a, b) => {
            const ao = a.hero_ordinal ?? Infinity;
            const bo = b.hero_ordinal ?? Infinity;
            if (ao !== bo) return ao - bo;
            if (a._groupOrdinal !== b._groupOrdinal) return a._groupOrdinal - b._groupOrdinal;
            if (a.ordinal !== b.ordinal) return a.ordinal - b.ordinal;
            return a.label.localeCompare(b.label);
        });

    // Remainder: all non-hero tags, in canonical order
    const heroIds = new Set(heroTags.map((t) => t.id));
    const remainderTags = allTags.filter((t) => !heroIds.has(t.id));

    if (!allTags.length) return null;

    const hasMore = remainderTags.length > MAX_VISIBLE;
    // When collapsed, show the first MAX_VISIBLE remainder tags plus any active ones outside that window
    const visibleRemainder = expanded
        ? remainderTags
        : remainderTags.filter((t, i) => i < MAX_VISIBLE || activeTagIds.has(t.id));

    const renderPill = (tag: (typeof allTags)[number]) => {
        const active = activeTagIds.has(tag.id);
        const c = tag._groupColor;
        return (
            <button
                key={tag.id}
                onClick={() => onToggle(tag.id)}
                className={`inline-flex items-center gap-0.5 px-2 py-px text-[11px] font-medium transition-colors border ${active
                    ? 'text-white shadow-sm'
                    : 'text-gray-700'
                    }`}
                style={
                    active
                        ? { backgroundColor: c, borderColor: c }
                        : { backgroundColor: `${c}30`, borderColor: `${c}50` }
                }
            >
                {tag.label}
                {tag.event_count != null && (
                    <span
                        className={`text-[9px] font-semibold ${active ? 'opacity-80' : 'opacity-60'
                            }`}
                    >
                        {tag.event_count}
                    </span>
                )}
            </button>
        );
    };

    return (
        <div className="flex flex-col gap-1">
            {/* Hero row */}
            {heroTags.length > 0 && (
                <div className="flex flex-wrap gap-1 items-center">
                    {activeTagIds.size > 0 && heroTags.some((t) => activeTagIds.has(t.id)) && (
                        <button
                            onClick={onClear}
                            className="inline-flex h-5 w-5 items-center justify-center text-rose-500 hover:text-rose-700 font-semibold mr-1"
                            aria-label="Clear tag filters"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
                                <path fillRule="evenodd" d="M4.22 4.22a.75.75 0 0 1 1.06 0L10 8.94l4.72-4.72a.75.75 0 1 1 1.06 1.06L11.06 10l4.72 4.72a.75.75 0 1 1-1.06 1.06L10 11.06l-4.72 4.72a.75.75 0 0 1-1.06-1.06L8.94 10 4.22 5.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
                            </svg>
                        </button>
                    )}
                    {heroTags.map(renderPill)}
                </div>
            )}

            {/* Remainder row */}
            {remainderTags.length > 0 && (
                <div className="flex flex-wrap gap-1 items-center">
                    {heroTags.length === 0 && activeTagIds.size > 0 && (
                        <button
                            onClick={onClear}
                            className="inline-flex h-5 w-5 items-center justify-center text-rose-500 hover:text-rose-700 font-semibold mr-1"
                            aria-label="Clear tag filters"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
                                <path fillRule="evenodd" d="M4.22 4.22a.75.75 0 0 1 1.06 0L10 8.94l4.72-4.72a.75.75 0 1 1 1.06 1.06L11.06 10l4.72 4.72a.75.75 0 1 1-1.06 1.06L10 11.06l-4.72 4.72a.75.75 0 0 1-1.06-1.06L8.94 10 4.22 5.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
                            </svg>
                        </button>
                    )}
                    {visibleRemainder.map(renderPill)}
                    {hasMore && (
                        <button
                            onClick={() => setExpanded((v) => !v)}
                            className="inline-flex items-center justify-center h-5 w-5 rounded-full border border-gray-300 text-gray-400 hover:border-gray-400 hover:text-gray-600 transition"
                            aria-label={expanded ? 'Show fewer tags' : 'Show more tags'}
                            title={expanded ? 'Show fewer' : `Show ${remainderTags.length - MAX_VISIBLE} more`}
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3 w-3">
                                {expanded
                                    ? <path fillRule="evenodd" d="M9.47 6.47a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 1 1-1.06 1.06L10 8.06l-3.72 3.72a.75.75 0 0 1-1.06-1.06l4.25-4.25Z" clipRule="evenodd" />
                                    : <path fillRule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
                                }
                            </svg>
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}
