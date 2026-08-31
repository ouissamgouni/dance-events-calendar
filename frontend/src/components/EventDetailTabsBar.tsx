import { useRef } from 'react';
import type { EventDetailTab } from './EventSummary';
import { useScrollDots } from '../hooks/useScrollDots';
import ScrollDotsIndicator from './ScrollDots';

interface TabDef {
    id: EventDetailTab;
    label: string;
}

const TABS: TabDef[] = [
    { id: 'about', label: 'Details' },
    { id: 'location', label: 'Location' },
    { id: 'people', label: 'People' },
    { id: 'reviews', label: 'Reviews' },
    { id: 'discussion', label: 'Discussion' },
];

interface Props {
    active: EventDetailTab;
    onSelect: (tab: EventDetailTab) => void;
    /** `entry` = overview entry-point bar (thin separators, not sticky);
     * `section` = the bar shown under the section header. */
    variant?: 'entry' | 'section';
}

/**
 * Horizontally-scrollable detail-tab bar. Never shrinks all five labels to fit
 * narrow viewports — it scrolls, with a dot indicator communicating hidden
 * tabs. Stickiness is owned by the caller so it can pin the section header and
 * tabs together.
 */
export default function EventDetailTabsBar({ active, onSelect, variant = 'section' }: Props) {
    const scrollerRef = useRef<HTMLDivElement>(null);
    const { dotCount, activeIndex, scrollToIndex } = useScrollDots(scrollerRef, [active]);

    return (
        <div className={`bg-surface ${variant === 'entry' ? 'border-y border-line' : 'border-b border-line'}`}>
            <div
                ref={scrollerRef}
                role="tablist"
                aria-label="Event details"
                className="flex flex-nowrap gap-1 overflow-x-auto px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
                {TABS.map((tab) => {
                    const isActive = tab.id === active;
                    return (
                        <button
                            key={tab.id}
                            type="button"
                            role="tab"
                            aria-selected={isActive}
                            onClick={() => onSelect(tab.id)}
                            className={`relative shrink-0 px-4 py-3 text-sm font-medium transition ${isActive ? 'text-action' : 'text-ink-soft hover:text-ink'}`}
                        >
                            {tab.label}
                            {isActive && (
                                <span className="absolute inset-x-3 bottom-0 h-0.5 bg-action" aria-hidden="true" />
                            )}
                        </button>
                    );
                })}
            </div>
            <ScrollDotsIndicator count={dotCount} activeIndex={activeIndex} onSelect={scrollToIndex} className="pb-1" />
        </div>
    );
}
