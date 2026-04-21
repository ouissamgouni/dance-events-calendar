import type { Tag } from '../types';

interface Props {
    tags: Tag[];
    maxVisible?: number;
}

export default function TagBadges({ tags, maxVisible = 5 }: Props) {
    if (!tags.length) return null;

    const visible = tags.slice(0, maxVisible);
    const overflow = tags.length - maxVisible;

    return (
        <div className="flex flex-wrap gap-1">
            {visible.map((tag) => {
                const c = tag.group_color ?? tag.color ?? '#6b7280';
                return (
                    <span
                        key={tag.id}
                        className="inline-flex items-center rounded-sm px-2 py-0.5 text-[10px] font-medium"
                        style={{
                            backgroundColor: `${c}20`,
                            color: c,
                            border: `1px solid ${c}40`,
                        }}
                        title={`${tag.group_label}: ${tag.label}`}
                    >
                        {tag.label}
                    </span>
                );
            })}
            {overflow > 0 && (
                <span className="inline-flex items-center rounded-sm px-2 py-0.5 text-[10px] font-medium text-gray-400">
                    +{overflow}
                </span>
            )}
        </div>
    );
}
