import type { TagGroup } from '../types';

interface Props {
    tagGroups: TagGroup[];
    activeTagIds: Set<number>;
    onToggle: (tagId: number) => void;
    onClear: () => void;
}

export default function TagFilterPills({ tagGroups, activeTagIds, onToggle, onClear }: Props) {
    const allTags = tagGroups
        .filter((g) => g.enabled !== false)
        .flatMap((g) =>
            g.tags
                .filter((t) => t.enabled !== false)
                .map((t) => ({ ...t, _groupColor: g.color ?? t.color ?? '#6b7280' })),
        );

    if (!allTags.length) return null;

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
            {allTags.map((tag) => {
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
        </div>
    );
}
