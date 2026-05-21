import type { Tag } from '../types';

interface Props {
    tags: Tag[];
    maxVisible?: number;
}

export default function TagBadges({ tags, maxVisible = 5 }: Props) {
    const enabledTags = tags.filter((tag) => tag.enabled);
    if (!enabledTags.length) return null;

    const visible = enabledTags.slice(0, maxVisible);
    const overflow = enabledTags.length - maxVisible;

    return (
        <div className="flex flex-wrap gap-1">
            {visible.map((tag) => {
                const c = tag.group_color ?? tag.color ?? '#6b7280';
                return (
                    <span
                        key={tag.id}
                        className="inline-flex items-center px-1.5 py-px text-[9px] font-medium leading-3"
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
                <span className="inline-flex items-center px-1.5 py-px text-[9px] font-medium leading-3 text-gray-400">
                    +{overflow}
                </span>
            )}
        </div>
    );
}
