import { useMemo, useState } from 'react';
import type { CalendarEvent } from '../types';
import type { MapBounds } from './EventMap';
import RailEventCard from './RailEventCard';
import { useFeatureFlags } from '../context/FeatureFlagsContext';

interface TrendingEventsBannerProps {
    events: CalendarEvent[];
    mapBounds: MapBounds | null;
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

function isOutsideMap(event: CalendarEvent, bounds: MapBounds | null): boolean {
    if (!bounds || event.latitude == null || event.longitude == null) return false;
    return event.latitude < bounds.south
        || event.latitude > bounds.north
        || event.longitude < bounds.west
        || event.longitude > bounds.east;
}

export default function TrendingEventsBanner({
    events,
    mapBounds,
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
    const { trendingTrailRichEnabled } = useFeatureFlags();
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

    if (trendingEvents.length === 0) return null;

    return (
        <section className={className} data-testid="trending-events-banner">
            <button
                type="button"
                className="flex w-full items-center justify-between border-b border-slate-300 px-2.5 py-1 text-left text-xs font-semibold text-slate-700 hover:text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-300"
                aria-expanded={!collapsed}
                onClick={() => setCollapsed((value) => !value)}
            >
                <span className="inline-flex items-center gap-1 text-slate-800">
                    Trending
                </span>
                <span aria-hidden="true" className="text-xs text-slate-400">{collapsed ? '+' : '-'}</span>
            </button>
            {!collapsed && (
                <div className="flex gap-2 overflow-x-auto px-2 py-2" aria-label="Trending events">
                    {trendingEvents.map((event) => {
                        const outsideMap = isOutsideMap(event, mapBounds);
                        return (
                            <RailEventCard
                                key={event.event_id}
                                event={event}
                                onClick={onEventClick}
                                onHover={onEventHover}
                                highlighted={hoveredEventId === event.event_id}
                                variant="compact"
                                compactShowExtras={trendingTrailRichEnabled}
                                followingBadgeEnabled={followingBadgeEnabled}
                                contextLabel="trending event"
                                extraBadge={undefined}
                            />
                        );
                    })}
                </div>
            )}
        </section>
    );
}
