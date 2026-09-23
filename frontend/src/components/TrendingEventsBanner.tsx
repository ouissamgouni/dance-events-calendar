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
        <>
            <button
                type="button"
                className="flex w-full items-center justify-between px-3 py-2 text-left text-base font-semibold text-ink hover:text-ink focus:outline-none focus:ring-2 focus:ring-rose-300"
                aria-expanded={!collapsed}
                onClick={() => setCollapsed((value) => !value)}
            >
                <span className="inline-flex items-center gap-2 text-ink">
                    <img src="/trending-0.png" alt="" aria-hidden="true" className="h-5 w-5 object-contain" />
                    Trending <span className="text-xs font-normal text-ink-soft">for this search</span>
                </span>
                <span aria-hidden="true" className="text-xs text-muted">{collapsed ? '+' : '-'}</span>
            </button>
            {!collapsed && (
                <section className={`mb-3 rounded-card border border-rose-100 bg-red-50 py-2 ${className}`} data-testid="trending-events-banner">
                    <div ref={scrollerRef} className="flex gap-2 overflow-x-auto scrollbar-hide px-3 py-2" aria-label="Trending events">
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
                    <ScrollDotsIndicator
                        count={dotCount}
                        activeIndex={activeIndex}
                        onSelect={scrollToIndex}
                        label="Trending events scroll position"
                    />
                </section>
            )}
        </>
    );
}
