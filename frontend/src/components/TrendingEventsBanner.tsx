import { useMemo, useRef, useState } from 'react';
import type { CalendarEvent } from '../types';
import EventCard from './EventCard';
import ScrollDotsIndicator from './ScrollDots';
import { useScrollDots } from '../hooks/useScrollDots';

interface TrendingEventsBannerProps {
    events: CalendarEvent[];
    onEventClick: (event: CalendarEvent) => void;
    showPopularity: boolean;
    popularityThreshold: number;
    trendingTopN: number;
    trendingTopPercent: number;
    hoveredEventId?: string | null;
    onEventHover?: (eventId: string | null) => void;
    followingBadgeEnabled?: boolean;
    className?: string;
}


export default function TrendingEventsBanner({
    events,
    onEventClick,
    showPopularity,
    popularityThreshold,
    trendingTopN,
    trendingTopPercent,
    hoveredEventId,
    onEventHover,
    followingBadgeEnabled = false,
    className = '',
}: TrendingEventsBannerProps) {
    const [collapsed, setCollapsed] = useState(false);
    const scrollerRef = useRef<HTMLDivElement>(null);
    const trendingEvents = useMemo(() => {
        if (!showPopularity || events.length === 0) return [];
        const candidates = events
            .filter((event) => (event.popularity_score ?? 0) >= popularityThreshold)
            .sort((a, b) => (b.popularity_score ?? 0) - (a.popularity_score ?? 0));
        if (candidates.length === 0) return [];
        const effectiveCap = Math.max(
            1,
            Math.min(trendingTopN, Math.ceil((candidates.length * trendingTopPercent) / 100)),
        );
        if (effectiveCap < 1) return [];
        return candidates.slice(0, effectiveCap);
    }, [events, popularityThreshold, showPopularity, trendingTopN, trendingTopPercent]);

    const { dotCount, activeIndex, scrollToIndex } = useScrollDots(scrollerRef, [collapsed, trendingEvents.length]);

    if (trendingEvents.length === 0) return null;

    return (
        <section className={className} data-testid="trending-events-banner">
            <button
                type="button"
                className="flex w-full items-center justify-between border-b border-line px-2.5 py-1 text-left text-sm font-semibold text-ink hover:text-ink focus:outline-none focus:ring-2 focus:ring-blue-300"
                aria-expanded={!collapsed}
                onClick={() => setCollapsed((value) => !value)}
            >
                <span className="inline-flex items-center gap-1 text-ink">
                    <img src="/trending-0.png" alt="" aria-hidden="true" className="w-4 h-4 object-contain" />
                    Trending <span className="text-[10px] font-normal text-muted">for this search</span>
                </span>
                <span aria-hidden="true" className="text-xs text-muted">{collapsed ? '+' : '-'}</span>
            </button>
            {!collapsed && (
                <div ref={scrollerRef} className="flex gap-2 overflow-x-auto scrollbar-hide px-2 py-2" aria-label="Trending events">
                    {trendingEvents.map((event) => (
                        <EventCard
                            key={event.event_id}
                            event={event}
                            onOpen={onEventClick}
                            onHover={onEventHover}
                            highlighted={hoveredEventId === event.event_id}
                            followingBadgeEnabled={followingBadgeEnabled}
                            showReviews={false}
                            showTags={false}
                            showActions={false}
                            widthClass="w-[300px]"
                            dateHeaderRow
                            twoLineTitle
                            goingIconVariant="hand"
                        />
                    ))}
                </div>
            )}
            {!collapsed && (
                <ScrollDotsIndicator
                    count={dotCount}
                    activeIndex={activeIndex}
                    onSelect={scrollToIndex}
                    label="Trending events scroll position"
                />
            )}
        </section>
    );
}
