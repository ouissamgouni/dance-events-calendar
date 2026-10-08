import { useEffect, useRef } from 'react';
import type { EventDetailTab } from './EventSummary';

interface TabDef {
    id: EventDetailTab;
    label: string;
}

const TABS: TabDef[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'program', label: 'Program' },
    { id: 'about', label: 'Details' },
    { id: 'location', label: 'Location' },
    { id: 'people', label: 'People' },
    { id: 'reviews', label: 'Reviews' },
    { id: 'discussion', label: 'Discussion' },
    { id: 'memories', label: 'Memories' },
];

interface Props {
    active: EventDetailTab;
    onSelect: (tab: EventDetailTab) => void;
    /** `entry` = overview entry-point bar (thin separators, not sticky);
     * `section` = the bar shown under the section header. */
    variant?: 'entry' | 'section';
    showProgram?: boolean;
    showMemories?: boolean;
    /** Past events surface Reviews and Memories right after Overview. */
    isPast?: boolean;
}

const PAST_PRIORITY: EventDetailTab[] = ['overview', 'reviews', 'memories'];

/**
 * Horizontally-scrollable detail-tab bar. Never shrinks all five labels to fit
 * narrow viewports — it scrolls, with a dot indicator communicating hidden
 * tabs. Stickiness is owned by the caller so it can pin the section header and
 * tabs together.
 */
export default function EventDetailTabsBar({ active, onSelect, variant = 'section', showProgram = false, showMemories = false, isPast = false }: Props) {
    const listRef = useRef<HTMLDivElement>(null);
    const rank = (tab: TabDef) => {
        const i = PAST_PRIORITY.indexOf(tab.id);
        return i === -1 ? PAST_PRIORITY.length : i;
    };
    const tabs = isPast ? [...TABS].sort((a, b) => rank(a) - rank(b)) : TABS;

    // Keep the active tab visible in the horizontal scroller (e.g. Discussion opened from a link).
    useEffect(() => {
        const list = listRef.current;
        const btn = list?.querySelector<HTMLElement>('[aria-selected="true"]');
        if (!list || !btn) return;
        const left = btn.getBoundingClientRect().left - list.getBoundingClientRect().left + list.scrollLeft;
        const right = left + btn.offsetWidth;
        if (left < list.scrollLeft) list.scrollTo({ left });
        else if (right > list.scrollLeft + list.clientWidth) list.scrollTo({ left: right - list.clientWidth });
    }, [active, showProgram, showMemories, isPast]);

    return (
        <div className={`bg-surface ${variant === 'entry' ? 'border-y border-line' : 'border-b border-line'}`}>
            <div
                ref={listRef}
                role="tablist"
                aria-label="Event details"
                className="flex flex-nowrap gap-1 overflow-x-auto px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
                {tabs.filter((tab) => (tab.id !== 'program' || showProgram) && (tab.id !== 'memories' || showMemories)).map((tab) => {
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
        </div>
    );
}
