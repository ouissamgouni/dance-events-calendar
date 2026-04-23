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
                .filter((t) => t.enabled !== false)
                .map((t) => ({ ...t, _groupColor: g.color ?? t.color ?? '#6b7280' })),
        )
        // Sort descending by event_count; stable tie-break: ordinal then label
        .sort((a, b) => {
            const diff = (b.event_count ?? 0) - (a.event_count ?? 0);
            if (diff !== 0) return diff;
            if (a.ordinal !== b.ordinal) return a.ordinal - b.ordinal;
            return a.label.localeCompare(b.label);
        });

    if (!allTags.length) return null;

    const hasMore = allTags.length > MAX_VISIBLE;
    // When collapsed, always show the first MAX_VISIBLE plus any active ones outside that window
    const visibleTags = expanded
        ? allTags
        : allTags.filter((t, i) => i < MAX_VISIBLE || activeTagIds.has(t.id));

    return (
        <div className="flex flex-wrap gap-1 items-center">
            {activeTagIds.size > 0 && (
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
            {visibleTags.map((tag) => {
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
            })}
            {hasMore && (
                <button
                    onClick={() => setExpanded((v) => !v)}
                    className="inline-flex items-center justify-center h-5 w-5 rounded-full border border-gray-300 text-gray-400 hover:border-gray-400 hover:text-gray-600 transition"
                    aria-label={expanded ? 'Show fewer tags' : 'Show more tags'}
                    title={expanded ? 'Show fewer' : `Show ${allTags.length - MAX_VISIBLE} more`}
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
    );
}
