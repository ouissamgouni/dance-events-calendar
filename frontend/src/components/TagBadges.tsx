import type { Tag } from '../types';
import { useFeatureFlags } from '../context/FeatureFlagsContext';

interface Props {
    tags: Tag[];
    maxVisible?: number;
    /** Force badge rendering even when the `tagAsBadge` flag is off. */
    forceBadge?: boolean;
    /** Force the colored variant even when the `tagBadgeColored` flag is
     * off. Ignored in plain-text mode. */
    forceColored?: boolean;
}

export default function TagBadges({ tags, maxVisible = 5, forceBadge = false, forceColored = false }: Props) {
    const { tagAsBadge, tagBadgeColored } = useFeatureFlags();
    const enabledTags = tags.filter((tag) => tag.enabled);
    if (!enabledTags.length) return null;

    const visible = enabledTags.slice(0, maxVisible);
    const overflow = enabledTags.length - maxVisible;

    // Default (flag off): quiet, comma-separated text. Cards stay calm
    // and rely on typography + whitespace rather than colored chips.
    if (!forceBadge && !tagAsBadge) {
        const overflowLabel = overflow > 0 ? ` +${overflow}` : '';
        const title = enabledTags.map((t) => t.label).join(' \u00b7 ');
        return (
            <p className="truncate text-[10px] text-slate-500" title={title}>
                {visible.map((t) => t.label).join(' \u00b7 ')}
                {overflowLabel}
            </p>
        );
    }

    // Badge mode. Colored variant is opt-in via `tagBadgeColored` flag
    // or explicit `forceColored` prop; otherwise render calm grey chips.
    const useColor = forceColored || tagBadgeColored;
    return (
        <div className="flex flex-wrap gap-1">
            {visible.map((tag) => {
                if (useColor) {
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
                }
                return (
                    <span
                        key={tag.id}
                        className="inline-flex items-center bg-slate-100 px-1.5 py-px text-[9px] font-medium leading-3 text-slate-600"
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
