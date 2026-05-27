import { useMemo, useState } from 'react';
import type { CalendarEvent } from '../types';
import type { MapBounds } from './EventMap';
import { getTagColors } from '../utils/eventColor';

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
    className?: string;
}

function formatBannerDate(value: string): string {
    const date = new Date(value);
    return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function truncateText(value: string, maxLength = 20): string {
    if (value.length <= maxLength) return value;
    return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

function isOutsideMap(event: CalendarEvent, bounds: MapBounds | null): boolean {
    if (!bounds || event.latitude == null || event.longitude == null) return false;
    return event.latitude < bounds.south
        || event.latitude > bounds.north
        || event.longitude < bounds.west
        || event.longitude > bounds.east;
}

function StatIcon({ kind }: { kind: 'going' | 'saved' }) {
    if (kind === 'going') {
        return (
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.7} stroke="currentColor" className="h-3 w-3 text-blue-500" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M10.05 4.575a1.575 1.575 0 1 0-3.15 0v3m3.15-3v-1.5a1.575 1.575 0 0 1 3.15 0v1.5m-3.15 0 .075 5.925m3.075.75V4.575m0 0a1.575 1.575 0 0 1 3.15 0V15M6.9 7.575a1.575 1.575 0 1 0-3.15 0v8.175a6.75 6.75 0 0 0 6.75 6.75h2.018a5.25 5.25 0 0 0 3.712-1.538l1.732-1.732a5.25 5.25 0 0 0 1.538-3.712l.003-2.024a.668.668 0 0 1 .198-.471 1.575 1.575 0 1 0-2.228-2.228 3.818 3.818 0 0 0-1.12 2.687M6.9 7.575V12m6.27 4.318A4.49 4.49 0 0 1 16.35 15m0 0a4.49 4.49 0 0 1 .437-1.997" />
            </svg>
        );
    }
    return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3 w-3 text-slate-500" aria-hidden="true">
            <path d="M5 4a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v14l-5-2.5L5 18V4Z" />
        </svg>
    );
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
    className = '',
}: TrendingEventsBannerProps) {
    const [collapsed, setCollapsed] = useState(false);
    const trendingEvents = useMemo(() => {
        if (!showPopularity || events.length < 2) return [];
        const candidates = events
            .filter((event) => (event.popularity_score ?? 0) >= popularityThreshold)
            .sort((a, b) => (b.popularity_score ?? 0) - (a.popularity_score ?? 0));
        if (candidates.length < 2) return [];
        const effectiveCap = Math.max(
            1,
            Math.min(trendingTopN, Math.ceil((candidates.length * trendingTopPercent) / 100)),
        );
        if (effectiveCap < 1) return [];
        return candidates.slice(0, effectiveCap);
    }, [events, popularityThreshold, showPopularity, trendingTopN, trendingTopPercent]);

    if (trendingEvents.length === 0) return null;

    return (
        <section className={`border border-blue-100 bg-white shadow-sm ${className}`} data-testid="trending-events-banner">
            <button
                type="button"
                className="flex w-full items-center justify-between border-b border-blue-50 bg-blue-50 px-2.5 py-1 text-left text-xs font-semibold text-blue-700 hover:bg-blue-100 focus:outline-none focus:ring-2 focus:ring-blue-300"
                aria-expanded={!collapsed}
                onClick={() => setCollapsed((value) => !value)}
            >
                <span className="inline-flex items-center gap-1">
                    <img src="/trending.png" alt="" aria-hidden="true" className="h-3.5 w-3.5 object-contain" />
                    Trending
                </span>
                <span aria-hidden="true" className="text-xs text-slate-500">{collapsed ? '+' : '-'}</span>
            </button>
            {!collapsed && <div className="flex gap-1.5 overflow-x-auto px-2 py-1.5" aria-label="Trending events">
                {trendingEvents.map((event) => {
                    const startLabel = formatBannerDate(event.start);
                    const label = `Open ${event.title}, trending event on ${startLabel}`;
                    const title = truncateText(event.title);
                    const location = event.location ? truncateText(event.location) : null;
                    const colors = getTagColors(event).slice(0, 3);
                    const outsideMap = isOutsideMap(event, mapBounds);
                    const highlighted = hoveredEventId === event.event_id;
                    const goingCount = event.going_count ?? 0;
                    const savedCount = event.saved_count ?? 0;
                    return (
                        <button
                            key={event.event_id}
                            type="button"
                            aria-label={label}
                            onClick={() => onEventClick(event)}
                            onMouseEnter={() => onEventHover?.(event.event_id)}
                            onMouseLeave={() => onEventHover?.(null)}
                            onFocus={() => onEventHover?.(event.event_id)}
                            onBlur={() => onEventHover?.(null)}
                            className={`group flex min-h-[58px] w-[172px] shrink-0 border bg-white text-left shadow-sm transition hover:border-blue-200 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-300 ${highlighted ? 'border-blue-300 ring-1 ring-blue-200' : 'border-slate-200'}`}
                        >
                            <div className="flex w-1 shrink-0 overflow-hidden" aria-hidden="true">
                                {colors.length > 0
                                    ? colors.map((color, index) => (
                                        <span key={`${event.event_id}-${color}-${index}`} className="flex-1" style={{ backgroundColor: color }} />
                                    ))
                                    : <span className="w-full bg-slate-400" />}
                            </div>
                            <div className="min-w-0 flex-1 px-2 py-1.5">
                                <div className="flex items-start justify-between gap-2">
                                    <h3 className="truncate text-xs font-semibold leading-snug text-slate-900 group-hover:text-blue-700" title={event.title}>
                                        {title}
                                    </h3>
                                    {outsideMap && <span className="shrink-0 text-[10px] font-medium text-slate-400">Off map</span>}
                                </div>
                                <div className="mt-0.5 flex items-center justify-between gap-2 text-[11px]">
                                    <span className="min-w-0 truncate font-medium text-slate-600">{startLabel}</span>
                                    <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-slate-500">
                                        {goingCount > 0 && (
                                            <span className="inline-flex items-center gap-0.5" aria-label={`${goingCount} going`} title={`${goingCount} going`}>
                                                <StatIcon kind="going" />
                                                {goingCount}
                                            </span>
                                        )}
                                        {savedCount > 0 && (
                                            <span className="inline-flex items-center gap-0.5" aria-label={`${savedCount} saved`} title={`${savedCount} saved`}>
                                                <StatIcon kind="saved" />
                                                {savedCount}
                                            </span>
                                        )}
                                    </span>
                                </div>
                                {location && <p className="mt-0.5 truncate text-[11px] text-slate-400" title={event.location ?? undefined}>{location}</p>}
                            </div>
                        </button>
                    );
                })}
            </div>}
        </section>
    );
}
