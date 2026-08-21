import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { CalendarEvent } from '../types';
import { formatCountdown } from '../utils/relativeDate';
import RailEventCard from './RailEventCard';
import ScrollDotsIndicator from './ScrollDots';
import { useScrollDots } from '../hooks/useScrollDots';

interface YourNextEventsRailProps {
    /** Union of the viewer's saved + going events, sorted by start date ascending. */
    events: CalendarEvent[];
    onEventClick: (event: CalendarEvent) => void;
    hoveredEventId?: string | null;
    onEventHover?: (eventId: string | null) => void;
    /** Unseen tracking — cards for events in this set get the blue-dot
     * "New" indicator, matching EventListPanel. */
    newEventIds?: Set<string>;
    unseenStateEnabled?: boolean;
    className?: string;
    /** When provided, the rail renders this message instead of returning null
     * when there are no events — keeps the trail visible with a CTA. */
    emptyState?: ReactNode;
}

const DISPLAY_CAP = 5;

export default function YourNextEventsRail({
    events,
    onEventClick,
    hoveredEventId,
    onEventHover,
    newEventIds,
    unseenStateEnabled = false,
    className = '',
    emptyState,
}: YourNextEventsRailProps) {
    // Rails are expanded by default on both mobile and desktop; the
    // header caret still lets the viewer collapse them per session.
    const [collapsed, setCollapsed] = useState(false);
    const [isMobile, setIsMobile] = useState(() => (typeof window !== 'undefined' ? window.innerWidth < 640 : false));
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const mq = window.matchMedia('(max-width: 639px)');
        const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
        mq.addEventListener('change', handler);
        return () => mq.removeEventListener('change', handler);
    }, []);

    const scrollerRef = useRef<HTMLDivElement>(null);
    const { dotCount, activeIndex, scrollToIndex } = useScrollDots(scrollerRef, [collapsed, events.length]);

    if (events.length === 0 && !emptyState) return null;
    const isEmpty = events.length === 0;

    const visibleEvents = events.slice(0, DISPLAY_CAP);

    return (
        <section className={className} data-testid="your-next-events-rail">
            <div className="flex w-full items-center justify-between border-b border-line px-2.5 py-1 text-base font-semibold text-ink">
                <button
                    type="button"
                    className="flex flex-1 items-center justify-between gap-2 text-left hover:text-ink focus:outline-none focus:ring-2 focus:ring-blue-300"
                    aria-expanded={!collapsed}
                    aria-label={collapsed ? 'Expand Your next events' : 'Collapse Your next events'}
                    onClick={() => setCollapsed((value) => !value)}
                >
                    <span className="inline-flex items-center gap-1">
                        Your next events
                    </span>
                    <span aria-hidden="true" className="text-xs text-muted">{collapsed ? '+' : '-'}</span>
                </button>
                {events.length > 0 && (
                    <Link
                        to="/mine/calendar"
                        className="ml-2 shrink-0 text-[11px] font-semibold text-action hover:text-action"
                    >
                        {events.length} upcoming
                    </Link>
                )}
            </div>
            {!collapsed && (
                isEmpty ? (
                    <div className="px-3 py-6 text-center text-xs text-ink-soft" data-testid="your-next-events-empty">
                        {emptyState}
                    </div>
                ) : (
                    <div ref={scrollerRef} className="flex gap-2 overflow-x-auto scrollbar-hide px-2 py-2" aria-label="Your next events">
                        {visibleEvents.map((event) => {
                            const countdown = formatCountdown(event.start, new Date(), isMobile);
                            const isNew = !!unseenStateEnabled && !!newEventIds?.has(event.event_id);
                            return (
                                <RailEventCard
                                    key={event.event_id}
                                    event={event}
                                    onClick={onEventClick}
                                    onHover={onEventHover}
                                    highlighted={hoveredEventId === event.event_id}
                                    isNew={isNew}
                                    contextLabel="your event"
                                    extraBadge={countdown ? (
                                        <span
                                            className="inline-flex shrink-0 items-center bg-blue-100 px-1.5 py-px text-[10px] font-semibold text-action"
                                            data-testid="your-next-events-countdown"
                                        >
                                            {countdown}
                                        </span>
                                    ) : undefined}
                                />
                            );
                        })}
                        {events.length > DISPLAY_CAP && (
                            <Link
                                to="/mine/calendar"
                                className="flex min-h-[72px] w-[110px] shrink-0 items-center justify-center bg-canvas text-center text-[11px] font-semibold text-action transition hover:bg-canvas hover:text-action focus:outline-none focus:ring-2 focus:ring-blue-300"
                                data-testid="your-next-events-see-more"
                            >
                                See more →
                            </Link>
                        )}
                    </div>
                )
            )}
            {!collapsed && !isEmpty && (
                <ScrollDotsIndicator
                    count={dotCount}
                    activeIndex={activeIndex}
                    onSelect={scrollToIndex}
                    label="Your next events scroll position"
                />
            )}
        </section>
    );
}
