import { useLayoutEffect, useRef, useState } from 'react';
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
    /** Force calm grey chips regardless of the colored flag/prop — used on the
     * event page/modal where taxonomy colour is intentionally suppressed. */
    neutral?: boolean;
    /** Chip scale. `sm` renders the larger event-page chips (~11px, rounded). */
    size?: 'xs' | 'sm';
    /** Keep badges on a single line, clipping overflow (paired with a low
     * `maxVisible` + "+x" so the row never wraps). */
    singleLine?: boolean;
    /** Group slugs whose tags sort to the front before the visible slice. */
    priorityGroups?: string[];
    /** Measure available width and render exactly as many chips as fit on one
     * line, with a trailing "+x" chip for the remainder. Overrides `maxVisible`. */
    fitWidth?: boolean;
    /** When set, the "+x" overflow chip renders as a button invoking this
     * (e.g. to open the full tag list). */
    onOverflowClick?: () => void;
}

export default function TagBadges({ tags, maxVisible = 5, forceBadge = false, forceColored = false, neutral = false, size = 'xs', singleLine = false, priorityGroups, fitWidth = false, onOverflowClick }: Props) {
    const { tagAsBadge, tagBadgeColored } = useFeatureFlags();
    const containerRef = useRef<HTMLDivElement>(null);
    const widthsRef = useRef<number[]>([]);
    const overflowWRef = useRef<number>(36);
    const measuredSigRef = useRef<string>('');
    const filtered = tags.filter((tag) => tag.enabled);
    const enabledTags = priorityGroups && priorityGroups.length > 0
        ? [...filtered].sort((a, b) => {
            const ra = priorityGroups.indexOf(a.group_slug);
            const rb = priorityGroups.indexOf(b.group_slug);
            return (ra === -1 ? Number.MAX_SAFE_INTEGER : ra) - (rb === -1 ? Number.MAX_SAFE_INTEGER : rb);
        })
        : filtered;
    const sig = enabledTags.map((t) => t.id).join(',');
    const [visibleCount, setVisibleCount] = useState<number>(enabledTags.length);

    // Single-line width fit: cache each chip's intrinsic width once per tag set
    // (measured while all chips are mounted), then pick how many fit the
    // container — reserving room for the trailing "+x" chip — on every resize.
    useLayoutEffect(() => {
        if (!fitWidth) return;
        const el = containerRef.current;
        if (!el) return;

        const recompute = () => {
            const avail = el.clientWidth;
            const widths = widthsRef.current;
            if (!avail || widths.length === 0) return;
            const gap = 4;
            let used = 0;
            let k = 0;
            for (let i = 0; i < widths.length; i++) {
                const next = used + (i === 0 ? 0 : gap) + widths[i];
                const reserve = i < widths.length - 1 ? gap + overflowWRef.current : 0;
                if (next + reserve <= avail) { used = next; k = i + 1; }
                else break;
            }
            setVisibleCount(Math.max(k, 1));
        };

        // Chip widths are only trustworthy when every chip is currently mounted.
        if (measuredSigRef.current !== sig) {
            const chips = Array.from(el.querySelectorAll<HTMLElement>('[data-chip]'));
            if (chips.length < enabledTags.length) {
                setVisibleCount(enabledTags.length);
                return;
            }
            widthsRef.current = chips.map((c) => c.offsetWidth);
            const of = el.querySelector<HTMLElement>('[data-overflow]');
            if (of) overflowWRef.current = of.offsetWidth;
            measuredSigRef.current = sig;
        }

        recompute();
        const ro = new ResizeObserver(recompute);
        ro.observe(el);
        return () => ro.disconnect();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [fitWidth, sig, visibleCount]);

    if (!filtered.length) return null;

    const effectiveVisible = fitWidth ? visibleCount : maxVisible;
    const visible = enabledTags.slice(0, effectiveVisible);
    const overflow = enabledTags.length - visible.length;

    // Default (flag off): quiet, comma-separated text. Cards stay calm
    // and rely on typography + whitespace rather than colored chips.
    if (!forceBadge && !tagAsBadge) {
        const overflowLabel = overflow > 0 ? ` +${overflow}` : '';
        const title = enabledTags.map((t) => t.label).join(' \u00b7 ');
        return (
            <p className="truncate text-[10px] text-ink-soft" title={title}>
                {visible.map((t, i) => (
                    <span key={t.id}>
                        {i > 0 && ' \u00b7 '}
                        {t.label}
                    </span>
                ))}
                {overflowLabel}
            </p>
        );
    }

    // Badge mode. Colored variant is opt-in via `tagBadgeColored` flag
    // or explicit `forceColored` prop; otherwise render calm grey chips.
    const useColor = !neutral && (forceColored || tagBadgeColored);
    const chip = size === 'sm' ? 'px-2 py-0.5 text-[11px] rounded-md' : 'px-1.5 py-px text-[9px] leading-3';

    const chipNode = (tag: Tag) => {
        if (useColor) {
            const c = tag.group_color ?? tag.color ?? '#6b7280';
            return (
                <span
                    key={tag.id}
                    data-chip
                    className={`inline-flex items-center font-medium ${chip}`}
                    style={{ backgroundColor: `${c}20`, color: c, border: `1px solid ${c}40` }}
                    title={`${tag.group_label}: ${tag.label}`}
                >
                    {tag.label}
                </span>
            );
        }
        return (
            <span
                key={tag.id}
                data-chip
                className={`inline-flex items-center bg-slate-100 font-medium text-ink-soft ${chip}`}
                title={`${tag.group_label}: ${tag.label}`}
            >
                {tag.label}
            </span>
        );
    };

    const overflowNode = (count: number) => {
        const cls = `inline-flex items-center font-medium text-muted ${chip}`;
        if (onOverflowClick) {
            return (
                <button
                    type="button"
                    data-overflow
                    onClick={onOverflowClick}
                    className={`${cls} transition hover:text-ink`}
                    aria-label={`Show ${count} more tags`}
                >
                    +{count}
                </button>
            );
        }
        return <span data-overflow className={cls}>+{count}</span>;
    };

    return (
        <div
            ref={containerRef}
            className={singleLine || fitWidth ? 'flex flex-nowrap gap-1 overflow-hidden' : 'flex flex-wrap gap-1'}
        >
            {visible.map((tag) => chipNode(tag))}
            {overflow > 0 && overflowNode(overflow)}
        </div>
    );
}
